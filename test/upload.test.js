import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createUploads } from '../src/portal/upload.js';

const HENRY = 'henry@example.com';
const bytes = (n, fill = 'a') => Buffer.alloc(n, fill);
const body = (...parts) => Readable.from(parts);

async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'upload-test-'));
  let clock = 1_000_000;
  const uploads = createUploads({ root, chunkBytes: 8, minFreeBytes: 0, now: () => clock, ...options });
  return {
    root,
    uploads,
    tick: (ms) => { clock += ms; },
    visible: async () => (await readdir(root)).filter((name) => !name.startsWith('.')),
    hidden: async () => (await readdir(root)).filter((name) => name.startsWith('.')),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const rejects = (promise, status, pattern) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.status, status, err.message);
    assert.match(err.message, pattern);
    return true;
  });

test('a book uploaded in chunks lands on the shelf only when it is finished', async () => {
  const { root, uploads, visible, hidden, cleanup } = await setup();
  const { id, chunkBytes } = await uploads.start({ title: 'Dracula', by: HENRY, files: [{ name: '01.mp3', size: 12 }, { name: '02.mp3', size: 3 }] });
  assert.equal(chunkBytes, 8);
  assert.deepEqual(await visible(), [], 'nothing visible while uploading');

  assert.deepEqual(await uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, body(bytes(8, 'a'))), { received: 8 });
  assert.deepEqual(await uploads.chunk({ id, file: 0, offset: 8, by: HENRY }, body(bytes(4, 'b'))), { received: 12 });
  assert.deepEqual(await uploads.chunk({ id, file: 1, offset: 0, by: HENRY }, body(bytes(3, 'c'))), { received: 3 });
  assert.deepEqual(await uploads.finish({ id, by: HENRY }), { status: 'added', title: 'Dracula' });

  assert.deepEqual(await visible(), ['Dracula']);
  assert.deepEqual(await hidden(), [], 'staging folder is gone');
  assert.equal(await readFile(join(root, 'Dracula', '01.mp3'), 'utf8'), 'aaaaaaaabbbb');
  assert.equal(await readFile(join(root, 'Dracula', '02.mp3'), 'utf8'), 'ccc');
  await cleanup();
});

test('titles and file names are reduced to safe single path segments', async () => {
  const { root, uploads, visible, cleanup } = await setup();
  const { id, files } = await uploads.start({ title: '../../etc: Evil?', by: HENRY, files: [{ name: '..\\..\\C:/x/Chapter 1.MP3', size: 1 }] });
  assert.deepEqual(files, ['Chapter 1.MP3']);
  await uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, body(bytes(1)));
  const { title } = await uploads.finish({ id, by: HENRY });
  assert.deepEqual(await visible(), [title]);
  assert.doesNotMatch(title, /[\\/:?]/);
  assert.deepEqual(await readdir(join(root, title)), ['Chapter 1.MP3']);
  await cleanup();
});

test('only audio files are accepted', async () => {
  const { uploads, cleanup } = await setup();
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'run.sh', size: 1 }] }), 400, /audio/i);
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'cover.jpg', size: 1 }] }), 400, /audio/i);
  await cleanup();
});

test('a start needs a title, at least one file, whole sizes and distinct names', async () => {
  const { uploads, cleanup } = await setup({ maxFiles: 2 });
  const file = { name: 'a.mp3', size: 1 };
  await rejects(uploads.start({ title: ' .. ', by: HENRY, files: [file] }), 400, /title/i);
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [] }), 400, /file/i);
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: 'nope' }), 400, /file/i);
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 0 }] }), 400, /size/i);
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 1.5 }] }), 400, /size/i);
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [file, { name: 'A.MP3', size: 1 }] }), 400, /same name/i);
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [file, { name: 'b.mp3', size: 1 }, { name: 'c.mp3', size: 1 }] }), 400, /too many/i);
  await cleanup();
});

test('a book over the size cap is refused before anything is written', async () => {
  const { uploads, hidden, cleanup } = await setup({ maxBytes: 10 });
  await rejects(uploads.start({ title: 'Big', by: HENRY, files: [{ name: 'a.mp3', size: 6 }, { name: 'b.mp3', size: 5 }] }), 413, /too large/i);
  assert.deepEqual(await hidden(), []);
  await cleanup();
});

test('a book is refused when the disk would drop below the free-space floor', async () => {
  const { uploads, cleanup } = await setup({ minFreeBytes: Number.MAX_SAFE_INTEGER });
  await rejects(uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 1 }] }), 507, /disk space/i);
  await cleanup();
});

test('a title already on the shelf is refused', async () => {
  const { root, uploads, cleanup } = await setup();
  await mkdir(join(root, 'Dracula'));
  await rejects(uploads.start({ title: 'Dracula', by: HENRY, files: [{ name: 'a.mp3', size: 1 }] }), 409, /already on the shelf/i);
  await cleanup();
});

