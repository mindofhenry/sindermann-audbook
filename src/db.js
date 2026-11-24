// Persistent state: where each server is in each book, bookmarks, and speed.
// Uses Node's built-in SQLite so there is no native module to compile.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS progress (
    guild_id   TEXT NOT NULL,
    book_id    TEXT NOT NULL,
    position   REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, book_id)
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    book_id    TEXT NOT NULL,
    position   REAL NOT NULL,
    label      TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bookmarks_by_book ON bookmarks (guild_id, book_id, position);
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    speed    REAL NOT NULL DEFAULT 1
  );
`;

export function openDb(file, { now = Date.now } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sql = new DatabaseSync(file);
  sql.exec('PRAGMA journal_mode = WAL;');
  sql.exec(SCHEMA);

  const q = {
    getProgress: sql.prepare('SELECT position, updated_at AS updatedAt FROM progress WHERE guild_id = ? AND book_id = ?'),
    saveProgress: sql.prepare(`
      INSERT INTO progress (guild_id, book_id, position, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (guild_id, book_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`),
    lastBook: sql.prepare('SELECT book_id AS bookId FROM progress WHERE guild_id = ? ORDER BY updated_at DESC LIMIT 1'),
    allProgress: sql.prepare('SELECT book_id AS bookId, position FROM progress WHERE guild_id = ?'),
    getSpeed: sql.prepare('SELECT speed FROM guild_settings WHERE guild_id = ?'),
    setSpeed: sql.prepare(`
      INSERT INTO guild_settings (guild_id, speed) VALUES (?, ?)
      ON CONFLICT (guild_id) DO UPDATE SET speed = excluded.speed`),
    addBookmark: sql.prepare('INSERT INTO bookmarks (guild_id, book_id, position, label, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    listBookmarks: sql.prepare('SELECT id, position, label, user_id AS userId FROM bookmarks WHERE guild_id = ? AND book_id = ? ORDER BY position'),
    getBookmark: sql.prepare('SELECT id, book_id AS bookId, position, label FROM bookmarks WHERE guild_id = ? AND id = ?'),
    removeBookmark: sql.prepare('DELETE FROM bookmarks WHERE guild_id = ? AND id = ?'),
  };

  // node:sqlite returns null-prototype rows; copy them into plain objects.
  const plain = (row) => (row ? { ...row } : null);

  return {
    getProgress: (guildId, bookId) => plain(q.getProgress.get(guildId, bookId)),
    saveProgress: (guildId, bookId, position) => void q.saveProgress.run(guildId, bookId, position, now()),
    lastBookId: (guildId) => q.lastBook.get(guildId)?.bookId ?? null,
    allProgress: (guildId) => Object.fromEntries(q.allProgress.all(guildId).map((r) => [r.bookId, r.position])),

    getSpeed: (guildId) => q.getSpeed.get(guildId)?.speed ?? 1,
    setSpeed: (guildId, speed) => void q.setSpeed.run(guildId, speed),

    addBookmark: ({ guildId, bookId, position, label, userId }) =>
      Number(q.addBookmark.run(guildId, bookId, position, label, userId, now()).lastInsertRowid),
    listBookmarks: (guildId, bookId) => q.listBookmarks.all(guildId, bookId).map(plain),
    getBookmark: (guildId, id) => plain(q.getBookmark.get(guildId, id)),
    removeBookmark: (guildId, id) => q.removeBookmark.run(guildId, id).changes > 0,

    close: () => sql.close(),
  };
}
