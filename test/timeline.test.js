import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  locate,
  chapterIndexAt,
  nextChapterStart,
  prevChapterStart,
} from '../src/timeline.js';

// Three files, one chapter each: 100s, 200s, 50s.
const multiFile = () =>
  buildTimeline([
    { path: '/b/01.mp3', title: 'One', duration: 100, chapters: [] },
    { path: '/b/02.mp3', title: 'Two', duration: 200, chapters: [] },
    { path: '/b/03.mp3', title: 'Three', duration: 50, chapters: [] },
  ]);

// One m4b with three embedded chapters.
const singleFile = () =>
  buildTimeline([
    {
      path: '/b/book.m4b',
      title: 'Book',
      duration: 300,
      chapters: [
        { title: 'Intro', start: 0, end: 60 },
        { title: 'Middle', start: 60, end: 240 },
        { title: 'End', start: 240, end: 300 },
      ],
    },
  ]);

test('total duration is the sum of all files', () => {
  assert.equal(multiFile().duration, 350);
});

test('each file without embedded chapters becomes one chapter', () => {
  const tl = multiFile();
  assert.deepEqual(
    tl.chapters.map((c) => [c.title, c.start, c.end]),
    [
      ['One', 0, 100],
      ['Two', 100, 300],
      ['Three', 300, 350],
    ],
  );
});

test('embedded chapters in a single file are used as chapters', () => {
  const tl = singleFile();
  assert.deepEqual(
    tl.chapters.map((c) => [c.title, c.start, c.end]),
    [
      ['Intro', 0, 60],
      ['Middle', 60, 240],
      ['End', 240, 300],
    ],
  );
});

test('embedded chapters are offset by the files before them', () => {
  const tl = buildTimeline([
    { path: '/b/1.mp3', title: 'Part 1', duration: 100, chapters: [] },
    {
      path: '/b/2.m4b',
      title: 'Part 2',
      duration: 100,
      chapters: [
        { title: 'A', start: 0, end: 40 },
        { title: 'B', start: 40, end: 100 },
      ],
    },
  ]);
  assert.deepEqual(
    tl.chapters.map((c) => [c.title, c.start, c.end]),
    [
      ['Part 1', 0, 100],
      ['A', 100, 140],
      ['B', 140, 200],
    ],
  );
});

test('locate maps a book position to a file and an offset inside it', () => {
  const tl = multiFile();
  assert.deepEqual(locate(tl, 0), { fileIndex: 0, offset: 0 });
  assert.deepEqual(locate(tl, 150), { fileIndex: 1, offset: 50 });
  assert.deepEqual(locate(tl, 300), { fileIndex: 2, offset: 0 });
});

test('locate returns null at or past the end of the book', () => {
  const tl = multiFile();
  assert.equal(locate(tl, 350), null);
  assert.equal(locate(tl, 9999), null);
});

test('locate treats negative positions as the start', () => {
  assert.deepEqual(locate(multiFile(), -10), { fileIndex: 0, offset: 0 });
});

test('chapterIndexAt finds the chapter containing a position', () => {
  const tl = singleFile();
  assert.equal(chapterIndexAt(tl, 0), 0);
  assert.equal(chapterIndexAt(tl, 60), 1);
  assert.equal(chapterIndexAt(tl, 299), 2);
});

test('nextChapterStart jumps to the start of the following chapter', () => {
  assert.equal(nextChapterStart(singleFile(), 30), 60);
});

test('nextChapterStart returns null in the last chapter', () => {
  assert.equal(nextChapterStart(singleFile(), 250), null);
});

test('prevChapterStart restarts the current chapter when well into it', () => {
  assert.equal(prevChapterStart(singleFile(), 100), 60);
});

test('prevChapterStart goes to the previous chapter when near the chapter start', () => {
  assert.equal(prevChapterStart(singleFile(), 62), 0);
});

test('prevChapterStart stays at zero in the first chapter', () => {
  assert.equal(prevChapterStart(singleFile(), 2), 0);
});
