import { z } from "zod";
import { ToolError } from "./discord";
import type { DiscordConfig } from "./discord";
import { channelTypes, emojiFields, formatTags, Guild, requireTagFlag } from "./guild";
import type { Channel, Role, Webhook } from "./guild";
import { encodePermissions, overwriteBits } from "./permissions";

const snowflake = z.string().regex(/^\d{1,20}$/);
const guildId = snowflake.describe("Discord guild ID configured for this server.");
const channelRef = z.string().min(1).describe("Channel ID or exact name, ignoring case. Use IDs for duplicate names.");
const roleRef = z.string().min(1).describe("Role ID or exact name, ignoring case. @everyone refers to the guild's default role.");
const emoji = z.string().min(1).max(100).describe("Unicode emoji, custom emoji ID, or Discord custom emoji markup.");
const name = z.string().min(1).max(100);
const topic = z.string().max(1024).describe("Channel topic or forum post guidelines.");
const position = z.number().int().nonnegative().describe("Channel sorting position.");
const permissions = z.array(z.string()).describe("Discord permission names such as VIEW_CHANNEL and SEND_MESSAGES.");
const tag = z.strictObject({
  name: z.string().min(1).max(20).describe("Forum tag name."),
  emoji: emoji.nullable().optional().describe("Tag emoji, or null to clear it."),
  moderated: z.boolean().optional().describe("Only moderators can apply this tag."),
});
const forum = {
  tags: z.array(tag).max(20).optional().describe("Complete forum tag set. During edit, same-name tags retain their IDs."),
  require_tag: z.boolean().optional().describe("Require a tag on new posts."),
  default_reaction_emoji: emoji.nullable().optional().describe("Default reaction emoji, or null to clear it."),
};
const roleFields = {
  name: name.describe("Display name of the role.").optional(),
  color: z.string().regex(/^#?[\da-fA-F]{6}$/).optional().describe("Six-digit hex role color, optionally prefixed with #."),
  hoist: z.boolean().optional().describe("Display this role separately in the member list."),
  mentionable: z.boolean().optional().describe("Allow members to mention the role."),
  permissions: permissions.optional().describe("Complete set of granted Discord permission names."),
};
const embed = z.strictObject({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  url: z.url({ protocol: /^https?$/ }).optional(),
  color: z.number().int().min(0).max(0xffffff).optional().describe("Embed color as an RGB integer."),
  timestamp: z.iso.datetime({ offset: true }).optional(),
  author: z.strictObject({ name, url: z.url({ protocol: /^https?$/ }).optional(), icon_url: z.string().optional() }).optional(),
  footer: z.strictObject({ text: z.string().min(1).max(2048), icon_url: z.string().optional() }).optional(),
  image: z.strictObject({ url: z.string().min(1) }).optional(),
  thumbnail: z.strictObject({ url: z.string().min(1) }).optional(),
  fields: z.array(z.strictObject({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().optional(),
  })).max(25).optional(),
});
const embeds = z.array(embed).max(10).optional().describe("Discord rich embeds. On edit, an empty array clears embeds.");
const messageId = snowflake.describe("Discord message ID.");
const option = z.strictObject({
  title: z.string().min(1).describe("Onboarding option title."),
  description: z.string().optional().describe("Onboarding option description."),
  emoji: emoji.optional(),
  roles: z.array(roleRef).optional().describe("Roles granted when this onboarding option is selected."),
  channels: z.array(channelRef).optional().describe("Channels surfaced when this onboarding option is selected."),
});
const prompt = z.strictObject({
  title: z.string().min(1).describe("Onboarding question displayed to members."),
  single_select: z.boolean().optional().describe("Permit only one option."),
  required: z.boolean().optional().describe("Require an answer to continue."),
  in_onboarding: z.boolean().optional().describe("Show during onboarding in addition to Channels & Roles."),
  type: z.enum(["multiple_choice", "dropdown"]).optional().describe("Prompt display style."),
  options: z.array(option).min(1).describe("Selectable onboarding options."),
});

function tool<S extends z.ZodType<{ guild_id: string }>>(
  description: string,
  inputSchema: S,
  execute: (guild: Guild, input: z.output<S>) => Promise<unknown>,
) {
  return {
    description, inputSchema,
    run(config: DiscordConfig, toolName: string, raw: unknown, fetcher?: typeof fetch) {
      const input = inputSchema.parse(raw);
      return execute(new Guild(input.guild_id, config, toolName, fetcher), input);
    },
  };
}
const guildOnly = z.strictObject({ guild_id: guildId });
const channelInput = { guild_id: guildId, channel: channelRef };
const overwriteInput = {
  target: roleRef,
  allow: permissions.describe("Explicitly allowed permissions."),
  deny: permissions.describe("Explicitly denied permissions. Unlisted permissions are neutral."),
};

function roleBody({ color, permissions: grants, ...fields }: z.infer<z.ZodObject<typeof roleFields>>) {
  return {
    ...fields,
    colors: color === undefined ? undefined : { primary_color: Number.parseInt(color.replace(/^#/, ""), 16) },
    permissions: grants === undefined ? undefined : encodePermissions(grants),
  };
}

function reaction(emojiValue: string | null | undefined) {
  return emojiValue ? emojiFields(emojiValue) : emojiValue;
}

function named({ id, name }: { id: string; name: string }) {
  return { id, name };
}

async function messagePath(guild: Guild, ref: string) {
  return `/channels/${(await guild.channel(ref)).id}/messages`;
}

export const tools = {
  get_guild_overview: tool("Inspect the guild, channels grouped by category, role hierarchy, and permission overwrites.",
    guildOnly, (guild) => guild.overview()),

  list_webhooks: tool("List guild webhook IDs, names, and channel names.",
    guildOnly, async (guild) => {
      const [webhooks, channels] = await Promise.all([
        guild.request<Webhook[]>(`${guild.guild}/webhooks`), guild.channels(),
      ]);
      return webhooks.map((webhook) => ({
        ...named(webhook),
        channel: channels.find((channel) => channel.id === webhook.channel_id)?.name ?? null,
      }));
    }),

  get_onboarding: tool("Read the guild's current onboarding configuration.", guildOnly,
    (guild) => guild.request(`${guild.guild}/onboarding`)),

  list_automod_rules: tool("List the guild's AutoMod rules.", guildOnly,
    (guild) => guild.request(`${guild.guild}/auto-moderation/rules`)),

  create_channel: tool("Create a guild channel, optionally with role overwrites and forum settings.",
    z.strictObject({
      guild_id: guildId, name: name.describe("New channel name."),
      type: z.enum(["text", "announcement", "forum", "category", "voice"]).describe("Discord channel type."),
      parent: channelRef.optional().describe("Parent category ID or exact name."),
      topic: topic.optional(), position: position.optional(),
      overwrites: z.array(z.strictObject(overwriteInput)).optional().describe("Initial role permission overwrites."),
      forum: z.strictObject(forum).optional().describe("Settings for forum channels only."),
    }), async (guild, input) => {
      const { name, type, parent, topic, position, overwrites, forum } = input;
      if (forum && type !== "forum") throw new ToolError("Forum settings require a forum channel.");
      if (parent && type === "category") throw new ToolError("Categories cannot have a parent.");
      const result = await guild.request<Channel>(`${guild.guild}/channels`, "POST", {
        name, type: channelTypes[type], topic, position,
        parent_id: parent === undefined ? undefined : (await guild.category(parent)).id,
        permission_overwrites: overwrites && await Promise.all(overwrites.map(async ({ target, allow, deny }) => ({
          id: (await guild.role(target)).id, type: 0, ...overwriteBits(allow, deny),
        }))),
        available_tags: forum?.tags && formatTags(forum.tags),
        flags: forum?.require_tag === undefined ? undefined : forum.require_tag ? requireTagFlag : 0,
        default_reaction_emoji: reaction(forum?.default_reaction_emoji),
      });
      return named(result);
    }),

  edit_channel: tool("Update channel settings. Use parent null to move out of a category.",
    z.strictObject({
      ...channelInput,
      changes: z.strictObject({
        name: name.optional().describe("New channel name."),
        topic: topic.nullable().optional(),
        parent: channelRef.nullable().optional().describe("New category ID or name, or null to remove the parent."),
        position: position.optional(),
        ...forum,
        rate_limit_per_user: z.number().int().min(0).max(21600).optional().describe("Slowmode seconds, or zero to disable."),
      }),
    }), async (guild, { channel, changes }) => {
      const current = await guild.channel(channel);
      const { parent, position, tags, require_tag, default_reaction_emoji, ...settings } = changes;
      if ((tags !== undefined || require_tag !== undefined || default_reaction_emoji !== undefined)
        && current.type !== channelTypes.forum) throw new ToolError("Forum settings require a forum channel.");
      if (parent !== undefined && current.type === channelTypes.category) {
        throw new ToolError("Categories cannot have a parent.");
      }
      const parentId = typeof parent === "string" ? (await guild.category(parent)).id : parent;
      const currentFlags = current.flags ?? 0;
      const patch = {
        ...settings,
        available_tags: tags && formatTags(tags, current.available_tags),
        flags: require_tag === undefined ? undefined
          : require_tag ? currentFlags | requireTagFlag : currentFlags & ~requireTagFlag,
        default_reaction_emoji: reaction(default_reaction_emoji),
      };
      let result = current;
      if (Object.values(patch).some((value) => value !== undefined)) {
        result = await guild.request<Channel>(`/channels/${current.id}`, "PATCH", patch);
      }
      if (position !== undefined || parentId !== undefined) {
        try {
          await guild.request(`${guild.guild}/channels`, "PATCH", [{ id: current.id, position, parent_id: parentId }]);
        } catch (error) {
          if (result === current || !(error instanceof ToolError)) throw error;
          throw new ToolError(`Channel settings were updated, but the move or position change failed. ${error.message}`);
        }
      }
      return named(result);
    }),

  set_permissions: tool("Replace one role's channel permission overwrite. Unlisted permissions become neutral.",
    z.strictObject({ ...channelInput, ...overwriteInput }),
    async (guild, { channel, target, allow, deny }) => {
      const bits = overwriteBits(allow, deny);
      const [current, role] = await Promise.all([guild.channel(channel), guild.role(target)]);
      await guild.request(`/channels/${current.id}/permissions/${role.id}`, "PUT", { type: 0, ...bits });
      return { channel_id: current.id, role_id: role.id };
    }),

  sync_permissions_with_category: tool("Replace channel overwrites with the parent category's current overwrites.",
    z.strictObject(channelInput), async (guild, { channel }) => {
      const current = await guild.channel(channel);
      if (!current.parent_id) throw new ToolError("Channel has no parent category.");
      const parent = await guild.category(current.parent_id);
      await guild.request(`/channels/${current.id}`, "PATCH", { permission_overwrites: parent.permission_overwrites ?? [] });
      return { channel_id: current.id, parent_id: parent.id };
    }),

  create_role: tool("Create a role with optional color, hoist, mentionability, and permissions.",
    z.strictObject({ guild_id: guildId, ...roleFields, name: name.describe("Name for the new role.") }),
    async (guild, { guild_id, ...fields }) => named(await guild.request<Role>(`${guild.guild}/roles`, "POST", roleBody(fields)))),

  edit_role: tool("Update the specified role. Provided permissions replace the complete set.",
    z.strictObject({ guild_id: guildId, role: roleRef, changes: z.strictObject(roleFields) }),
    async (guild, { role, changes }) => {
      const current = await guild.role(role);
      return named(await guild.request<Role>(`${guild.guild}/roles/${current.id}`, "PATCH", roleBody(changes)));
    }),

  delete_channel: tool("Permanently delete a channel after checking its exact current name.",
    z.strictObject({ ...channelInput, confirm_name: name.describe("Exact, case-sensitive current channel name.") }),
    async (guild, { channel, confirm_name }) => {
      const current = await guild.channel(channel);
      if (current.name !== confirm_name) throw new ToolError("confirm_name must exactly match the current channel name.");
      await guild.request(`/channels/${current.id}`, "DELETE");
      return { deleted: true, ...named(current) };
    }),

  set_onboarding: tool("Update onboarding. Provided prompts and default channels replace their respective lists.",
    z.strictObject({
      guild_id: guildId,
      enabled: z.boolean().describe("Whether to enable onboarding."),
      mode: z.enum(["default", "advanced"]).optional().describe("Default counts default channels only; advanced also counts prompts."),
      default_channels: z.array(channelRef).optional().describe("Channels opted into automatically."),
      prompts: z.array(prompt).optional().describe("Complete replacement list of onboarding prompts."),
    }), async (guild, { enabled, mode, default_channels, prompts }) => {
      const resolveChannels = (refs: string[]) => Promise.all(refs.map(async (ref) => (await guild.channel(ref)).id));
      return guild.request(`${guild.guild}/onboarding`, "PUT", {
        enabled,
        mode: mode === undefined ? undefined : Number(mode === "advanced"),
        default_channel_ids: default_channels && await resolveChannels(default_channels),
        prompts: prompts && await Promise.all(prompts.map(async ({ type, options, ...fields }) => ({
          id: "0",
          single_select: false, required: false, in_onboarding: true,
          ...fields,
          type: Number(type === "dropdown"),
          options: await Promise.all(options.map(async ({ roles, channels, emoji, ...optionFields }) => ({
            id: "0",
            ...optionFields,
            role_ids: await Promise.all((roles ?? []).map(async (ref) => (await guild.role(ref)).id)),
            channel_ids: await resolveChannels(channels ?? []),
            ...(emoji && { ...emojiFields(emoji), emoji_animated: emoji.startsWith("<a:") }),
          }))),
        }))),
      });
    }),

  create_automod_rule: tool("Create and enable a Discord AutoMod rule that blocks matching messages.",
    z.strictObject({
      guild_id: guildId,
      preset: z.enum(["spam", "mention_spam", "keyword_preset"]).describe("Spam filter, mention limit, or Discord's built-in keyword lists."),
      name: name.optional().describe("Custom rule name."),
      mention_limit: z.number().int().min(1).max(50).optional().describe("Maximum unique mentions, for mention_spam only. Defaults to 5."),
    }), async (guild, { preset, name, mention_limit }) => {
      if (mention_limit !== undefined && preset !== "mention_spam") {
        throw new ToolError("mention_limit is only valid for mention_spam.");
      }
      const presets = {
        spam: { name: "Block spam", trigger_type: 3 },
        mention_spam: { name: "Block mention spam", trigger_type: 5, trigger_metadata: { mention_total_limit: mention_limit ?? 5 } },
        keyword_preset: { name: "Block preset keywords", trigger_type: 4, trigger_metadata: { presets: [1, 2, 3] } },
      };
      return guild.request(`${guild.guild}/auto-moderation/rules`, "POST", {
        ...presets[preset], ...(name && { name }), event_type: 1, actions: [{ type: 1 }], enabled: true,
      });
    }),

  create_invite: tool("Create a channel invite and return its URL.",
    z.strictObject({
      ...channelInput,
      max_age: z.number().int().min(0).max(604800).default(0).describe("Seconds before expiration. Zero means never."),
      max_uses: z.number().int().min(0).max(100).default(0).describe("Maximum number of uses. Zero means unlimited."),
      unique: z.boolean().default(false).describe("Always create a fresh invite code."),
    }), async (guild, { channel, max_age, max_uses, unique }) => {
      const current = await guild.channel(channel);
      const invite = await guild.request<{ code: string }>(`/channels/${current.id}/invites`, "POST", { max_age, max_uses, unique });
      return { url: `https://discord.gg/${encodeURIComponent(invite.code)}` };
    }),

  send_message: tool("Send a message as the bot with mentions disabled.",
    z.strictObject({ ...channelInput, content: z.string().max(2000).describe("Message text. May be empty when embeds are included."), embeds }),
    async (guild, { channel, content, embeds }) => {
      if (!content && !embeds?.length) throw new ToolError("Provide content or at least one embed.");
      const message = await guild.request<{ id: string }>(await messagePath(guild, channel), "POST", {
        content, embeds, allowed_mentions: { parse: [] },
      });
      return { id: message.id };
    }),

  edit_message: tool("Edit a message authored by the bot with mentions disabled.",
    z.strictObject({
      ...channelInput, message_id: messageId,
      content: z.string().max(2000).optional().describe("Replacement message text. Omit to preserve existing text."),
      embeds,
    }), async (guild, { channel, message_id, content, embeds }) => {
      if (content === undefined && embeds === undefined) throw new ToolError("Provide content or embeds to update.");
      const message = await guild.request<{ id: string }>(`${await messagePath(guild, channel)}/${message_id}`, "PATCH", {
        content, embeds, allowed_mentions: { parse: [] },
      });
      return { id: message.id };
    }),

  pin_message: tool("Pin a message in the specified channel.",
    z.strictObject({ ...channelInput, message_id: messageId }), async (guild, { channel, message_id }) => {
      await guild.request(`${await messagePath(guild, channel)}/pins/${message_id}`, "PUT");
      return { id: message_id, pinned: true };
    }),

  create_webhook: tool("Create a channel webhook. Reveal its credential-bearing URL only on explicit request.",
    z.strictObject({
      ...channelInput, name: z.string().min(1).max(80).describe("Webhook name."),
      reveal_url: z.boolean().default(false).describe("Include a URL containing the webhook credential only if true."),
    }), async (guild, { channel, name, reveal_url }) => {
      const current = await guild.channel(channel);
      const webhook = await guild.request<Webhook>(`/channels/${current.id}/webhooks`, "POST", { name });
      return {
        ...named(webhook), channel: current.name,
        ...(reveal_url === true && webhook.token && {
          url: `https://discord.com/api/webhooks/${webhook.id}/${encodeURIComponent(webhook.token)}`,
        }),
      };
    }),
};
