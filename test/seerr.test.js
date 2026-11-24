import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeerr } from '../src/portal/seerr.js';

// Shaped like Seerr's GET /api/v1/search (MovieResult, TvResult, PersonResult).
const SEARCH = { page: 1, totalPages: 1, totalResults: 6, results: [
  { id: 693134, mediaType: 'movie', title: 'Dune: Part Two', releaseDate: '2024-02-27', overview: 'x', posterPath: '/p.jpg', mediaInfo: { status: 5, downloadStatus: [{ secret: 'internal' }] } },
  { id: 438631, mediaType: 'movie', title: 'Dune', releaseDate: '2021-09-15', mediaInfo: { status: 3 } },
  { id: 841, mediaType: 'movie', title: 'Dune', releaseDate: '1984-12-14' },
  { id: 90228, mediaType: 'tv', name: 'Dune: Prophecy', firstAirDate: '2024-11-17', mediaInfo: { status: 4 } },
  { id: 77, mediaType: 'person', name: 'Dune Person' },
  { id: 12, mediaType: 'movie', title: 'Undated', releaseDate: '' },
] };

function setup({ status = 200, body = SEARCH, headers = {}, ...options } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), raw: String(url), init });
    return {
      ok: status >= 200 && status < 300, status, headers: new Headers(headers),
      json: async () => { if (body === 'html') throw new SyntaxError('Unexpected token <'); return body; },
    };
  };
  const seerr = createSeerr({ url: 'https://tv.example/', apiKey: 'SECRETKEY', fetch, ...options });
  return { calls, seerr };
}

// --- search ---

test('movie search returns only movies, with year and where each one stands', async () => {
  const { seerr } = setup();
  assert.deepEqual(await seerr.search('movie', 'dune'), [
    { id: '693134', title: 'Dune: Part Two', author: '', detail: '2024', state: 'available' },
    { id: '438631', title: 'Dune', author: '', detail: '2021', state: 'requested' },
    { id: '841', title: 'Dune', author: '', detail: '1984', state: null },
    { id: '12', title: 'Undated', author: '', detail: '', state: null },
  ]);
});

test('tv search returns only shows', async () => {
  const { seerr } = setup();
  assert.deepEqual(await seerr.search('tv', 'dune'), [
    { id: '90228', title: 'Dune: Prophecy', author: '', detail: '2024', state: 'partial' },
  ]);
});

test('each library status maps to one plain state', async () => {
  const states = {};
  for (const status of [1, 2, 3, 4, 5, 6, 7]) {
    const { seerr } = setup({ body: { results: [{ id: 1, mediaType: 'movie', title: 'T', mediaInfo: { status } }] } });
    states[status] = (await seerr.search('movie', 't'))[0].state;
  }
  assert.deepEqual(states, { 1: null, 2: 'requested', 3: 'requested', 4: 'partial', 5: 'available', 6: 'blocked', 7: null });
});

test('search asks Seerr with the key in a header and spaces encoded as %20', async () => {
  const { calls, seerr } = setup();
  await seerr.search('movie', 'dune part two');
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://tv.example/api/v1/search');
  assert.match(calls[0].raw, /[?&]query=dune%20part%20two(&|$)/); // Seerr rejects "+" for spaces
  assert.equal(calls[0].init.headers['x-api-key'], 'SECRETKEY');
  assert.doesNotMatch(calls[0].raw, /SECRETKEY/);
});

test('at most 12 results come back', async () => {
  const results = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, mediaType: 'movie', title: `M${i}` }));
  const { seerr } = setup({ body: { results } });
  assert.equal((await seerr.search('movie', 'm')).length, 12);
});

test('search punctuation is stripped and a blank search calls nothing', async () => {
  const { calls, seerr } = setup();
  await seerr.search('movie', ' dune&page=9 ');
  assert.match(calls[0].raw, /query=dune%20page%209(&|$)/);
  assert.deepEqual(await seerr.search('movie', '   '), []);
  assert.equal(calls.length, 1);
});

test('only movies and tv can be searched', async () => {
  const { seerr } = setup();
  await assert.rejects(seerr.search('audiobook', 'x'), /type/i);
});

// --- request ---

test('requesting a movie posts its TMDB id', async () => {
  const { calls, seerr } = setup({ status: 201, body: { id: 5, status: 2 } });
  assert.deepEqual(await seerr.request('movie', '841'), { status: 'requested' });
  assert.equal(calls[0].url.pathname, '/api/v1/request');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { mediaType: 'movie', mediaId: 841 });
});

test('requesting a show asks for every season', async () => {
  const { calls, seerr } = setup({ status: 201, body: {} });
  await seerr.request('tv', '90228');
  assert.deepEqual(JSON.parse(calls[0].init.body), { mediaType: 'tv', mediaId: 90228, seasons: 'all' });
});

test('requests are filed under a chosen Seerr user when one is configured', async () => {
  const { calls, seerr } = setup({ status: 201, body: {}, userId: 7 });
  await seerr.request('movie', '841');
  assert.equal(JSON.parse(calls[0].init.body).userId, 7);
});

test('something already requested is reported as such, not as an error', async () => {
  const { seerr } = setup({ status: 409, body: { message: 'Request for this media already exists.' } });
  assert.deepEqual(await seerr.request('movie', '841'), { status: 'exists' });
});

test('a refusal from Seerr passes on its reason', async () => {
  const { seerr } = setup({ status: 403, body: { message: 'Movie Quota exceeded.' } });
  await assert.rejects(seerr.request('movie', '841'), /Movie Quota exceeded/);
});

test('an id that is not a number is refused without calling out', async () => {
  const { calls, seerr } = setup();
  await assert.rejects(seerr.request('movie', '841; drop'), /not valid/i);
  await assert.rejects(seerr.request('person', '841'), /type/i);
  assert.equal(calls.length, 0);
});

// --- connection problems ---

test('a rejected API key names the setting', async () => {
  const { seerr } = setup({ status: 401, body: {} });
  await assert.rejects(seerr.search('movie', 'dune'), /JELLYSEERR_API_KEY/);
});

test('a redirect or a non-JSON reply is reported as a login page, not followed', async () => {
  const redirected = setup({ status: 302, body: {}, headers: { location: 'https://team.cloudflareaccess.com/login' } });
  await assert.rejects(redirected.seerr.search('movie', 'dune'), /login/i);
  assert.equal(redirected.calls[0].init.redirect, 'manual');
  await assert.rejects(setup({ body: 'html' }).seerr.search('movie', 'dune'), /login/i);
});

test('an unreachable server gives a plain message without the key', async () => {
  const down = createSeerr({ url: 'https://tv.example', apiKey: 'SECRETKEY', fetch: async () => { throw new Error('boom SECRETKEY'); } });
  await assert.rejects(down.search('movie', 'dune'), (err) => /not responding/i.test(err.message) && !/SECRETKEY/.test(err.message));
});

test('Cloudflare Access service-token headers are sent when configured', async () => {
  const { calls, seerr } = setup({ accessId: 'id.access', accessSecret: 'shh' });
  await seerr.search('movie', 'dune');
  assert.equal(calls[0].init.headers['cf-access-client-id'], 'id.access');
  assert.equal(calls[0].init.headers['cf-access-client-secret'], 'shh');
});

test('nothing internal from Seerr reaches the page', async () => {
  const { seerr } = setup();
  assert.doesNotMatch(JSON.stringify(await seerr.search('movie', 'dune')), /internal|posterPath|overview|SECRETKEY/);
});
