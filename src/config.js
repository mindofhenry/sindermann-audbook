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

  return {
    token,
    // Optional: limit slash commands to one server. By default they are
    // registered in every server the bot is in.
    guildId: env.GUILD_ID?.trim() || null,
    booksDir: env.BOOKS_DIR?.trim() || './books',
    dbFile: join(env.DATA_DIR?.trim() || './data', 'audiobook.db'),
    emptyLeaveMs: minutes * 60_000,
  };
}
