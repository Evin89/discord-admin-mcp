import { OAuthAuthorizationServer, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { ToolError } from "./discord";
import type { DiscordConfig } from "./discord";
import { isAllowedDiscordUser, login } from "./oauth";
import type { LoginEnv } from "./oauth";
import { tools } from "./tools";

interface Env extends Cloudflare.Env, DiscordConfig, LoginEnv {
  MCP_OBJECT: DurableObjectNamespace;
}

type Props = { discordUserId: string };

export class DiscordMcp extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "discord-admin-mcp", version: "1.0.0" });

  async init() {
    for (const [name, tool] of Object.entries(tools)) {
      this.server.registerTool(name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
      }, async (input: unknown) => {
        try {
          if (!isAllowedDiscordUser(this.props?.discordUserId, this.env)) {
            throw new ToolError("This Discord account is not authorized.");
          }
          const result = await tool.run(this.env, name, input);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: error instanceof ToolError ? error.message : "Discord tool failed." }],
          };
        }
      });
    }
  }
}

const streamable = DiscordMcp.serve("/mcp", { binding: "MCP_OBJECT" });
const sse = DiscordMcp.serveSSE("/sse", { binding: "MCP_OBJECT" });

function createRouter(resource: string) {
  const issuer = new URL(resource).origin;
  const sseResource = new URL("/sse", issuer).href;
  const authorization = new OAuthAuthorizationServer<Env>({
    issuer,
    resources: [resource, sseResource],
    defaultResource: resource,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    onError: () => {},
  });
  const protect = (url: string, handler: typeof streamable) => new OAuthResourceServer<Env, Props>({
    resourceMetadata: { resource: url, authorization_servers: [issuer] },
    validateToken: (bindings) => async (audience, token) => {
      const validated = await authorization.validateToken<Props>(audience, token, bindings);
      return isAllowedDiscordUser(validated?.props?.discordUserId, bindings) ? validated : null;
    },
    handler: {
      fetch(request, bindings, ctx) {
        const headers = new Headers(request.headers);
        headers.delete("Authorization");
        return handler.fetch(new Request(request, { headers }), bindings, ctx);
      },
    },
  });
  const streamResource = protect(resource, streamable);
  const legacyResource = protect(sseResource, sse);
  return (request: Request, bindings: Env, ctx: ExecutionContext) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize" || pathname === "/callback") {
      return login.fetch(request, { ...bindings, OAUTH_PROVIDER: authorization.getOAuthApi(bindings) });
    }
    if (pathname === "/sse" || pathname.startsWith("/sse/") || pathname === "/.well-known/oauth-protected-resource/sse") {
      return legacyResource.fetch(request, bindings, ctx);
    }
    if (pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname === "/.well-known/oauth-protected-resource/mcp") {
      return streamResource.fetch(request, bindings, ctx);
    }
    return authorization.fetch(request, bindings, ctx);
  };
}

export default {
  fetch(request, bindings, ctx) {
    return createRouter(bindings.MCP_RESOURCE)(request, bindings, ctx);
  },
} satisfies ExportedHandler<Env>;
