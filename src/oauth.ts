import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { allowed } from "./discord";

export interface LoginEnv {
  OAUTH_KV: KVNamespace;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  ALLOWED_DISCORD_USER_IDS: string;
  MCP_RESOURCE: string;
}

type LoginBindings = LoginEnv & { OAUTH_PROVIDER: OAuthHelpers };
interface Flow { stage: "consent" | "discord"; request: AuthRequest }
const lifetime = 600;
const encoder = new TextEncoder();
const discordApi = "https://discord.com/api/v10";

function cookieName(url: URL) {
  return url.protocol === "https:" ? "__Host-mcp-discord-flow" : "mcp-discord-flow";
}

function cookie(url: URL, value: string, age: number) {
  return `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`
    + (url.protocol === "https:" ? "; Secure" : "");
}

async function signingKey(secret: string) {
  if (!secret || secret.length < 32 || secret.startsWith("REPLACE_WITH_")) throw new Error("Missing cookie key.");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function response(body: string | null, status: number, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  } });
}

async function startFlow(url: URL, env: LoginEnv, flow: Flow) {
  const nonce = crypto.randomUUID();
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env.COOKIE_ENCRYPTION_KEY), encoder.encode(nonce));
  await env.OAUTH_KV.put(`discord-flow:${nonce}`, JSON.stringify(flow), { expirationTtl: lifetime });
  return { nonce, cookie: cookie(url, `${nonce}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`, lifetime) };
}

async function consumeFlow(request: Request, url: URL, env: LoginEnv, nonce: string, stage: Flow["stage"]) {
  const prefix = cookieName(url) + "=";
  const value = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
  const match = value?.match(/^([\da-f-]{36})\.([A-Za-z0-9+/]{43}=)$/);
  if (!match || match[1] !== nonce) return null;
  const authentic = await crypto.subtle.verify("HMAC", await signingKey(env.COOKIE_ENCRYPTION_KEY),
    Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0)), encoder.encode(nonce));
  if (!authentic) return null;
  const key = `discord-flow:${nonce}`;
  const flow = await env.OAUTH_KV.get<Flow>(key, "json");
  if (flow?.stage !== stage) return null;
  await env.OAUTH_KV.delete(key);
  return flow.request;
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

// Browsers send `Origin: null` on form posts from pages with a strict referrer policy,
// so fall back to Fetch Metadata. The signed, single-use flow cookie is the real CSRF guard.
export function sameOriginPost(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin && origin !== "null") return origin === url.origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

export function isAllowedDiscordUser(id: unknown, env: Pick<LoginEnv, "ALLOWED_DISCORD_USER_IDS">): id is string {
  return allowed(id, env.ALLOWED_DISCORD_USER_IDS);
}

export const login = {
  async fetch(request: Request, env: LoginBindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.MCP_RESOURCE).origin) return response("Invalid origin.", 400);
    const helper = env.OAUTH_PROVIDER;
    const callback = new URL("/callback", url).href;
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        const oauthRequest = await helper.parseAuthRequest(request).catch(() => null);
        if (!oauthRequest) return response("Invalid authorization request.", 400);
        const client = await helper.lookupClient(oauthRequest.clientId);
        if (!client) return response("Unknown MCP client.", 400);
        const flow = await startFlow(url, env, { stage: "consent", request: oauthRequest });
        return response(`<!doctype html><html lang="en"><meta charset="utf-8">
          <title>Connect Discord administration</title><main>
          <h1>Connect Discord administration</h1>
          <p>Allow <strong>${escapeHtml(client.clientName || oauthRequest.clientId)}</strong>
          to administer the configured Discord guild using this Worker.</p>
          <p>Client redirect: <code>${escapeHtml(oauthRequest.redirectUri)}</code></p>
          <form method="post" action="/authorize">
            <input type="hidden" name="nonce" value="${flow.nonce}">
            <button type="submit">Approve and sign in with Discord</button>
          </form></main></html>`, 200, {
          "Content-Type": "text/html; charset=UTF-8",
          "Content-Security-Policy": "default-src 'none'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
          "Referrer-Policy": "same-origin",
          "Set-Cookie": flow.cookie,
        });
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        if (!sameOriginPost(request, url)) return response("Invalid consent origin.", 403);
        const form = await request.formData();
        const authorization = await consumeFlow(request, url, env, String(form.get("nonce")), "consent");
        if (!authorization) return response("Consent expired or invalid. Restart authorization.", 400);
        const flow = await startFlow(url, env, { stage: "discord", request: authorization });
        const target = new URL("https://discord.com/oauth2/authorize");
        target.search = new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID, redirect_uri: callback,
          response_type: "code", scope: "identify", state: flow.nonce,
        }).toString();
        return response(null, 302, { Location: target.href, "Set-Cookie": flow.cookie });
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        const authorization = await consumeFlow(request, url, env, url.searchParams.get("state") ?? "", "discord");
        const clear = { "Set-Cookie": cookie(url, "", 0) };
        const code = url.searchParams.get("code");
        if (!authorization || !code) return response("Discord authorization expired or was declined.", 400, clear);

        const tokenResponse = await fetch(`${discordApi}/oauth2/token`, {
          method: "POST",
          redirect: "manual",
          body: new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
            code, redirect_uri: callback, grant_type: "authorization_code",
          }),
        });
        if (!tokenResponse.ok) return response("Discord sign-in failed.", 502, clear);
        const { access_token } = await tokenResponse.json() as { access_token?: string };
        if (!access_token) return response("Discord sign-in failed.", 502, clear);
        const identity = await fetch(`${discordApi}/users/@me`, {
          headers: { Authorization: `Bearer ${access_token}` }, redirect: "manual",
        });
        if (!identity.ok) return response("Discord identity lookup failed.", 502, clear);
        const { id } = await identity.json() as { id?: unknown };
        if (!isAllowedDiscordUser(id, env)) return response("This Discord account is not authorized.", 403, clear);
        const { redirectTo } = await helper.completeAuthorization({
          request: authorization, userId: id, scope: authorization.scope,
          props: { discordUserId: id }, metadata: { label: "Discord administration" },
        });
        return response(null, 302, { ...clear, Location: redirectTo });
      }
      return response("Not found.", 404);
    } catch (error) {
      // Log the failure (never secrets) so `wrangler tail` shows why authorization failed.
      console.error("authorize/callback failed:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return response("Authorization could not be completed.", 500);
    }
  },
};
