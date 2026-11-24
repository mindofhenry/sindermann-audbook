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
