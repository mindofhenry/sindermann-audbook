import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLibrary } from './helpers/fixtures.js';
import { probeFile } from '../src/probe.js';
import { scanLibrary, findBook, searchBooks } from '../src/library.js';

let root;
let books;

before(async () => {
  root = makeLibrary();
  books = await scanLibrary(root);
});
after(() => rmSync(root, { recursive: true, force: true }));

const near = (actual, expected, tolerance = 0.15) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('probeFile reads duration and title tag from an mp3', async () => {
  const info = await probeFile(join(root, 'Multi Book', '1.mp3'));
  near(info.duration, 2);
  assert.equal(info.title, 'Opening');
  assert.deepEqual(info.chapters, []);
});

test('probeFile reads embedded chapters from an m4b', async () => {
  const info = await probeFile(join(root, 'Single Book.m4b'));
  assert.deepEqual(info.chapters.map((c) => c.title), ['Intro', 'Middle', 'End']);
  near(info.chapters[1].start, 2);
  near(info.chapters[1].end, 5);
});

test('probeFile rejects a file that is not audio', async () => {
  await assert.rejects(probeFile(join(root, 'readme.txt')));
});

test('scan finds folder books, nested books and single-file books, sorted by title', () => {
  assert.deepEqual(books.map((b) => b.title), ['Multi Book', 'Nested Book', 'Single Book']);
});

test('files inside a book are ordered naturally, so 10 comes after 2', () => {
  const multi = books.find((b) => b.title === 'Multi Book');
  assert.deepEqual(
    multi.timeline.files.map((f) => f.path.split('/').pop()),
    ['1.mp3', '2.mp3', '10.mp3'],
  );
});

test('chapter titles use the title tag, falling back to the file name', () => {
  const multi = books.find((b) => b.title === 'Multi Book');
  assert.deepEqual(multi.timeline.chapters.map((c) => c.title), ['Opening', '2', '10']);
});

test('a multi-file book has the combined duration of its files', () => {
  near(books.find((b) => b.title === 'Multi Book').timeline.duration, 6, 0.3);
});

test('a single m4b exposes its embedded chapters', () => {
  const single = books.find((b) => b.title === 'Single Book');
  assert.deepEqual(single.timeline.chapters.map((c) => c.title), ['Intro', 'Middle', 'End']);
});

test('book ids are stable across scans', async () => {
  const again = await scanLibrary(root);
  assert.deepEqual(again.map((b) => b.id), books.map((b) => b.id));
});

test('book ids are unique and short enough for a Discord choice value', () => {
  const ids = books.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.length <= 100));
});

test('findBook looks a book up by id', () => {
  assert.equal(findBook(books, books[0].id).title, books[0].title);
  assert.equal(findBook(books, 'nope'), null);
});

test('searchBooks matches titles case-insensitively', () => {
  assert.deepEqual(searchBooks(books, 'NEST').map((b) => b.title), ['Nested Book']);
});

test('searchBooks returns everything for an empty query', () => {
  assert.equal(searchBooks(books, '').length, 3);
});

test('a corrupt audio file is skipped without losing the rest of the book', async () => {
  writeFileSync(join(root, 'Multi Book', '3.mp3'), 'this is not an mp3');
  const warnings = [];
  const rescanned = await scanLibrary(root, { onWarning: (w) => warnings.push(w) });
  const multi = rescanned.find((b) => b.title === 'Multi Book');
  assert.equal(multi.timeline.files.length, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /3\.mp3/);
  rmSync(join(root, 'Multi Book', '3.mp3'));
});

test('scanning a missing folder yields an empty library', async () => {
  assert.deepEqual(await scanLibrary(join(root, 'does-not-exist')), []);
});
