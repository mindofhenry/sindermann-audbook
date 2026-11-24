import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortal } from '../src/portal/server.js';
import { bookA } from './helpers/fakes.js';

async function setup({ addBook, prowlarr, seerr, now } = {}) {
  const added = [];
  const gates = [];
  const catalog = {
    types: ['audiobook'],
    search: async (type, q) => {
      if (type !== 'audiobook' && type !== 'ebook') throw new Error('Unknown catalog type.');
      return q ? [{ id: 'alice', title: 'Alice', author: 'Carroll', detail: '2:58:51' }] : [];
    },
    plan: async (type, id) => {
      if (id === 'bad') throw new Error('Only public-domain LibriVox recordings can be added.');
      return { title: `Title of ${id}`, author: 'A', files: [{ name: 'a.mp3', url: 'https://archive.org/a.mp3', size: 1 }] };
    },
  };
  const library = { books: [bookA()], rescans: 0, async rescan() { this.rescans += 1; return { count: 1, warnings: [] }; } };
  const portal = createPortal({
    catalog,
    library,
    listenUrl: 'https://listen.example',
    prowlarr,
    seerr,
    now,
    addBook: addBook ?? (async (type, plan) => {
      added.push([type, plan.title]);
      await new Promise((resolve) => gates.push(resolve)); // held until the test releases it
      return { status: 'added' };
    }),
  });
  await new Promise((resolve) => portal.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${portal.server.address().port}`;
  const post = (body, headers = { 'content-type': 'application/json' }) =>
    fetch(`${base}/api/add`, { method: 'POST', headers, body: JSON.stringify(body) });
  const jobs = async () => (await (await fetch(`${base}/api/jobs`)).json()).jobs;
  const release = async () => { gates.shift()?.(); await new Promise((r) => setTimeout(r, 30)); };
  return { base, post, jobs, release, added, library, close: () => portal.server.close() };
}

test('the homepage is served as HTML with a strict content policy', async () => {
  const { base, close } = await setup();
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await res.text(), /<input[^>]+type="search"/);
  close();
});

test('the page script and stylesheet are served', async () => {
  const { base, close } = await setup();
  assert.match((await fetch(`${base}/app.js`)).headers.get('content-type'), /javascript/);
  assert.match((await fetch(`${base}/app.css`)).headers.get('content-type'), /css/);
  close();
});

test('search returns catalog results', async () => {
  const { base, close } = await setup();
  const body = await (await fetch(`${base}/api/search?type=audiobook&q=alice`)).json();
  assert.deepEqual(body.results, [{ id: 'alice', title: 'Alice', author: 'Carroll', detail: '2:58:51' }]);
  close();
});

test('search with an unknown type is a 400 with a message', async () => {
  const { base, close } = await setup();
  const res = await fetch(`${base}/api/search?type=movie&q=x`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /type/i);
  close();
});

test('adding a book queues it, downloads it and rescans the library', async () => {
  const { post, jobs, release, added, library, close } = await setup();
  const res = await post({ type: 'audiobook', id: 'alice' });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(added, [['audiobook', 'Title of alice']]);
  assert.equal((await jobs())[0].state, 'working');
  await release();
  const [job] = await jobs();
  assert.equal(job.state, 'done');
  assert.equal(job.title, 'Title of alice');
  assert.equal(library.rescans, 1);
  close();
});

test('adding the same book twice while it downloads does not start a second download', async () => {
  const { post, release, added, close } = await setup();
  await post({ type: 'audiobook', id: 'alice' });
  await post({ type: 'audiobook', id: 'alice' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(added.length, 1);
  await release();
  close();
});

test('books download one at a time', async () => {
  const { post, jobs, release, added, close } = await setup();
  await post({ type: 'audiobook', id: 'one' });
  await post({ type: 'audiobook', id: 'two' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(added.length, 1);
  assert.deepEqual((await jobs()).map((j) => j.state).sort(), ['queued', 'working']);
  await release();
  assert.equal(added.length, 2);
  await release();
  close();
});

test('a book the catalog refuses is reported and never downloaded', async () => {
  const { post, added, close } = await setup();
  const res = await post({ type: 'audiobook', id: 'bad' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /public-domain/i);
  assert.deepEqual(added, []);
  close();
});

test('a failed download is shown as failed with its reason', async () => {
  const { post, jobs, library, close } = await setup({ addBook: async () => { throw new Error('Download failed (404) for a.mp3'); } });
  await post({ type: 'audiobook', id: 'alice' });
  await new Promise((r) => setTimeout(r, 30));
  const [job] = await jobs();
  assert.equal(job.state, 'failed');
  assert.match(job.error, /404/);
  assert.equal(library.rescans, 0);
  close();
});

test('a book already on the shelf is reported as such', async () => {
  const { post, jobs, close } = await setup({ addBook: async () => ({ status: 'exists' }) });
  await post({ type: 'audiobook', id: 'alice' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await jobs())[0].state, 'exists');
  close();
});

test('the person who asked is recorded from the Cloudflare Access header', async () => {
  const { post, jobs, release, close } = await setup();
  await post({ type: 'audiobook', id: 'alice' }, { 'content-type': 'application/json', 'cf-access-authenticated-user-email': 'friend@example.com' });
  assert.equal((await jobs())[0].by, 'friend@example.com');
  await release();
  close();
});

test('add requests from another site are refused', async () => {
  const { post, added, close } = await setup();
  const res = await post({ type: 'audiobook', id: 'alice' }, { 'content-type': 'application/json', origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.deepEqual(added, []);
  close();
});

test('add requests that are not JSON are refused', async () => {
  const { post, close } = await setup();
  assert.equal((await post({ type: 'audiobook', id: 'alice' }, { 'content-type': 'text/plain' })).status, 415);
  close();
});

test('the library endpoint lists what is on the shelf and where to listen', async () => {
  const { base, close } = await setup();
  const body = await (await fetch(`${base}/api/library`)).json();
  assert.deepEqual(body.books, [{ title: 'Book A', duration: 350, chapters: 3 }]);
  assert.equal(body.listenUrl, 'https://listen.example');
  assert.deepEqual(body.types, ['audiobook']);
  close();
});

test('unknown paths are a 404', async () => {
  const { base, close } = await setup();
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  close();
});

// --- Prowlarr search (read-only) ---

const fakeProwlarr = (search) => ({ search });
// Wait for a condition, but fail instead of hanging when it never comes true.
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const RELEASE = { title: 'Dracula', indexer: 'Internet Archive', size: 5, seeders: 2, age: 1, protocol: 'torrent' };

test('Prowlarr search returns what the Prowlarr client found', async () => {
  const asked = [];
  const { base, close } = await setup({ prowlarr: fakeProwlarr(async (q) => { asked.push(q); return [RELEASE]; }) });
  const res = await fetch(`${base}/api/prowlarr?q=dracula`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).results, [RELEASE]);
  assert.deepEqual(asked, ['dracula']);
  close();
});

test('Prowlarr search is a 404 when Prowlarr is not set up', async () => {
  const { base, close } = await setup();
  const res = await fetch(`${base}/api/prowlarr?q=dracula`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /not set up/i);
  close();
});

test('a Prowlarr failure is a 502 with its message', async () => {
  const { base, close } = await setup({ prowlarr: fakeProwlarr(async () => { throw new Error('Prowlarr is not responding. Try again in a minute.'); }) });
  const res = await fetch(`${base}/api/prowlarr?q=dracula`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /not responding/);
  close();
});

test('only two Prowlarr searches run at once, so friends cannot hammer the indexers', async () => {
  const gates = [];
  const { base, close } = await setup({ prowlarr: fakeProwlarr(() => new Promise((resolve) => gates.push(() => resolve([RELEASE])))) });
  const first = fetch(`${base}/api/prowlarr?q=one`);
  const second = fetch(`${base}/api/prowlarr?q=two`);
  await until(() => gates.length === 2, 'two searches to reach Prowlarr');
  const third = await fetch(`${base}/api/prowlarr?q=three`);
  assert.equal(third.status, 429);
  gates.forEach((open) => open());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  // The slots are free again once those finish.
  const fourth = fetch(`${base}/api/prowlarr?q=four`);
  await until(() => gates.length === 3, 'the next search to reach Prowlarr');
  gates[2]();
  assert.equal((await fourth).status, 200);
  close();
});

test('a failed Prowlarr search frees its slot', async () => {
  const { base, close } = await setup({ prowlarr: fakeProwlarr(async () => { throw new Error('down'); }) });
  for (let i = 0; i < 4; i++) assert.equal((await fetch(`${base}/api/prowlarr?q=x`)).status, 502);
  close();
});

test('the page is told whether Prowlarr search is available', async () => {
  const off = await setup();
  assert.equal((await (await fetch(`${off.base}/api/library`)).json()).prowlarr, false);
  off.close();
  const on = await setup({ prowlarr: fakeProwlarr(async () => []) });
  assert.equal((await (await fetch(`${on.base}/api/library`)).json()).prowlarr, true);
  on.close();
});

test('the page has a Prowlarr search form that starts hidden', async () => {
  const { base, close } = await setup();
  assert.match(await (await fetch(`${base}/`)).text(), /<section[^>]+id="prowlarr"[^>]+hidden/);
  close();
});

// --- movies and TV (through Seerr) ---

const MOVIE = { id: '841', title: 'Dune', author: '', detail: '1984', state: null };
function fakeSeerr({ search, request } = {}) {
  const asked = [];
  return {
    asked,
    search: search ?? (async (type, q) => { asked.push(['search', type, q]); return [MOVIE]; }),
    request: request ?? (async (type, id) => { asked.push(['request', type, id]); return { status: 'requested' }; }),
  };
}
const ask = (base, body, headers = {}) =>
  fetch(`${base}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the page is offered movies and TV only when Seerr is set up', async () => {
  const off = await setup();
  assert.deepEqual((await (await fetch(`${off.base}/api/library`)).json()).types, ['audiobook']);
  off.close();
  const on = await setup({ seerr: fakeSeerr() });
  assert.deepEqual((await (await fetch(`${on.base}/api/library`)).json()).types, ['audiobook', 'movie', 'tv']);
  on.close();
});

