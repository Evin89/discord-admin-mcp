# discord-admin-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client that supports remote servers with OAuth) **administer a Discord server**: channels and categories, roles, permission overwrites, forum tags, onboarding, AutoMod, invites, messages and webhooks.

It runs on your own Cloudflare account as a Worker and talks to Discord through your own bot. Nothing is hosted by anyone else.

- **Locked to you.** Sign-in goes through Discord OAuth; only the Discord user IDs you configure get a token. Every tool call is checked again.
- **Locked to your server(s).** Tools refuse any guild ID that isn't on your allowlist.
- **Secrets stay in Cloudflare.** The bot token never appears in tool output or logs. Webhook URLs (which are credentials) are only returned when you explicitly ask.
- **Guard rails.** Deleting a channel requires its exact name as confirmation. Messages are sent with mentions disabled by default. Every change carries an audit-log reason, `Claude MCP (<tool>)`.
- **Small.** Plain `fetch` against the Discord REST API v10; no discord.js, no gateway connection.

## Quick start

You need: Node.js 20+, a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, and a Discord server where you have Manage Server.

1. **Create a Discord application** at <https://discord.com/developers/applications>:
   - *Bot* tab → **Reset Token** → copy the token. (No privileged intents needed.)
   - *OAuth2* tab → copy the **Client ID** and **Client Secret**.
2. **Install and run setup:**
   ```sh
   git clone https://github.com/Evin89/discord-admin-mcp.git
   cd discord-admin-mcp
   npm install
   npm run setup
   ```
   Setup logs you in to Cloudflare if needed, asks for your server ID, your Discord user ID and the three Discord values (secrets are typed hidden), creates the KV namespace, writes `wrangler.toml`, deploys, stores the secrets, and checks the bot token against Discord.
3. **Finish the three steps setup prints:**
   - add `https://<your-worker>/callback` under *OAuth2 → Redirects* in the Discord Developer Portal;
   - invite the bot with the printed link, then in *Server Settings → Roles* drag the bot's role **above** every role it should be able to edit;
   - in Claude: *Settings → Connectors → Add custom connector* → `https://<your-worker>/mcp`, approve, and sign in with Discord.

Finding IDs: Discord *User Settings → Advanced → Developer Mode*, then right-click your server icon or your own profile → **Copy ID**.

## Tools

| Tool | What it does |
|---|---|
| `get_guild_overview` | Channels (with category, topic, forum tags, readable permission overwrites) and roles |
| `list_webhooks` | Webhook IDs, names, channels. Never tokens or URLs |
| `get_onboarding`, `list_automod_rules` | Read onboarding and AutoMod config |
| `create_channel` | Text, announcement, forum, category or voice; overwrites; forum tags, require-tag, default reaction |
| `edit_channel` | Rename, move, topic or guidelines, slowmode, forum tags (existing tag IDs are kept by name); "tag required" is applied after the tags exist, so both can be set in one call |
| `set_permissions` | Set allow/deny for a role, `@everyone` or a member (`target_type: "member"`, user ID) on a channel; anything unlisted becomes neutral |
| `sync_permissions_with_category` | Copy the category's overwrites onto a channel |
| `create_role`, `edit_role` | Name, colour, hoist, mentionable, permissions |
| `delete_channel` | Only with `confirm_name` equal to the channel's current name |
| `set_onboarding` | Onboarding prompts and options, mapping to roles and channels by name or ID |
| `create_automod_rule` | Presets: `spam`, `mention_spam`, `keyword_preset` |
| `create_invite` | Invites, permanent by default |
| `send_message`, `edit_message`, `pin_message` | Bot messages, no pings by default |
| `crosspost_message` | Publish a message in an announcement channel to the servers that follow it |
| `create_webhook` | Returns the URL only with `reveal_url: true` |

Channels and roles can be referenced by ID or exact name (case-insensitive); ambiguous names return an error listing the matches. Permissions use Discord's flag names (`VIEW_CHANNEL`, `SEND_MESSAGES`, `MANAGE_THREADS`, …).

Deliberately **not** included: kicking or banning members, assigning roles to members, deleting other people's messages, deleting the server.

## Configuration

`npm run setup` handles this, but for reference:

| Name | Where | Value |
|---|---|---|
| `DISCORD_BOT_TOKEN` | secret | Bot token |
| `DISCORD_CLIENT_ID` | secret | OAuth2 Client ID (= application ID) |
| `DISCORD_CLIENT_SECRET` | secret | OAuth2 Client Secret |
| `COOKIE_ENCRYPTION_KEY` | secret | Random, ≥ 32 characters (setup generates one) |
| `ALLOWED_DISCORD_USER_IDS` | `wrangler.toml` | Who may sign in, comma-separated |
| `ALLOWED_GUILD_IDS` | `wrangler.toml` | Which servers the tools may touch, comma-separated |
| `MCP_RESOURCE` | `wrangler.toml` | Exact public URL of `/mcp` |

`wrangler.toml` is generated from `wrangler.example.toml` and is git-ignored, so your IDs don't end up in a fork. To configure by hand: copy the example, replace the `__PLACEHOLDERS__`, run `npx wrangler kv namespace create <name>` for the KV ID, `npx wrangler secret put <NAME>` for each secret, then `npm run deploy`.

**Bot permissions** in the invite link (`2251800619084849`): Create Invite, Manage Channels, Manage Server, View Channels, Send Messages, Manage Messages, Embed Links, Read Message History, Manage Roles, Manage Webhooks, Pin Messages. Discord still applies its own rules: a bot can't edit roles above its own highest role, can't grant permissions it doesn't have, and doesn't see private channels it has no access to. Onboarding and announcement or forum channels require the server to have *Community* enabled.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in the placeholders
cp wrangler.example.toml wrangler.toml   # or run setup once
npm run dev                       # http://localhost:8788
npx @modelcontextprotocol/inspector   # Streamable HTTP → http://localhost:8788/mcp
```

Add `http://localhost:8788/callback` as an extra redirect in the Discord Developer Portal for local sign-in.

## Validation

```sh
npm run typecheck
npm test
npx wrangler deploy --dry-run    # needs a wrangler.toml
```

Tests mock Discord and OAuth storage: permission encoding, the guild and user allowlists, the delete confirmation, webhook-secret hiding, tag ID preservation, the 429 retry and audit-log headers.

## How it works

Cloudflare [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider) makes the Worker an OAuth 2.1 authorization server with dynamic client registration, which is what Claude's custom connectors use. Its authorize step hands off to Discord OAuth (`identify` scope) and only completes for allow-listed user IDs. The MCP server itself is an [`agents`](https://github.com/cloudflare/agents) `McpAgent` (a Durable Object) serving Streamable HTTP at `/mcp` and legacy SSE at `/sse`, each with its own token audience. Discord calls use the bot token with one retry on rate limits.

Based on the pattern of Cloudflare's [remote MCP GitHub OAuth demo](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth).

## License

MIT
