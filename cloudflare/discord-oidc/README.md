# Discord login for the friends homepage

A small Cloudflare Worker that lets Cloudflare Access offer "Log in with Discord". Access speaks OpenID Connect and Discord does not, so this sits between them. It talks only to `discord.com` and its own KV namespace.

Based on the idea in [Erisa/discord-oidc-worker](https://github.com/Erisa/discord-oidc-worker) (MIT), rewritten with no dependencies and with the Discord app secret held as a Worker secret.

## What Access learns about a person

`id` (Discord user ID), `email`, `name`, `preferred_username`, `guilds` (server IDs) and, when a bot token is set, `roles:<server id>` for each server in `GUILD_IDS`. Nothing else from the Discord profile is passed on, and Discord's own tokens never leave the Worker.

## Setup

1. **Discord Developer Portal** > your application > OAuth2: add the redirect `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Copy the Client ID and the Client Secret.
2. **Deploy** from this folder: fill in `wrangler.toml`, then
   ```bash
   npx wrangler kv namespace create discord-oidc-keys   # put the id in wrangler.toml
   npx wrangler deploy
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put DISCORD_TOKEN                # only if you want role rules
   ```
3. **Zero Trust** > Integrations > Identity providers > Add > OpenID Connect:
   | Field | Value |
   | --- | --- |
   | App ID | the Discord Client ID |
   | Client secret | anything; the Worker uses its own secret |
   | Auth URL | `https://<worker>/authorize` |
   | Token URL | `https://<worker>/token` |
   | Certificate URL | `https://<worker>/jwks.json` |
   | Email claim | `email` |
   | OIDC claims | `id`, `preferred_username`, `name`, `guilds`, `roles:<server id>` |
4. Enable the new login method on the Access application and add a policy rule on an OIDC claim: `guilds` contains your server ID (anyone in the server), or `roles:<server id>` contains a role ID (only people with that role).

For role rules the bot must be a member of the server. It needs no permissions.

## Checking it

`https://<worker>/health` reports whether the client secret is set, whether Discord accepts the bot token, and whether the bot can see each server in `GUILD_IDS`. It never shows a secret.

## Tests

`npm test` from the repository root. The Worker is tested against a stand-in for Discord's API, and the id_token is checked against the key that `/jwks.json` publishes.
