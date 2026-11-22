import { describe, expect, it, vi } from "vitest";
import { Discord } from "../src/discord";
import { decodePermissions, encodePermissions, permissionNames } from "../src/permissions";
import { tools } from "../src/tools";

const guild_id = "1573273187393863851";
const config = { ALLOWED_GUILD_IDS: guild_id, DISCORD_BOT_TOKEN: "mock-bot-token" };
const forum = { id: "10", name: "News", type: 15, flags: 32, available_tags: [{ id: "20", name: "Events" }] };
const channelInput = { guild_id, channel: "news" };
const webhook = { id: "30", name: "Updates", channel_id: forum.id, token: "mock-webhook-token", url: "unexpected-url" };

describe("Discord permissions", () => {
  it("round-trips all known permissions and uses bits above 32", () => {
    expect(decodePermissions(encodePermissions(permissionNames))).toEqual(permissionNames);
    expect(encodePermissions(["VIEW_CHANNEL", "PIN_MESSAGES"])).toBe(String((1n << 10n) | (1n << 51n)));
  });

  it("lists valid names for unknown permissions", () => {
    expect(() => encodePermissions(["NOT_A_PERMISSION"])).toThrow(/Valid names:.*VIEW_CHANNEL/);
  });
});

describe("Discord tools", () => {
  it("rejects a guild before making any HTTP request", () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => tools.get_guild_overview.run(config, "get_guild_overview", { guild_id: "123" }, fetcher))
      .toThrow(/outside ALLOWED_GUILD_IDS/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires case-sensitive confirmation before deleting a channel", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([forum]));
    await expect(tools.delete_channel.run(config, "delete_channel", { ...channelInput, confirm_name: "news" }, fetcher))
      .rejects.toThrow(/confirm_name/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  });

  it("projects webhook list results down to safe fields", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([webhook])).mockResolvedValueOnce(Response.json([forum]));
    await expect(tools.list_webhooks.run(config, "list_webhooks", { guild_id }, fetcher))
      .resolves.toEqual([{ id: webhook.id, name: webhook.name, channel: forum.name }]);
  });

  it.each([undefined, false, true])("reveals a webhook URL only when requested (%s)", async (reveal_url) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([forum])).mockResolvedValueOnce(Response.json(webhook));
    await expect(tools.create_webhook.run(config, "create_webhook", {
      ...channelInput, name: webhook.name, reveal_url,
    }, fetcher)).resolves.toEqual({
      id: webhook.id, name: webhook.name, channel: forum.name,
      ...(reveal_url && { url: "https://discord.com/api/webhooks/30/mock-webhook-token" }),
    });
  });

  it("retains forum tag IDs by name and preserves unrelated flags", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([forum])).mockResolvedValueOnce(Response.json(forum));
    await tools.edit_channel.run(config, "edit_channel", {
      ...channelInput, changes: { tags: [{ name: "events" }, { name: "New" }], require_tag: true },
    }, fetcher);
    const patch = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(patch.flags).toBe(48);
    expect(patch.available_tags[0]).toMatchObject({ name: "events", id: "20" });
    expect(patch.available_tags[1]).toMatchObject({ name: "New" });
    expect(patch.available_tags[1]).not.toHaveProperty("id");
  });

  it("retries a rate-limited mutation exactly once and audits both requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ retry_after: 0 }, { status: 429 }));
    const discord = new Discord(guild_id, config, "edit_role", fetcher);
    await expect(discord.request("/resource", "PATCH", { name: "New" })).rejects.toThrow(/after one retry/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, request] of fetcher.mock.calls) {
      expect(new Headers(request?.headers).get("X-Audit-Log-Reason")).toBe("Claude%20MCP%20%28edit_role%29");
    }
  });
});

describe("default fetcher", () => {
  it("never calls fetch with the Discord instance as `this` (Workers: Illegal invocation)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("{}", { status: 200 }));
    } as typeof fetch;
    try {
      const discord = new Discord("1573273187393863851", { ALLOWED_GUILD_IDS: "1573273187393863851", DISCORD_BOT_TOKEN: "x" }, "test");
      await expect(discord.request("/guilds/1573273187393863851")).resolves.toEqual({});
    } finally {
      globalThis.fetch = original;
    }
  });
});
