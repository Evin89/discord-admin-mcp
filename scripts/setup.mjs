#!/usr/bin/env node
// Interactive first-time setup for discord-admin-mcp.
// Asks for your Discord app credentials, creates the KV namespace, writes wrangler.toml,
// deploys the Worker, stores the secrets in Cloudflare, and prints the links you still need.
// Secrets are typed into this terminal only: they go straight to `wrangler secret bulk`
// and are never written to the repo.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const templatePath = join(root, "wrangler.example.toml");
const configPath = join(root, "wrangler.toml");
const discordApi = "https://discord.com/api/v10";
// CREATE_INSTANT_INVITE, MANAGE_CHANNELS, MANAGE_GUILD, VIEW_CHANNEL, SEND_MESSAGES, MANAGE_MESSAGES,
// EMBED_LINKS, READ_MESSAGE_HISTORY, MANAGE_ROLES, MANAGE_WEBHOOKS, PIN_MESSAGES
const BOT_PERMISSIONS = "2251800619084849";

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const fail = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

// ---------- prompts ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let muted = false;
// While muted (secret input), echo nothing but the final newline.
rl._writeToOutput = function (s) { if (!muted) rl.output.write(s); else if (s.includes("\n")) rl.output.write("\n"); };
// Queue lines so nothing is lost when input is pasted or piped faster than we ask.
const pending = [];
let waiter = null;
let closed = false;
rl.on("line", (line) => { if (waiter) { const w = waiter; waiter = null; w(line); } else pending.push(line); });
rl.on("close", () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
const nextLine = () => (pending.length ? Promise.resolve(pending.shift())
  : closed ? Promise.resolve(null) : new Promise((resolve) => { waiter = resolve; }));

async function ask(question, { fallback = "", validate, secret = false } = {}) {
  const suffix = fallback ? dim(` [${fallback}]`) : "";
  for (;;) {
    process.stdout.write(`${question}${suffix}: `);
    muted = secret;
    const line = await nextLine();
    muted = false;
    if (line === null) fail("Input ended before setup was complete.");
    if (!process.stdin.isTTY) process.stdout.write("\n");
    const value = line.trim() || fallback;
    const error = validate ? validate(value) : (value ? null : "Required.");
    if (!error) return value;
    console.log(`  ${error}`);
  }
}
const confirm = async (q, def = true) =>
  /^y/i.test(await ask(`${q} (y/n)`, { fallback: def ? "y" : "n", validate: (v) => (/^[yn]/i.test(v) ? null : "Answer y or n.") }));

const idList = (v) => (/^\d{17,20}(\s*,\s*\d{17,20})*$/.test(v) ? null : "Enter one or more numeric Discord IDs, comma-separated.");
const workerName = (v) => (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v) ? null : "Lowercase letters, digits and dashes only.");
const httpsUrl = (v) => (!v || /^https:\/\/[^\s/]+$/.test(v) ? null : "Enter an origin like https://mcp.example.com (no path), or leave empty.");
const tidy = (v) => v.split(",").map((s) => s.trim()).join(",");

// ---------- wrangler ----------
function wrangler(args, { capture = false, input } = {}) {
  const r = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: root, encoding: "utf8", input,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  if (r.error) fail(`Could not run wrangler: ${r.error.message}`);
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function ensureKv(title) {
  const list = wrangler(["kv", "namespace", "list"], { capture: true });
  if (list.ok) {
    try {
      const json = JSON.parse(list.out.slice(list.out.indexOf("[")));
      const found = json.find((ns) => ns.title === title);
      if (found) { console.log(`  Reusing KV namespace "${title}".`); return found.id; }
    } catch { /* fall through and create */ }
  }
  const created = wrangler(["kv", "namespace", "create", title], { capture: true });
  const id = created.out.match(/\bid\s*[:=]\s*"([0-9a-f]{32})"/i)?.[1];
  if (!created.ok || !id) fail(`Creating the KV namespace failed:\n${created.out}`);
  console.log(`  Created KV namespace "${title}".`);
  return id;
}

function writeConfig(values) {
  let toml = readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(values)) toml = toml.replaceAll(`__${key}__`, value);
  writeFileSync(configPath, toml);
}

function deploy() {
  const r = wrangler(["deploy"], { capture: true });
  process.stdout.write(dim(r.out.split("\n").filter((l) => /workers\.dev|Deployed|Uploaded|Current Version/i.test(l)).join("\n") + "\n"));
  if (!r.ok) fail(`Deploy failed:\n${r.out}`);
  return r.out.match(/https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev/i)?.[0];
}

function putSecrets(secrets) {
  // Temp file with owner-only permissions, removed straight after.
  const dir = mkdtempSync(join(tmpdir(), "discord-mcp-"));
  const file = join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const r = wrangler(["secret", "bulk", file], { capture: true });
    if (!r.ok) fail(`Storing secrets failed:\n${r.out.replace(/"[^"]{20,}"/g, '"***"')}`);
  } finally {
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
  }
}

