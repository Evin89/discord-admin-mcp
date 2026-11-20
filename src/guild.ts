import { Discord, ToolError } from "./discord";
import { decodePermissions } from "./permissions";

export const channelTypes = { text: 0, announcement: 5, forum: 15, category: 4, voice: 2 };
export const requireTagFlag = 1 << 4;

interface Named { id: string; name: string }
interface Overwrite { id: string; type: number; allow: string; deny: string }
interface Tag extends Named {
  emoji_id?: string | null;
  emoji_name?: string | null;
  moderated?: boolean;
}
export interface Channel extends Named {
  type: number;
  position: number;
  parent_id?: string | null;
  topic?: string | null;
  flags?: number;
  available_tags?: Tag[];
  permission_overwrites?: Overwrite[];
}
export interface Role extends Named {
  color: number;
  colors?: { primary_color: number };
  position: number;
  managed: boolean;
  permissions: string;
}
export interface Webhook extends Named {
  channel_id: string | null;
  token?: string;
}

function resolve<T extends Named>(items: T[], ref: string, kind: string): T {
  const direct = items.find((item) => item.id === ref);
  if (direct) return direct;
  const matches = items.filter((item) => item.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new ToolError(`No matching ${kind} in this guild.`);
  throw new ToolError(`Ambiguous ${kind}. Use an ID: ${matches.map((item) => `${item.name} (${item.id})`).join(", ")}.`);
}

export class Guild extends Discord {
  private channelList?: Promise<Channel[]>;
  private roleList?: Promise<Role[]>;

  channels() {
    return this.channelList ??= this.request<Channel[]>(`${this.guild}/channels`);
  }

  roles() {
    return this.roleList ??= this.request<Role[]>(`${this.guild}/roles`);
  }

  async channel(ref: string) {
    return resolve(await this.channels(), ref, "channel");
  }

  async category(ref: string) {
    const channel = await this.channel(ref);
    if (channel.type !== channelTypes.category) throw new ToolError("Parent must be a category.");
    return channel;
  }

  async role(ref: string) {
    const id = ref.toLowerCase() === "@everyone" ? this.guild.slice("/guilds/".length) : ref;
    return resolve(await this.roles(), id, "role");
  }

  async overview() {
    const [guild, channels, roles] = await Promise.all([
      this.request<{ name: string; features: string[] }>(this.guild),
      this.channels(),
      this.roles(),
    ]);
    const members = new Map<string, string>();
    const memberIds = new Set(channels.flatMap((channel) => (channel.permission_overwrites ?? [])
      .filter((overwrite) => overwrite.type === 1).map((overwrite) => overwrite.id)));
    // Resolve only the members with overwrites; the list-members intent is unnecessary.
    for (const id of memberIds) {
      try {
        const member = await this.request<{ nick?: string; user: { username: string } }>(`${this.guild}/members/${id}`);
        members.set(id, member.nick ?? member.user.username);
      } catch (error) {
        if (!(error instanceof ToolError) || !error.message.includes("HTTP 404")) throw error;
      }
    }
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const sortedChannels = [...channels].sort((a, b) =>
      a.position - b.position || a.id.length - b.id.length || a.id.localeCompare(b.id));
    const orderedChannels = sortedChannels.filter((channel) => !channel.parent_id || !byId.has(channel.parent_id))
      .flatMap((channel) => channel.type === channelTypes.category
        ? [channel, ...sortedChannels.filter((child) => child.parent_id === channel.id)] : [channel]);
    return {
      name: guild.name,
      features: guild.features,
      channels: orderedChannels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: Object.entries(channelTypes).find(([, value]) => value === channel.type)?.[0] ?? channel.type,
        parent: byId.get(channel.parent_id ?? "")?.name ?? null,
        position: channel.position,
        topic: channel.topic ?? null,
        ...(channel.available_tags && { available_tags: channel.available_tags }),
        ...(channel.type === channelTypes.forum && { require_tag: Boolean((channel.flags ?? 0) & requireTagFlag) }),
        permission_overwrites: (channel.permission_overwrites ?? []).map(({ id, type, allow, deny }) => ({
          target: (type === 0 ? roleNames : members).get(id) ?? id,
          allow: decodePermissions(allow),
          deny: decodePermissions(deny),
        })),
      })),
      roles: [...roles].sort((a, b) => b.position - a.position || a.id.localeCompare(b.id)).map((role) => ({
        id: role.id,
        name: role.name,
        color: "#" + (role.colors?.primary_color ?? role.color).toString(16).padStart(6, "0"),
        position: role.position,
        managed: role.managed,
        permissions: decodePermissions(role.permissions),
      })),
    };
  }
}

export function emojiFields(emoji: string) {
  const custom = emoji.match(/^<(a?):\w+:(\d{1,20})>$/);
  if (custom) return { emoji_id: custom[2], emoji_name: null };
  if (/^\d{1,20}$/.test(emoji)) return { emoji_id: emoji, emoji_name: null };
  return { emoji_id: null, emoji_name: emoji };
}

export function formatTags(
  tags: { name: string; emoji?: string | null; moderated?: boolean }[],
  existing: Tag[] = [],
) {
  const used = new Set<string>();
  return tags.map(({ name, emoji, moderated }) => {
    const key = name.toLowerCase();
    if (used.has(key)) throw new ToolError("Forum tag names must be unique.");
    used.add(key);
    const matches = existing.filter((tag) => tag.name.toLowerCase() === key);
    const original = matches.find((tag) => tag.name === name) ?? matches[0];
    return {
      ...(original && { id: original.id }),
      name,
      moderated: moderated ?? original?.moderated ?? false,
      ...(emoji ? emojiFields(emoji) : {
        emoji_id: emoji === null ? null : original?.emoji_id ?? null,
        emoji_name: emoji === null ? null : original?.emoji_name ?? null,
      }),
    };
  });
}
