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

  it("retains forum tag IDs by name, then requires a tag in a second request", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([forum]))
      .mockResolvedValueOnce(Response.json(forum)).mockResolvedValueOnce(Response.json(forum));
    await tools.edit_channel.run(config, "edit_channel", {
      ...channelInput, changes: { tags: [{ name: "events" }, { name: "New" }], require_tag: true },
    }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const tagPatch = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(tagPatch).not.toHaveProperty("flags");
    expect(tagPatch.available_tags[0]).toMatchObject({ name: "events", id: "20" });
    expect(tagPatch.available_tags[1]).toMatchObject({ name: "New" });
    expect(tagPatch.available_tags[1]).not.toHaveProperty("id");
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ flags: 48 });
  });

  it("sets require_tag alone in one request and preserves unrelated flags", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ ...forum, flags: 48 }])).mockResolvedValueOnce(Response.json(forum));
    await tools.edit_channel.run(config, "edit_channel", { ...channelInput, changes: { require_tag: false } }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ flags: 32 });
  });

  it("creates a forum with tags and requires a tag afterwards", async () => {
    const created = { id: "11", name: "ideas", type: 15, flags: 0 };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(created)).mockResolvedValueOnce(Response.json(created));
    await tools.create_channel.run(config, "create_channel", {
      guild_id, name: "ideas", type: "forum", forum: { tags: [{ name: "idea" }], require_tag: true },
    }, fetcher);
    const create = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(create).not.toHaveProperty("flags");
    expect(create.available_tags).toEqual([expect.objectContaining({ name: "idea" })]);
    expect(String(fetcher.mock.calls[1][0])).toMatch(/\/channels\/11$/);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ flags: 16 });
  });

  it("publishes only from announcement channels", async () => {
    const announcements = { id: "12", name: "announcements", type: 5 };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([announcements, forum]))
      .mockResolvedValueOnce(Response.json({ id: "99" }));
    await expect(tools.crosspost_message.run(config, "crosspost_message", {
      guild_id, channel: "announcements", message_id: "99",
    }, fetcher)).resolves.toEqual({ id: "99", published: true });
    expect(String(fetcher.mock.calls[1][0])).toMatch(/\/channels\/12\/messages\/99\/crosspost$/);
    expect(fetcher.mock.calls[1][1]?.method).toBe("POST");

    const refused = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([forum]));
    await expect(tools.crosspost_message.run(config, "crosspost_message", {
      ...channelInput, message_id: "99",
    }, refused)).rejects.toThrow(/announcement channel/);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("writes member overwrites with type 1 and requires a user ID", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([forum])).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(tools.set_permissions.run(config, "set_permissions", {
      ...channelInput, target: "270143095771889674", target_type: "member", allow: ["VIEW_CHANNEL"], deny: [],
    }, fetcher)).resolves.toEqual({ channel_id: forum.id, member_id: "270143095771889674" });
    expect(String(fetcher.mock.calls[1][0])).toMatch(/\/permissions\/270143095771889674$/);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ type: 1, allow: "1024", deny: "0" });

    const refused = vi.fn<typeof fetch>();
    await expect(tools.set_permissions.run(config, "set_permissions", {
      ...channelInput, target: "MM-Bot", target_type: "member", allow: [], deny: [],
    }, refused)).rejects.toThrow(/user ID/);
    expect(refused).not.toHaveBeenCalled();
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