test('a movie search goes to Seerr and a book search still goes to the catalog', async () => {
  const seerr = fakeSeerr();
  const { base, close } = await setup({ seerr });
  assert.deepEqual((await (await fetch(`${base}/api/search?type=movie&q=dune`)).json()).results, [MOVIE]);
  assert.deepEqual(seerr.asked, [['search', 'movie', 'dune']]);
  assert.equal((await (await fetch(`${base}/api/search?type=audiobook&q=alice`)).json()).results[0].id, 'alice');
  assert.equal(seerr.asked.length, 1);
  close();
});

test('a movie search without Seerr is a 400', async () => {
  const { base, close } = await setup();
  assert.equal((await fetch(`${base}/api/search?type=movie&q=dune`)).status, 400);
  close();
});

test('a Seerr failure during search is a 502 with its message', async () => {
  const { base, close } = await setup({ seerr: fakeSeerr({ search: async () => { throw new Error('The request service is not responding.'); } }) });
  const res = await fetch(`${base}/api/search?type=tv&q=dune`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /not responding/);
  close();
});

test('requesting a movie files it with Seerr and says so', async () => {
  const seerr = fakeSeerr();
  const { base, close } = await setup({ seerr });
  const res = await ask(base, { type: 'movie', id: '841' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { state: 'requested' });
  assert.deepEqual(seerr.asked, [['request', 'movie', '841']]);
  close();
});

test('something already requested comes back as "exists"', async () => {
  const { base, close } = await setup({ seerr: fakeSeerr({ request: async () => ({ status: 'exists' }) }) });
  assert.deepEqual(await (await ask(base, { type: 'tv', id: '5' })).json(), { state: 'exists' });
  close();
});

test('a request Seerr refuses is a 502 with the reason', async () => {
  const { base, close } = await setup({ seerr: fakeSeerr({ request: async () => { throw new Error('The request was refused: Movie Quota exceeded.'); } }) });
  const res = await ask(base, { type: 'movie', id: '841' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Quota exceeded/);
  close();
});

test('requests are a 404 when Seerr is not set up', async () => {
  const { base, close } = await setup();
  assert.equal((await ask(base, { type: 'movie', id: '841' })).status, 404);
  close();
});

test('another site cannot file a request, and the body must be JSON', async () => {
  const seerr = fakeSeerr();
  const { base, close } = await setup({ seerr });
  assert.equal((await ask(base, { type: 'movie', id: '841' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/request`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(seerr.asked.length, 0);
  close();
});

test('one person can file 10 requests a day; the 11th waits, and other people are unaffected', async () => {
  let clock = 1_000_000;
  const seerr = fakeSeerr();
  const { base, close } = await setup({ seerr, now: () => clock });
  const as = (email) => ({ 'cf-access-authenticated-user-email': email });
  for (let i = 1; i <= 10; i++) assert.equal((await ask(base, { type: 'movie', id: String(i) }, as('a@example.com'))).status, 200);
  const eleventh = await ask(base, { type: 'movie', id: '11' }, as('a@example.com'));
  assert.equal(eleventh.status, 429);
  assert.match((await eleventh.json()).error, /10/);
  assert.equal(seerr.asked.length, 10); // the 11th never reached Seerr
  assert.equal((await ask(base, { type: 'movie', id: '11' }, as('b@example.com'))).status, 200);
  clock += 24 * 60 * 60 * 1000 + 1; // a day later the first person can ask again
  assert.equal((await ask(base, { type: 'movie', id: '11' }, as('a@example.com'))).status, 200);
  close();
});

test('requests that were refused or already existed do not use up the daily allowance', async () => {
  let fail = true;
  const seerr = fakeSeerr({ request: async () => { if (fail) throw new Error('refused'); return { status: 'exists' }; } });
  const { base, close } = await setup({ seerr });
  for (let i = 0; i < 12; i++) assert.equal((await ask(base, { type: 'movie', id: '1' })).status, 502);
  fail = false;
  for (let i = 0; i < 12; i++) assert.equal((await ask(base, { type: 'movie', id: '1' })).status, 200);
  close();
});

test('the page offers Movies and TV as kinds to search', async () => {
  const { base, close } = await setup();
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /name="type" value="movie"/);
  assert.match(html, /name="type" value="tv"/);
  close();
});
