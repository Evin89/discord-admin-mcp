import { ToolError } from "./discord";

const names = [
  "CREATE_INSTANT_INVITE", "KICK_MEMBERS", "BAN_MEMBERS", "ADMINISTRATOR",
  "MANAGE_CHANNELS", "MANAGE_GUILD", "ADD_REACTIONS", "VIEW_AUDIT_LOG",
  "PRIORITY_SPEAKER", "STREAM", "VIEW_CHANNEL", "SEND_MESSAGES",
  "SEND_TTS_MESSAGES", "MANAGE_MESSAGES", "EMBED_LINKS", "ATTACH_FILES",
  "READ_MESSAGE_HISTORY", "MENTION_EVERYONE", "USE_EXTERNAL_EMOJIS", "VIEW_GUILD_INSIGHTS",
  "CONNECT", "SPEAK", "MUTE_MEMBERS", "DEAFEN_MEMBERS", "MOVE_MEMBERS", "USE_VAD",
  "CHANGE_NICKNAME", "MANAGE_NICKNAMES", "MANAGE_ROLES", "MANAGE_WEBHOOKS",
  "MANAGE_GUILD_EXPRESSIONS", "USE_APPLICATION_COMMANDS", "REQUEST_TO_SPEAK",
  "MANAGE_EVENTS", "MANAGE_THREADS", "CREATE_PUBLIC_THREADS", "CREATE_PRIVATE_THREADS",
  "USE_EXTERNAL_STICKERS", "SEND_MESSAGES_IN_THREADS", "USE_EMBEDDED_ACTIVITIES",
  "MODERATE_MEMBERS", "VIEW_CREATOR_MONETIZATION_ANALYTICS", "USE_SOUNDBOARD",
  "CREATE_GUILD_EXPRESSIONS", "CREATE_EVENTS", "USE_EXTERNAL_SOUNDS", "SEND_VOICE_MESSAGES",
  null, // Bit 47 is unassigned in the public permission table.
  "SET_VOICE_CHANNEL_STATUS", "SEND_POLLS", "USE_EXTERNAL_APPS", "PIN_MESSAGES", "BYPASS_SLOWMODE",
];

const flags = new Map<string, bigint>();
names.forEach((name, index) => {
  if (name) flags.set(name, 1n << BigInt(index));
});
export const permissionNames = [...flags.keys()];

export function encodePermissions(permissions: string[]): string {
  let result = 0n;
  for (const name of permissions) {
    const flag = flags.get(name);
    if (flag === undefined) throw new ToolError(`Unknown permission. Valid names: ${permissionNames.join(", ")}.`);
    result |= flag;
  }
  return String(result);
}

export function decodePermissions(bits: string): string[] {
  const value = BigInt(bits);
  return permissionNames.filter((name) => (value & flags.get(name)!) !== 0n);
}

export function overwriteBits(allow: string[], deny: string[]) {
  const result = { allow: encodePermissions(allow), deny: encodePermissions(deny) };
  if ((BigInt(result.allow) & BigInt(result.deny)) !== 0n) {
    throw new ToolError("A permission cannot be both allowed and denied.");
  }
  return result;
}
