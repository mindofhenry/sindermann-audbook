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
    jellyseerr: loadJellyseerr(env),
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
    upload: loadUpload(env),
  };
}

// Optional upload button on the homepage. Off until somebody is named.
function loadUpload(env) {
  const emails = (env.UPLOAD_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails.some((email) => email !== '*' && !/^[^@\s]+@[^@\s]+$/.test(email))) {
    throw new Error('UPLOAD_EMAILS must be email addresses separated by commas, or * for everybody who can open the page.');
  }
  const gb = Number(env.UPLOAD_MAX_GB?.trim() || 2);
  if (!Number.isFinite(gb) || gb <= 0 || gb > 50) throw new Error('UPLOAD_MAX_GB must be a size in gigabytes between 0 and 50, for example 2.');
  return emails.length ? { emails, maxBytes: Math.round(gb * 1024 ** 3) } : null;
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

// Optional movies and TV on the homepage, through a Seerr / Jellyseerr server.
function loadJellyseerr(env) {
  const url = env.JELLYSEERR_URL?.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) throw new Error('JELLYSEERR_URL must start with http:// or https://.');

  const apiKey = env.JELLYSEERR_API_KEY?.trim();
  if (!apiKey) throw new Error('JELLYSEERR_API_KEY is not set. Copy it from Jellyseerr > Settings > General > API Key.');

  const user = env.JELLYSEERR_USER_ID?.trim();
  if (user && !/^\d+$/.test(user)) throw new Error('JELLYSEERR_USER_ID must be a user number, for example 7.');

  const accessId = env.JELLYSEERR_CF_ACCESS_CLIENT_ID?.trim() || null;
  const accessSecret = env.JELLYSEERR_CF_ACCESS_CLIENT_SECRET?.trim() || null;
  if (Boolean(accessId) !== Boolean(accessSecret)) {
    throw new Error('Set both JELLYSEERR_CF_ACCESS_CLIENT_ID and JELLYSEERR_CF_ACCESS_CLIENT_SECRET, or neither.');
  }

  return { url, apiKey, userId: user ? Number(user) : null, accessId, accessSecret };
}