async function discordCheck(botToken, guildIds) {
  try {
    const me = await fetch(`${discordApi}/users/@me`, { headers: { Authorization: `Bot ${botToken}` } });
    if (!me.ok) return console.log(`  ⚠ Discord rejected the bot token (HTTP ${me.status}). Check it in the Developer Portal → Bot.`);
    const { username } = await me.json();
    console.log(`  Bot token OK (${username}).`);
    const missing = [];
    for (const id of guildIds) {
      const g = await fetch(`${discordApi}/guilds/${id}`, { headers: { Authorization: `Bot ${botToken}` } });
      if (g.ok) console.log(`  Bot is in server ${(await g.json()).name} (${id}).`);
      else missing.push(id);
    }
    return missing;
  } catch {
    console.log("  ⚠ Could not reach Discord to verify the token; continuing.");
    return [];
  }
}

// ---------- main ----------
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) fail("Node.js 20 or newer is required.");
  if (!existsSync(wranglerBin)) fail("Dependencies are missing. Run `npm install` first.");

  console.log(bold("\ndiscord-admin-mcp setup\n"));
  console.log(`Before you start, in the Discord Developer Portal (https://discord.com/developers/applications):
  1. New Application → give it a name.
  2. ${bold("Bot")} tab → Reset Token → copy it. No privileged intents are needed.
  3. ${bold("OAuth2")} tab → copy the Client ID and Client Secret.
You'll add the redirect URL and invite the bot at the end; this script prints both.\n`);

  // Cloudflare login
  const who = wrangler(["whoami"], { capture: true });
  if (!who.ok || /not authenticated|You are not logged in/i.test(who.out)) {
    console.log("Logging in to Cloudflare (a browser window opens)…");
    if (!wrangler(["login"]).ok) fail("Cloudflare login failed.");
  } else {
    console.log(dim("Cloudflare: already logged in.\n"));
  }

  if (existsSync(configPath) && !(await confirm("wrangler.toml already exists. Overwrite it?", false))) {
    fail("Stopped. Remove or rename wrangler.toml to run setup again.");
  }

  const name = await ask("Worker name", { fallback: "discord-admin-mcp", validate: workerName });
  const guildIds = tidy(await ask("Discord server (guild) ID(s) the connector may manage", { validate: idList }));
  const userIds = tidy(await ask("Your Discord user ID(s) allowed to sign in", { validate: idList }));
  console.log(dim("  (Discord: User Settings → Advanced → Developer Mode on; right-click a server or your profile → Copy ID.)"));
  const clientId = await ask("Discord application Client ID", { validate: (v) => idList(v) && "Enter the numeric Client ID." });
  const clientSecret = await ask("Discord Client Secret (hidden)", { secret: true });
  const botToken = await ask("Discord Bot Token (hidden)", { secret: true });
  const customOrigin = await ask("Custom domain for the Worker (leave empty to use workers.dev)", { fallback: "", validate: httpsUrl });
  rl.close();

  console.log(bold("\nChecking Discord…"));
  const notInGuild = await discordCheck(botToken, guildIds.split(","));

  console.log(bold("\nCloudflare…"));
  const kvId = ensureKv(`${name}-oauth-kv`);
  const base = { WORKER_NAME: name, KV_ID: kvId, GUILD_IDS: guildIds, USER_IDS: userIds };

  writeConfig({ ...base, MCP_RESOURCE: customOrigin ? `${customOrigin}/mcp` : "http://localhost:8788/mcp" });
  console.log("  Deploying…");
  const workersDev = deploy();
  const origin = customOrigin || workersDev;
  if (!origin) fail("Deployed, but could not find the Worker URL in wrangler's output. Set MCP_RESOURCE in wrangler.toml by hand and run `npm run deploy`.");
  if (!customOrigin) {
    writeConfig({ ...base, MCP_RESOURCE: `${origin}/mcp` });
    console.log("  Redeploying with the public URL…");
    deploy();
  }

  console.log("  Storing secrets…");
  putSecrets({
    DISCORD_BOT_TOKEN: botToken,
    DISCORD_CLIENT_ID: clientId,
    DISCORD_CLIENT_SECRET: clientSecret,
    COOKIE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  });

  const firstGuild = (notInGuild?.length ? notInGuild : guildIds.split(","))[0];
  const invite = `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${BOT_PERMISSIONS}&guild_id=${firstGuild}&disable_guild_select=true`;

  console.log(bold("\n✔ Deployed. Three things left to do:\n"));
  console.log(`1. Discord Developer Portal → your app → ${bold("OAuth2 → Redirects")} → add:\n     ${origin}/callback\n`);
  console.log(`2. ${notInGuild?.length ? bold("Invite the bot") + " (it is not in your server yet)" : "Bot invite link (only if you need it again)"}:\n     ${invite}`);
  console.log(`   Then Server Settings → Roles: drag the bot's role ${bold("above")} every role it should be able to edit.\n`);
  console.log(`3. Claude → Settings → Connectors → ${bold("Add custom connector")} → URL:\n     ${origin}/mcp\n   Approve, then sign in with Discord.\n`);
  console.log(dim("Re-run `npm run setup` to change values; secrets can also be rotated with `npx wrangler secret put <NAME>`."));
}

main().catch((e) => fail(e?.message ?? String(e)));