test('chunks must arrive in order, and the reply says where to resume', async () => {
  const { uploads, cleanup } = await setup();
  const { id } = await uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 12 }] });
  await uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, body(bytes(8)));
  await assert.rejects(uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, body(bytes(8))), (err) => {
    assert.equal(err.status, 409);
    assert.deepEqual(err.extra, { received: 8 });
    return true;
  });
  assert.deepEqual(await uploads.chunk({ id, file: 0, offset: 8, by: HENRY }, body(bytes(4))), { received: 12 });
  await cleanup();
});

test('a chunk larger than the chunk size or the declared file is cut off and rolled back', async () => {
  const { root, uploads, hidden, cleanup } = await setup();
  const { id } = await uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 20 }, { name: 'b.mp3', size: 3 }] });
  await uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, body(bytes(8, 'a')));
  await rejects(uploads.chunk({ id, file: 0, offset: 8, by: HENRY }, body(bytes(6, 'x'), bytes(6, 'x'))), 413, /chunk/i);
  await rejects(uploads.chunk({ id, file: 1, offset: 0, by: HENRY }, body(bytes(4, 'x'))), 413, /larger than/i);

  const [staging] = await hidden();
  assert.equal(await readFile(join(root, staging, 'a.mp3'), 'utf8'), 'aaaaaaaa', 'the failed chunk left no bytes behind');
  assert.deepEqual(await uploads.chunk({ id, file: 0, offset: 8, by: HENRY }, body(bytes(8, 'b'))), { received: 16 });
  await cleanup();
});

test('a chunk whose connection breaks is rolled back so it can be sent again', async () => {
  const { root, uploads, hidden, cleanup } = await setup();
  const { id } = await uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 8 }] });
  const broken = new Readable({ read() { this.push(bytes(3, 'x')); this.destroy(new Error('socket hang up')); } });
  await assert.rejects(uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, broken));
  const [staging] = await hidden();
  assert.equal((await readFile(join(root, staging, 'a.mp3').toString())).length, 0);
  assert.deepEqual(await uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, body(bytes(8))), { received: 8 });
  await cleanup();
});

test('finishing early is refused and names the incomplete file', async () => {
  const { uploads, visible, cleanup } = await setup();
  const { id } = await uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 12 }] });
  await uploads.chunk({ id, file: 0, offset: 0, by: HENRY }, body(bytes(8)));
  await rejects(uploads.finish({ id, by: HENRY }), 400, /a\.mp3/);
  assert.deepEqual(await visible(), []);
  await cleanup();
});

test('an upload belongs to the person who started it', async () => {
  const { uploads, cleanup } = await setup();
  const { id } = await uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 1 }] });
  await rejects(uploads.chunk({ id, file: 0, offset: 0, by: 'someone@example.com' }, body(bytes(1))), 404, /upload/i);
  await rejects(uploads.finish({ id, by: 'someone@example.com' }), 404, /upload/i);
  await rejects(uploads.chunk({ id: 'nope', file: 0, offset: 0, by: HENRY }, body(bytes(1))), 404, /upload/i);
  await rejects(uploads.chunk({ id, file: 7, offset: 0, by: HENRY }, body(bytes(1))), 400, /file/i);
  await cleanup();
});

test('cancelling removes the staging folder', async () => {
  const { uploads, hidden, cleanup } = await setup();
  const { id } = await uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 1 }] });
  assert.equal((await hidden()).length, 1);
  await uploads.cancel({ id, by: HENRY });
  assert.deepEqual(await hidden(), []);
  await rejects(uploads.finish({ id, by: HENRY }), 404, /upload/i);
  await cleanup();
});

test('only a couple of uploads run at once, and an idle one gives up its place', async () => {
  const { uploads, tick, hidden, cleanup } = await setup({ maxActive: 1, idleMs: 60_000 });
  const file = [{ name: 'a.mp3', size: 1 }];
  const first = await uploads.start({ title: 'One', by: HENRY, files: file });
  await rejects(uploads.start({ title: 'Two', by: HENRY, files: file }), 429, /already/i);

  tick(61_000);
  const second = await uploads.start({ title: 'Two', by: HENRY, files: file });
  assert.equal((await hidden()).length, 1, 'the idle upload was cleaned up');
  await rejects(uploads.finish({ id: first.id, by: HENRY }), 404, /upload/i);
  await uploads.cancel({ id: second.id, by: HENRY });
  await cleanup();
});

test('leftovers from before a restart are swept, other dot-folders are left alone', async () => {
  const { root, uploads, hidden, cleanup } = await setup();
  await mkdir(join(root, '.incoming-upload-dead'));
  await writeFile(join(root, '.incoming-upload-dead', 'a.mp3'), 'x');
  await mkdir(join(root, '.incoming-abc123'));
  const live = await uploads.start({ title: 'Book', by: HENRY, files: [{ name: 'a.mp3', size: 1 }] });
  await uploads.sweep();
  const left = await hidden();
  assert.equal(left.length, 2);
  assert.ok(left.includes('.incoming-abc123'));
  assert.ok(!left.includes('.incoming-upload-dead'));
  await uploads.cancel({ id: live.id, by: HENRY });
  await cleanup();
});
