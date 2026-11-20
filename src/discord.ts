export interface DiscordConfig {
  ALLOWED_GUILD_IDS: string;
  DISCORD_BOT_TOKEN: string;
}

export function allowed(id: unknown, list: string): id is string {
  return typeof id === "string" && /^\d{1,20}$/.test(id)
    && list.split(",").some((entry) => entry.trim() === id);
}

export class ToolError extends Error {}

export class Discord {
  readonly guild: string;

  constructor(
    guildId: string,
    private readonly config: DiscordConfig,
    private readonly tool: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!allowed(guildId, config.ALLOWED_GUILD_IDS)) {
      throw new ToolError("Guild ID is outside ALLOWED_GUILD_IDS.");
    }
    this.guild = `/guilds/${guildId}`;
  }

  async request<T = void>(
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
    body?: object,
  ): Promise<T> {
    const headers = new Headers({ Authorization: `Bot ${this.config.DISCORD_BOT_TOKEN}` });
    if (method !== "GET") {
      headers.set("X-Audit-Log-Reason", `Claude%20MCP%20%28${encodeURIComponent(this.tool)}%29`);
    }
    if (body) headers.set("Content-Type", "application/json");
    const send = () => this.fetcher(`https://discord.com/api/v10${path}`, {
      method, headers, body: body && JSON.stringify(body), redirect: "error",
    });
    let response: Response;
    try {
      response = await send();
      if (response.status === 429) {
        const { retry_after } = await response.json() as { retry_after?: number };
        if (typeof retry_after !== "number" || !Number.isFinite(retry_after) || retry_after < 0) {
          throw new ToolError("Discord rate limit response has no valid retry_after.");
        }
        await new Promise((resolve) => setTimeout(resolve, retry_after * 1000));
        response = await send();
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("Discord request failed.");
    }
    if (response.status === 429) throw new ToolError("Discord rate limit persisted after one retry.");
    if (!response.ok) {
      const details = await response.json().catch(() => null) as { code?: unknown } | null;
      const code = typeof details?.code === "number" ? `, code ${details.code}` : "";
      throw new ToolError(`Discord rejected the request (HTTP ${response.status}${code}).`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
}
