import test from 'node:test';
import assert from 'node:assert/strict';
import { createProwlarr } from '../src/portal/prowlarr.js';

// Releases shaped like Prowlarr's /api/v1/search response (ReleaseResource).
const RELEASES = [
  {
    guid: 'https://tracker.example/details/1', title: 'Dracula (Unabridged)', indexer: 'Internet Archive', indexerId: 3,
    size: 524288000, seeders: 4, leechers: 0, age: 12, protocol: 'torrent',
    downloadUrl: 'http://prowlarr.local:9696/3/download?apikey=SECRETKEY&link=abc',
    magnetUrl: 'magnet:?xt=urn:btih:abc', infoUrl: 'https://tracker.example/details/1', infoHash: 'abc',
  },
  {
    guid: 'https://tracker.example/details/2', title: 'Dracula, read by a full cast', indexer: 'Internet Archive', indexerId: 3,
    size: 1073741824, seeders: 40, leechers: 2, age: 400, protocol: 'torrent',
    downloadUrl: 'http://prowlarr.local:9696/3/download?apikey=SECRETKEY&link=def',
  },
  { guid: 'nzb-3', title: 'Dracula NZB', indexer: 'Some Usenet', indexerId: 7, size: 1000, seeders: null, age: 3, protocol: 'usenet' },
];

function setup({ status = 200, body = RELEASES, headers = {}, ...options } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      json: async () => { if (body === 'html') throw new SyntaxError('Unexpected token <'); return body; },
    };
  };
  const prowlarr = createProwlarr({ url: 'http://prowlarr.local:9696', apiKey: 'SECRETKEY', fetch, ...options });
  return { calls, prowlarr };
}

test('search asks Prowlarr for audiobook releases matching the words', async () => {
  const { calls, prowlarr } = setup();
  await prowlarr.search('dracula stoker');
  const { url } = calls[0];
  assert.equal(url.origin, 'http://prowlarr.local:9696');
  assert.equal(url.pathname, '/api/v1/search');
  assert.equal(url.searchParams.get('query'), 'dracula stoker');
  assert.equal(url.searchParams.get('type'), 'search');
  assert.deepEqual(url.searchParams.getAll('categories'), ['3030']); // Newznab: Audio > Audiobook
});

test('the API key travels in a header, never in the address', async () => {
  const { calls, prowlarr } = setup();
  await prowlarr.search('dracula');
  assert.equal(calls[0].init.headers['x-api-key'], 'SECRETKEY');
  assert.doesNotMatch(calls[0].url.href, /SECRETKEY/);
});

test('results carry title, indexer, size, seeders, age and protocol, best seeded first', async () => {
  const { prowlarr } = setup();
  assert.deepEqual(await prowlarr.search('dracula'), [
    { title: 'Dracula, read by a full cast', indexer: 'Internet Archive', size: 1073741824, seeders: 40, age: 400, protocol: 'torrent' },
    { title: 'Dracula (Unabridged)', indexer: 'Internet Archive', size: 524288000, seeders: 4, age: 12, protocol: 'torrent' },
    { title: 'Dracula NZB', indexer: 'Some Usenet', size: 1000, seeders: null, age: 3, protocol: 'usenet' },
  ]);
});

test('download links, magnets and the API key never reach the page', async () => {
  const { prowlarr } = setup();
  const sent = JSON.stringify(await prowlarr.search('dracula'));
  assert.doesNotMatch(sent, /SECRETKEY|magnet:|download|tracker\.example/);
});

test('at most 25 results come back', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ title: `Book ${i}`, indexer: 'X', size: 1, seeders: i, age: 1, protocol: 'torrent' }));
  const { prowlarr } = setup({ body: many });
  const results = await prowlarr.search('book');
  assert.equal(results.length, 25);
  assert.equal(results[0].title, 'Book 59');
});

test('search can be limited to chosen indexers', async () => {
  const { calls, prowlarr } = setup({ indexerIds: [3, 12] });
  await prowlarr.search('dracula');
  assert.deepEqual(calls[0].url.searchParams.getAll('indexerIds'), ['3', '12']);
});

test('without chosen indexers the search covers all of them', async () => {
  const { calls, prowlarr } = setup();
  await prowlarr.search('dracula');
  assert.deepEqual(calls[0].url.searchParams.getAll('indexerIds'), []);
});

test('search punctuation is stripped before it reaches Prowlarr', async () => {
  const { calls, prowlarr } = setup();
  await prowlarr.search('  dracula&apikey=x {ImdbId:tt1}  ');
  assert.equal(calls[0].url.searchParams.get('query'), 'dracula apikey x ImdbId tt1');
});

test('a blank search returns nothing without calling out', async () => {
  const { calls, prowlarr } = setup();
  assert.deepEqual(await prowlarr.search('   '), []);
  assert.equal(calls.length, 0);
});

test('Cloudflare Access service-token headers are sent when configured', async () => {
  const { calls, prowlarr } = setup({ accessId: 'id.access', accessSecret: 'shh' });
  await prowlarr.search('dracula');
  assert.equal(calls[0].init.headers['cf-access-client-id'], 'id.access');
  assert.equal(calls[0].init.headers['cf-access-client-secret'], 'shh');
});

test('no Cloudflare Access headers are sent when none are configured', async () => {
  const { calls, prowlarr } = setup();
  await prowlarr.search('dracula');
  assert.equal('cf-access-client-id' in calls[0].init.headers, false);
});

test('a rejected API key gives a message that names the setting', async () => {
  const { prowlarr } = setup({ status: 401, body: {} });
  await assert.rejects(prowlarr.search('dracula'), /PROWLARR_API_KEY/);
});

test('a redirect to a login page is reported, not followed', async () => {
  const { calls, prowlarr } = setup({ status: 302, body: {}, headers: { location: 'https://team.cloudflareaccess.com/login' } });
  await assert.rejects(prowlarr.search('dracula'), /login/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('a server error or unreachable Prowlarr gives a plain message', async () => {
  await assert.rejects(setup({ status: 500, body: {} }).prowlarr.search('dracula'), /not responding/i);
  const down = createProwlarr({ url: 'http://prowlarr.local:9696', apiKey: 'k', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.search('dracula'), /not responding/i);
});

test('a reply that is not JSON is treated as a login page', async () => {
  const { prowlarr } = setup({ body: 'html' });
  await assert.rejects(prowlarr.search('dracula'), /login/i);
});

test('error messages never contain the API key', async () => {
  const leaky = createProwlarr({ url: 'http://prowlarr.local:9696', apiKey: 'SECRETKEY', fetch: async () => { throw new Error('failed: x-api-key SECRETKEY'); } });
  await assert.rejects(leaky.search('dracula'), (err) => !/SECRETKEY/.test(err.message));
});

test('a Prowlarr served under a URL base keeps that base', async () => {
  const { calls, prowlarr } = setup({ url: 'https://home.example/prowlarr/' });
  await prowlarr.search('dracula');
  assert.equal(calls[0].url.href.split('?')[0], 'https://home.example/prowlarr/api/v1/search');
});
