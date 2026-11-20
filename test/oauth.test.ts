import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedDiscordUser, login, sameOriginPost } from "../src/oauth";

afterEach(() => vi.unstubAllGlobals());

it("allows only exact Discord IDs, ignoring whitespace around entries", () => {
  const env = { ALLOWED_DISCORD_USER_IDS: "123, 456 " };
  expect(isAllowedDiscordUser("456", env)).toBe(true);
  expect(isAllowedDiscordUser("45", env)).toBe(false);
  expect(isAllowedDiscordUser(456, env)).toBe(false);
});

it("returns 403 after Discord login for an unlisted account and never completes MCP authorization", async () => {
  const values = new Map<string, string>();
  const completeAuthorization = vi.fn();
  const env = {
    MCP_RESOURCE: "http://localhost:8788/mcp",
    ALLOWED_DISCORD_USER_IDS: "123",
    DISCORD_CLIENT_ID: "mock-client",
    DISCORD_CLIENT_SECRET: "mock-secret",
    COOKIE_ENCRYPTION_KEY: "mock-key-for-tests-only-with-at-least-32-characters",
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({ clientId: "mcp-client", redirectUri: "https://client.example/callback", scope: [] }),
      lookupClient: async () => ({ clientName: "<example>" }),
      completeAuthorization,
    },
    OAUTH_KV: {
      put: async (key: string, value: string) => { values.set(key, value); },
      get: async (key: string) => JSON.parse(values.get(key) ?? "null"),
      delete: async (key: string) => { values.delete(key); },
    },
  } as unknown as Parameters<typeof login.fetch>[1];
  const upstream = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "mock-discord-access-token" }))
    .mockResolvedValueOnce(Response.json({ id: "789" }));
  vi.stubGlobal("fetch", upstream);

  const origin = "http://localhost:8788";
  const consent = await login.fetch(new Request(origin + "/authorize"), env);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("&lt;example&gt;");
  const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
  expect(nonce).toBeTruthy();

  const discord = await login.fetch(new Request(origin + "/authorize", {
    method: "POST",
    headers: { Origin: origin, Cookie: consent.headers.get("Set-Cookie")!.split(";")[0] },
    body: new URLSearchParams({ nonce: nonce! }),
  }), env);
  expect(discord.status).toBe(302);
  const state = new URL(discord.headers.get("Location")!).searchParams.get("state");
  const callback = await login.fetch(new Request(origin + "/callback?code=test&state=" + state, {
    headers: { Cookie: discord.headers.get("Set-Cookie")!.split(";")[0] },
  }), env);
  expect(callback.status).toBe(403);
  expect(callback.headers.has("Location")).toBe(false);
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(completeAuthorization).not.toHaveBeenCalled();
});

describe("sameOriginPost", () => {
  const url = new URL("https://mcp.example.workers.dev/authorize");
  const post = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });
  it("accepts a matching Origin", () => {
    expect(sameOriginPost(post({ Origin: "https://mcp.example.workers.dev" }), url)).toBe(true);
  });
  it("rejects a foreign Origin even with same-origin fetch metadata", () => {
    expect(sameOriginPost(post({ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }), url)).toBe(false);
  });
  it("accepts Origin: null from a same-origin form post (strict referrer policy)", () => {
    expect(sameOriginPost(post({ Origin: "null", "Sec-Fetch-Site": "same-origin" }), url)).toBe(true);
  });
  it("rejects Origin: null from a cross-site post", () => {
    expect(sameOriginPost(post({ Origin: "null", "Sec-Fetch-Site": "cross-site" }), url)).toBe(false);
  });
  it("rejects a post with neither header", () => {
    expect(sameOriginPost(post({}), url)).toBe(false);
  });
});
