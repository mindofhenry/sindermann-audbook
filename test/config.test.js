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

test('the homepage is off unless a port is set', () => {
  const config = loadConfig({ DISCORD_TOKEN: 'abc' });
  assert.equal(config.portalPort, null);
  assert.equal(config.ebooksDir, './ebooks');
  assert.equal(config.listenUrl, null);
});

test('homepage settings are read from the environment', () => {
  const config = loadConfig({ DISCORD_TOKEN: 'abc', PORTAL_PORT: '8080', EBOOKS_DIR: '/ebooks', LISTEN_URL: ' https://listen.example ' });
  assert.equal(config.portalPort, 8080);
  assert.equal(config.ebooksDir, '/ebooks');
  assert.equal(config.listenUrl, 'https://listen.example');
});

test('a homepage port that is not a port is rejected', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', PORTAL_PORT: 'eighty' }), /PORTAL_PORT/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', PORTAL_PORT: '70000' }), /PORTAL_PORT/);
});

test('a listen link that is not an http(s) address is rejected', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', LISTEN_URL: 'javascript:alert(1)' }), /LISTEN_URL/);
});
