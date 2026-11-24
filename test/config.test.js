import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('a missing token fails with a message that names the variable', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);
});

test('defaults cover everything except the token', () => {
  const config = loadConfig({ DISCORD_TOKEN: 'abc' });
  assert.equal(config.token, 'abc');
  assert.equal(config.guildId, null);
  assert.equal(config.booksDir, './books');
  assert.equal(config.dbFile, 'data/audiobook.db');
  assert.equal(config.emptyLeaveMs, 5 * 60_000);
});

test('environment values override the defaults', () => {
  const config = loadConfig({
    DISCORD_TOKEN: ' abc ',
    GUILD_ID: '123',
    BOOKS_DIR: '/books',
    DATA_DIR: '/data',
    EMPTY_LEAVE_MINUTES: '2',
  });
  assert.equal(config.token, 'abc');
  assert.equal(config.guildId, '123');
  assert.equal(config.booksDir, '/books');
  assert.equal(config.dbFile, '/data/audiobook.db');
  assert.equal(config.emptyLeaveMs, 2 * 60_000);
});

test('a nonsense grace period is rejected', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', EMPTY_LEAVE_MINUTES: 'soon' }), /EMPTY_LEAVE_MINUTES/);
});
