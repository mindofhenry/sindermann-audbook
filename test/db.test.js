import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';

const G = 'guild-1';

test('progress is null for a book that was never played', () => {
  const db = openDb(':memory:');
  assert.equal(db.getProgress(G, 'book-a'), null);
});

test('saved progress can be read back', () => {
  const db = openDb(':memory:');
  db.saveProgress(G, 'book-a', 123.5);
  assert.equal(db.getProgress(G, 'book-a').position, 123.5);
});

test('saving again overwrites the earlier position', () => {
  const db = openDb(':memory:');
  db.saveProgress(G, 'book-a', 10);
  db.saveProgress(G, 'book-a', 20);
  assert.equal(db.getProgress(G, 'book-a').position, 20);
});

test('progress is kept separately per book and per server', () => {
  const db = openDb(':memory:');
  db.saveProgress(G, 'book-a', 10);
  db.saveProgress(G, 'book-b', 20);
  db.saveProgress('guild-2', 'book-a', 30);
  assert.equal(db.getProgress(G, 'book-a').position, 10);
  assert.equal(db.getProgress(G, 'book-b').position, 20);
  assert.equal(db.getProgress('guild-2', 'book-a').position, 30);
});

test('lastBookId is the most recently saved book for the server', () => {
  let clock = 1000;
  const db = openDb(':memory:', { now: () => clock });
  db.saveProgress(G, 'book-a', 10);
  clock = 2000;
  db.saveProgress(G, 'book-b', 20);
  assert.equal(db.lastBookId(G), 'book-b');
  clock = 3000;
  db.saveProgress(G, 'book-a', 11);
  assert.equal(db.lastBookId(G), 'book-a');
});

test('lastBookId is null when nothing was played', () => {
  assert.equal(openDb(':memory:').lastBookId(G), null);
});

test('allProgress maps book ids to positions for one server', () => {
  const db = openDb(':memory:');
  db.saveProgress(G, 'book-a', 10);
  db.saveProgress(G, 'book-b', 20);
  db.saveProgress('guild-2', 'book-c', 30);
  assert.deepEqual(db.allProgress(G), { 'book-a': 10, 'book-b': 20 });
});

test('speed defaults to 1 and remembers a change per server', () => {
  const db = openDb(':memory:');
  assert.equal(db.getSpeed(G), 1);
  db.setSpeed(G, 1.5);
  assert.equal(db.getSpeed(G), 1.5);
  assert.equal(db.getSpeed('guild-2'), 1);
});

test('bookmarks are listed for their book in position order', () => {
  const db = openDb(':memory:');
  db.addBookmark({ guildId: G, bookId: 'book-a', position: 300, label: 'later', userId: 'u1' });
  db.addBookmark({ guildId: G, bookId: 'book-a', position: 100, label: 'early', userId: 'u1' });
  db.addBookmark({ guildId: G, bookId: 'book-b', position: 50, label: 'other book', userId: 'u1' });
  assert.deepEqual(
    db.listBookmarks(G, 'book-a').map((b) => [b.label, b.position]),
    [['early', 100], ['later', 300]],
  );
});

test('a bookmark can be fetched by id within its server only', () => {
  const db = openDb(':memory:');
  const id = db.addBookmark({ guildId: G, bookId: 'book-a', position: 42, label: 'x', userId: 'u1' });
  assert.equal(db.getBookmark(G, id).position, 42);
  assert.equal(db.getBookmark('guild-2', id), null);
});

test('removing a bookmark deletes it and reports whether it existed', () => {
  const db = openDb(':memory:');
  const id = db.addBookmark({ guildId: G, bookId: 'book-a', position: 42, label: 'x', userId: 'u1' });
  assert.equal(db.removeBookmark(G, id), true);
  assert.equal(db.removeBookmark(G, id), false);
  assert.deepEqual(db.listBookmarks(G, 'book-a'), []);
});

test('data survives closing and reopening the database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abbot-db-'));
  const file = join(dir, 'nested', 'state.db');
  const first = openDb(file);
  first.saveProgress(G, 'book-a', 77);
  first.addBookmark({ guildId: G, bookId: 'book-a', position: 5, label: 'keep', userId: 'u1' });
  first.close();

  const second = openDb(file);
  assert.equal(second.getProgress(G, 'book-a').position, 77);
  assert.equal(second.listBookmarks(G, 'book-a')[0].label, 'keep');
  second.close();
  rmSync(dir, { recursive: true, force: true });
});
