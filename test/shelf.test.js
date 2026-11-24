import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addToShelf, folderFor } from '../src/portal/shelf.js';

let server;
let base;
let hits;
before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/a.mp3') return res.end('AAAA');
    if (req.url === '/b.mp3') return res.end('BBBBBB');
    if (req.url === '/big.mp3') return res.end('X'.repeat(5000));
    if (req.url === '/hop') { res.writeHead(302, { location: `${base}/a.mp3` }); return res.end(); }
    if (req.url === '/escape') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); return res.end(); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function setup() {
  hits = [];
  const root = mkdtempSync(join(tmpdir(), 'abbot-shelf-'));
  const options = { allowedHosts: ['127.0.0.1'], maxBytes: 1000, minFreeBytes: 0 };
  const plan = (files, title = 'My Book') => ({ title, author: 'A', files: files.map((f) => ({ name: f.split('/').pop(), url: `${base}${f}`, size: null })) });
  return { root, options, plan, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a book is downloaded into a folder named after its title', async () => {
  const { root, options, plan, cleanup } = setup();
  const result = await addToShelf(plan(['/a.mp3', '/b.mp3']), root, options);
  assert.equal(result.status, 'added');
  assert.deepEqual(readdirSync(join(root, 'My Book')).sort(), ['a.mp3', 'b.mp3']);
  assert.equal(readFileSync(join(root, 'My Book', 'b.mp3'), 'utf8'), 'BBBBBB');
  cleanup();
});

test('a book already on the shelf is not downloaded again', async () => {
  const { root, options, plan, cleanup } = setup();
  mkdirSync(join(root, 'My Book'));
  const result = await addToShelf(plan(['/a.mp3']), root, options);
  assert.equal(result.status, 'exists');
  assert.deepEqual(hits, []);
  cleanup();
});

test('titles and file names cannot place files outside the shelf', async () => {
  const { root, options, cleanup } = setup();
  const sneaky = { title: '../../outside/..', author: 'A', files: [{ name: '../../../evil.mp3', url: `${base}/a.mp3`, size: null }] };
  await addToShelf(sneaky, root, options);
  const folder = folderFor(sneaky);
  assert.ok(!folder.includes('/') && !folder.startsWith('.'), folder);
  assert.deepEqual(readdirSync(join(root, folder)), ['evil.mp3']);
  assert.equal(existsSync(join(root, '..', 'evil.mp3')), false);
  cleanup();
});

test('a redirect within the allowed hosts is followed', async () => {
  const { root, options, cleanup } = setup();
  await addToShelf({ title: 'Hop', author: 'A', files: [{ name: 'a.mp3', url: `${base}/hop`, size: null }] }, root, options);
  assert.equal(readFileSync(join(root, 'Hop', 'a.mp3'), 'utf8'), 'AAAA');
  cleanup();
});

test('a redirect to a host that is not allowed is refused and leaves nothing behind', async () => {
  const { root, options, cleanup } = setup();
  await assert.rejects(addToShelf({ title: 'Escape', author: 'A', files: [{ name: 'a.mp3', url: `${base}/escape`, size: null }] }, root, options), /not allowed/i);
  assert.deepEqual(readdirSync(root), []);
  cleanup();
});

test('a download from a host that is not allowed is refused', async () => {
  const { root, options, cleanup } = setup();
  await assert.rejects(addToShelf({ title: 'Other', author: 'A', files: [{ name: 'a.mp3', url: 'http://example.org/a.mp3', size: null }] }, root, options), /not allowed/i);
  cleanup();
});

test('a book over the size limit is stopped and leaves nothing behind', async () => {
  const { root, options, plan, cleanup } = setup();
  await assert.rejects(addToShelf(plan(['/a.mp3', '/big.mp3'], 'Huge'), root, options), /too large/i);
  assert.deepEqual(readdirSync(root), []);
  cleanup();
});

test('a book whose listed size is over the limit is refused before downloading', async () => {
  const { root, options, cleanup } = setup();
  const plan = { title: 'Listed', author: 'A', files: [{ name: 'a.mp3', url: `${base}/a.mp3`, size: 99999 }] };
  await assert.rejects(addToShelf(plan, root, options), /too large/i);
  assert.deepEqual(hits, []);
  cleanup();
});

test('a failed file download leaves nothing behind', async () => {
  const { root, options, plan, cleanup } = setup();
  await assert.rejects(addToShelf(plan(['/a.mp3', '/missing.mp3'], 'Broken'), root, options), /404/);
  assert.deepEqual(readdirSync(root), []);
  cleanup();
});

test('a book is refused when the disk would be left too full', async () => {
  const { root, options, plan, cleanup } = setup();
  await assert.rejects(addToShelf(plan(['/a.mp3']), root, { ...options, minFreeBytes: Number.MAX_SAFE_INTEGER }), /disk/i);
  cleanup();
});

test('a plan with no files is refused', async () => {
  const { root, options, cleanup } = setup();
  await assert.rejects(addToShelf({ title: 'Empty', author: 'A', files: [] }, root, options), /no files/i);
  cleanup();
});
