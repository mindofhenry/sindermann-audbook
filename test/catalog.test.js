import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../src/portal/catalog.js';

// Responses shaped like the real archive.org and Gutendex APIs.
const IA_SEARCH = { response: { numFound: 2, docs: [
  { identifier: 'adventures_holmes', title: 'The Adventures of Sherlock Holmes', creator: 'Sir Arthur Conan Doyle', runtime: '10:17:59' },
  { identifier: 'hound_baskervilles', title: 'The Hound of the Baskervilles', creator: ['Sir Arthur Conan Doyle', 'Someone Else'] },
] } };
const IA_ITEM = {
  metadata: { identifier: 'alice_in_wonderland_librivox', title: "Alice's Adventures in Wonderland, by Lewis Carroll", creator: 'Lewis Carroll', collection: ['librivoxaudio', 'audio_bookspoetry'] },
  files: [
    { name: 'wonderland_ch_02_64kb.mp3', format: '64Kbps MP3', size: '200' },
    { name: 'wonderland_ch_01.mp3', format: 'VBR MP3', size: '900' },
    { name: 'wonderland_ch_01_64kb.mp3', format: '64Kbps MP3', size: '100' },
    { name: 'cover.jpg', format: 'JPEG', size: '50' },
  ],
};
const GUTENDEX_SEARCH = { count: 3, results: [
  { id: 1342, title: 'Pride and Prejudice', authors: [{ name: 'Austen, Jane' }], copyright: false, formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/1342.epub3.images' } },
  { id: 9, title: 'Still In Copyright', authors: [{ name: 'Living, Author' }], copyright: true, formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/9.epub3.images' } },
  { id: 10, title: 'Audio Only', authors: [], copyright: false, formats: { 'audio/mpeg': 'https://www.gutenberg.org/x.mp3' } },
] };

function setup(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const hit = Object.entries(routes).find(([part]) => String(url).includes(part));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
  return { calls, catalog: createCatalog({ fetch }) };
}

test('audiobook search returns title, author and running time', async () => {
  const { catalog } = setup({ 'advancedsearch.php': IA_SEARCH });
  assert.deepEqual(await catalog.search('audiobook', 'sherlock holmes'), [
    { id: 'adventures_holmes', title: 'The Adventures of Sherlock Holmes', author: 'Sir Arthur Conan Doyle', detail: '10:17:59' },
    { id: 'hound_baskervilles', title: 'The Hound of the Baskervilles', author: 'Sir Arthur Conan Doyle', detail: '' },
  ]);
});

test('audiobook search only looks inside the public-domain LibriVox collection', async () => {
  const { calls, catalog } = setup({ 'advancedsearch.php': IA_SEARCH });
  await catalog.search('audiobook', 'sherlock');
  const url = new URL(calls[0]);
  assert.equal(url.hostname, 'archive.org');
  assert.match(url.searchParams.get('q'), /^collection:librivoxaudio AND /);
});

test('search punctuation cannot break out of the query', async () => {
  const { calls, catalog } = setup({ 'advancedsearch.php': IA_SEARCH });
  await catalog.search('audiobook', 'holmes) OR collection:(anything');
  assert.match(new URL(calls[0]).searchParams.get('q'), /^collection:librivoxaudio AND \(title:\(holmes OR collection anything\) OR creator:\(holmes OR collection anything\)\)$/);
});

test('a blank search returns nothing without calling out', async () => {
  const { calls, catalog } = setup({});
  assert.deepEqual(await catalog.search('audiobook', '   '), []);
  assert.equal(calls.length, 0);
});

test('an unknown catalog type is rejected', async () => {
  const { catalog } = setup({});
  await assert.rejects(catalog.search('movie', 'x'), /type/i);
});

test('an audiobook plan lists the 64 kbps chapter files in order', async () => {
  const { catalog } = setup({ '/metadata/alice_in_wonderland_librivox': IA_ITEM });
  const plan = await catalog.plan('audiobook', 'alice_in_wonderland_librivox');
  assert.equal(plan.title, "Alice's Adventures in Wonderland");
  assert.equal(plan.author, 'Lewis Carroll');
  assert.deepEqual(plan.files, [
    { name: 'wonderland_ch_01_64kb.mp3', url: 'https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_01_64kb.mp3', size: 100 },
    { name: 'wonderland_ch_02_64kb.mp3', url: 'https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_02_64kb.mp3', size: 200 },
  ]);
});

test('an audiobook plan falls back to the other mp3 set when there is no 64 kbps one', async () => {
  const item = { ...IA_ITEM, files: IA_ITEM.files.filter((f) => f.format !== '64Kbps MP3') };
  const { catalog } = setup({ '/metadata/': item });
  assert.deepEqual((await catalog.plan('audiobook', 'alice_in_wonderland_librivox')).files.map((f) => f.name), ['wonderland_ch_01.mp3']);
});

test('an item outside the LibriVox collection is refused', async () => {
  const item = { ...IA_ITEM, metadata: { ...IA_ITEM.metadata, collection: ['opensource_audio'] } };
  const { catalog } = setup({ '/metadata/': item });
  await assert.rejects(catalog.plan('audiobook', 'some_upload'), /public-domain/i);
});

test('a malformed id is refused before any request is made', async () => {
  const { calls, catalog } = setup({});
  await assert.rejects(catalog.plan('audiobook', '../../etc/passwd'), /id/i);
  await assert.rejects(catalog.plan('ebook', '12; rm -rf'), /id/i);
  assert.equal(calls.length, 0);
});

test('ebook search keeps only public-domain books that have an EPUB', async () => {
  const { catalog } = setup({ 'gutendex.com/books/?': GUTENDEX_SEARCH });
  assert.deepEqual(await catalog.search('ebook', 'pride'), [
    { id: '1342', title: 'Pride and Prejudice', author: 'Jane Austen', detail: 'EPUB' },
  ]);
});

test('an ebook plan is a single EPUB named after the book', async () => {
  const { catalog } = setup({ 'gutendex.com/books/1342/': GUTENDEX_SEARCH.results[0] });
  const plan = await catalog.plan('ebook', '1342');
  assert.equal(plan.title, 'Pride and Prejudice');
  assert.equal(plan.author, 'Jane Austen');
  assert.deepEqual(plan.files, [{ name: 'Pride and Prejudice.epub', url: 'https://www.gutenberg.org/ebooks/1342.epub3.images', size: null }]);
});

test('an ebook still in copyright is refused', async () => {
  const { catalog } = setup({ 'gutendex.com/books/9/': GUTENDEX_SEARCH.results[1] });
  await assert.rejects(catalog.plan('ebook', '9'), /public-domain/i);
});

test('a catalog outage surfaces as a readable error', async () => {
  const { catalog } = setup({});
  await assert.rejects(catalog.search('audiobook', 'x'), /catalog/i);
});
