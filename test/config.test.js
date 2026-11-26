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

test('ebooks on the homepage are off unless switched on', () => {
  assert.deepEqual(loadConfig({ DISCORD_TOKEN: 'abc' }).portalTypes, ['audiobook']);
  assert.deepEqual(loadConfig({ DISCORD_TOKEN: 'abc', PORTAL_EBOOKS: 'on' }).portalTypes, ['audiobook', 'ebook']);
});

test('Prowlarr search is off unless an address is set', () => {
  assert.equal(loadConfig({ DISCORD_TOKEN: 'abc' }).prowlarr, null);
});

test('Prowlarr settings are read from the environment', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'abc',
    PROWLARR_URL: ' https://prowlarr.example/ ',
    PROWLARR_API_KEY: ' key123 ',
    PROWLARR_INDEXER_IDS: '3, 12',
    PROWLARR_CF_ACCESS_CLIENT_ID: 'id.access',
    PROWLARR_CF_ACCESS_CLIENT_SECRET: 'shh',
  });
  assert.deepEqual(config.prowlarr, {
    url: 'https://prowlarr.example/', apiKey: 'key123', indexerIds: [3, 12], accessId: 'id.access', accessSecret: 'shh',
  });
});

test('Prowlarr defaults to every indexer and no Cloudflare Access token', () => {
  const config = loadConfig({ DISCORD_TOKEN: 'abc', PROWLARR_URL: 'http://localhost:9696', PROWLARR_API_KEY: 'k' });
  assert.deepEqual(config.prowlarr, { url: 'http://localhost:9696', apiKey: 'k', indexerIds: [], accessId: null, accessSecret: null });
});

test('a Prowlarr address without an API key is rejected', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', PROWLARR_URL: 'http://localhost:9696' }), /PROWLARR_API_KEY/);
});

test('a Prowlarr address that is not an http(s) address is rejected', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', PROWLARR_URL: 'localhost:9696', PROWLARR_API_KEY: 'k' }), /PROWLARR_URL/);
});

test('Prowlarr indexer IDs that are not whole numbers are rejected', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', PROWLARR_URL: 'http://x', PROWLARR_API_KEY: 'k', PROWLARR_INDEXER_IDS: '3, archive' }), /PROWLARR_INDEXER_IDS/);
});

test('half a Cloudflare Access token is rejected', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', PROWLARR_URL: 'http://x', PROWLARR_API_KEY: 'k', PROWLARR_CF_ACCESS_CLIENT_ID: 'id' }), /PROWLARR_CF_ACCESS/);
});

test('movies and TV are off unless a Jellyseerr address is set', () => {
  assert.equal(loadConfig({ DISCORD_TOKEN: 'abc' }).jellyseerr, null);
});

test('Jellyseerr settings are read from the environment', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'abc', JELLYSEERR_URL: ' https://tv.example/ ', JELLYSEERR_API_KEY: ' key ', JELLYSEERR_USER_ID: ' 7 ',
    JELLYSEERR_CF_ACCESS_CLIENT_ID: 'id.access', JELLYSEERR_CF_ACCESS_CLIENT_SECRET: 'shh',
  });
  assert.deepEqual(config.jellyseerr, { url: 'https://tv.example/', apiKey: 'key', userId: 7, accessId: 'id.access', accessSecret: 'shh' });
});

test('Jellyseerr defaults to no chosen user and no Cloudflare Access token', () => {
  const config = loadConfig({ DISCORD_TOKEN: 'abc', JELLYSEERR_URL: 'http://localhost:5055', JELLYSEERR_API_KEY: 'k' });
  assert.deepEqual(config.jellyseerr, { url: 'http://localhost:5055', apiKey: 'k', userId: null, accessId: null, accessSecret: null });
});

test('incomplete or malformed Jellyseerr settings are rejected with the name of the setting', () => {
  const base = { DISCORD_TOKEN: 'abc', JELLYSEERR_URL: 'http://x', JELLYSEERR_API_KEY: 'k' };
  assert.throws(() => loadConfig({ ...base, JELLYSEERR_API_KEY: '' }), /JELLYSEERR_API_KEY/);
  assert.throws(() => loadConfig({ ...base, JELLYSEERR_URL: 'tv.example' }), /JELLYSEERR_URL/);
  assert.throws(() => loadConfig({ ...base, JELLYSEERR_USER_ID: 'henry' }), /JELLYSEERR_USER_ID/);
  assert.throws(() => loadConfig({ ...base, JELLYSEERR_CF_ACCESS_CLIENT_ID: 'id' }), /JELLYSEERR_CF_ACCESS/);
});

test('uploads are off until somebody is named', () => {
  assert.equal(loadConfig({ DISCORD_TOKEN: 'abc' }).upload, null);
  assert.equal(loadConfig({ DISCORD_TOKEN: 'abc', UPLOAD_EMAILS: ' , ' }).upload, null);
});

test('upload settings are read from the environment', () => {
  const config = loadConfig({ DISCORD_TOKEN: 'abc', UPLOAD_EMAILS: ' Henry@Example.com, friend@example.com ', UPLOAD_MAX_GB: '0.5' });
  assert.deepEqual(config.upload, { emails: ['henry@example.com', 'friend@example.com'], maxBytes: 536870912 });
  assert.deepEqual(loadConfig({ DISCORD_TOKEN: 'abc', UPLOAD_EMAILS: '*' }).upload, { emails: ['*'], maxBytes: 2 * 1024 ** 3 });
});

test('malformed upload settings are rejected with the name of the setting', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', UPLOAD_EMAILS: 'henry' }), /UPLOAD_EMAILS/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', UPLOAD_EMAILS: '*', UPLOAD_MAX_GB: 'lots' }), /UPLOAD_MAX_GB/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', UPLOAD_EMAILS: '*', UPLOAD_MAX_GB: '0' }), /UPLOAD_MAX_GB/);
});

test('the shelf address for /help is optional and must be a web address', () => {
  assert.equal(loadConfig({ DISCORD_TOKEN: 'abc' }).shelfUrl, null);
  assert.equal(loadConfig({ DISCORD_TOKEN: 'abc', SHELF_URL: ' https://friends.example ' }).shelfUrl, 'https://friends.example');
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', SHELF_URL: 'friends.example' }), /SHELF_URL/);
});
