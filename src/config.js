// Reads settings from environment variables (see .env.example).
import { join } from 'node:path';

export function loadConfig(env = process.env) {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token) {
    throw new Error('DISCORD_TOKEN is not set. Put your bot token in .env (see .env.example).');
  }

  const minutes = Number(env.EMPTY_LEAVE_MINUTES ?? 5);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error('EMPTY_LEAVE_MINUTES must be a number of minutes, for example 5.');
  }

  let portalPort = null;
  if (env.PORTAL_PORT?.trim()) {
    portalPort = Number(env.PORTAL_PORT);
    if (!Number.isInteger(portalPort) || portalPort < 1 || portalPort > 65535) {
      throw new Error('PORTAL_PORT must be a port number, for example 8080.');
    }
  }

  const listenUrl = env.LISTEN_URL?.trim() || null;
  if (listenUrl && !/^https?:\/\//i.test(listenUrl)) {
    throw new Error('LISTEN_URL must start with http:// or https://.');
  }

  return {
    token,
    prowlarr: loadProwlarr(env),
    // Optional: limit slash commands to one server. By default they are
    // registered in every server the bot is in.
    guildId: env.GUILD_ID?.trim() || null,
    booksDir: env.BOOKS_DIR?.trim() || './books',
    dbFile: join(env.DATA_DIR?.trim() || './data', 'audiobook.db'),
    emptyLeaveMs: minutes * 60_000,
    // Friends homepage (search and add public-domain books). Off without a port.
    portalPort,
    // Ebooks need a catalog the server can reach reliably; off by default.
    portalTypes: /^(1|on|true|yes)$/i.test(env.PORTAL_EBOOKS?.trim() ?? '') ? ['audiobook', 'ebook'] : ['audiobook'],
    ebooksDir: env.EBOOKS_DIR?.trim() || './ebooks',
    // Optional link to a web player such as Audiobookshelf.
    listenUrl,
  };
}

// Optional read-only Prowlarr search on the homepage. Off without an address.
function loadProwlarr(env) {
  const url = env.PROWLARR_URL?.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) throw new Error('PROWLARR_URL must start with http:// or https://.');

  const apiKey = env.PROWLARR_API_KEY?.trim();
  if (!apiKey) throw new Error('PROWLARR_API_KEY is not set. Copy it from Prowlarr > Settings > General > API Key.');

  const ids = (env.PROWLARR_INDEXER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error('PROWLARR_INDEXER_IDS must be indexer numbers separated by commas, for example 3,12.');
  }

  const accessId = env.PROWLARR_CF_ACCESS_CLIENT_ID?.trim() || null;
  const accessSecret = env.PROWLARR_CF_ACCESS_CLIENT_SECRET?.trim() || null;
  if (Boolean(accessId) !== Boolean(accessSecret)) {
    throw new Error('Set both PROWLARR_CF_ACCESS_CLIENT_ID and PROWLARR_CF_ACCESS_CLIENT_SECRET, or neither.');
  }

  return { url, apiKey, indexerIds: ids.map(Number), accessId, accessSecret };
}
