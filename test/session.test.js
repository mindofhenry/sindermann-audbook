import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Session } from '../src/session.js';
import { FakeAudio, bookA as book } from './helpers/fakes.js';

function setup(options = {}) {
  const db = openDb(':memory:');
  const audio = new FakeAudio();
  const events = { finished: [], errors: [] };
  const session = new Session({
    guildId: 'g1',
    db,
    audio,
    onFinished: (b) => events.finished.push(b.id),
    onError: (message) => events.errors.push(message),
    ...options,
  });
  return { db, audio, session, events };
}

test('a book with no saved progress starts at the beginning', () => {
  const { audio, session } = setup();
  session.start(book());
  assert.deepEqual(audio.last, { path: '/b/1.mp3', offset: 0, speed: 1 });
  assert.equal(session.state, 'playing');
});

test('a book with saved progress resumes a few seconds before where it stopped', () => {
  const { db, audio, session } = setup({ rewind: 5 });
  db.saveProgress('g1', 'book-a', 150);
  session.start(book());
  assert.deepEqual(audio.last, { path: '/b/2.mp3', offset: 45, speed: 1 });
});

test('the resume rewind never goes before the start of the book', () => {
  const { db, audio, session } = setup({ rewind: 5 });
  db.saveProgress('g1', 'book-a', 2);
  session.start(book());
  assert.equal(audio.last.offset, 0);
});

test('a finished book starts over from the beginning', () => {
  const { db, audio, session } = setup();
  db.saveProgress('g1', 'book-a', 350);
  session.start(book());
  assert.deepEqual(audio.last, { path: '/b/1.mp3', offset: 0, speed: 1 });
});

test('starting uses the speed saved for the server', () => {
  const { db, audio, session } = setup();
  db.setSpeed('g1', 1.5);
  session.start(book());
  assert.equal(audio.last.speed, 1.5);
});

test('position follows the audio that has been played', () => {
  const { audio, session } = setup();
  session.start(book());
  audio.advance(10);
  assert.equal(session.position(), 10);
});

test('position moves faster than real time at higher speed', () => {
  const { db, audio, session } = setup();
  db.setSpeed('g1', 2);
  session.start(book());
  audio.advance(10);
  assert.equal(session.position(), 20);
});

test('when a file ends the next file starts from its beginning', () => {
  const { audio, session } = setup();
  session.start(book());
  audio.advance(99.9); // encoders rarely land exactly on the probed duration
  audio.endOfFile();
  assert.deepEqual(audio.last, { path: '/b/2.mp3', offset: 0, speed: 1 });
  assert.equal(session.position(), 100);
});

test('when the last file ends the book is marked finished', () => {
  const { db, audio, session, events } = setup();
  session.start(book(), { position: 320 });
  audio.endOfFile();
  assert.equal(session.state, 'idle');
  assert.equal(db.getProgress('g1', 'book-a').position, 350);
  assert.deepEqual(events.finished, ['book-a']);
});

test('a file that fails to play stops the session and keeps the position', () => {
  const { db, audio, session, events } = setup();
  session.start(book(), { position: 120 });
  audio.endOfFile(false);
  assert.equal(session.state, 'idle');
  assert.equal(audio.requests.length, 1, 'must not skip ahead to the next file');
  assert.equal(db.getProgress('g1', 'book-a').position, 120);
  assert.equal(events.errors.length, 1);
});

test('pause saves the position and resume carries on from it', () => {
  const { db, audio, session } = setup();
  session.start(book());
  audio.advance(30);
  assert.equal(session.pause(), true);
  assert.equal(audio.paused, true);
  assert.equal(session.state, 'paused');
  assert.equal(db.getProgress('g1', 'book-a').position, 30);

  assert.equal(session.resume(), true);
  assert.equal(audio.paused, false);
  assert.equal(session.state, 'playing');
  assert.equal(session.position(), 30);
});

test('pause and resume report false when there is nothing to do', () => {
  const { session } = setup();
  assert.equal(session.pause(), false);
  assert.equal(session.resume(), false);
});

test('seek jumps to the right file and offset', () => {
  const { audio, session } = setup();
  session.start(book());
  session.seek(310);
  assert.deepEqual(audio.last, { path: '/b/3.mp3', offset: 10, speed: 1 });
  assert.equal(session.position(), 310);
});

test('seek while paused starts playing again', () => {
  const { session } = setup();
  session.start(book());
  session.pause();
  session.seek(50);
  assert.equal(session.state, 'playing');
});

test('skipping back past the start lands on zero', () => {
  const { audio, session } = setup();
  session.start(book());
  audio.advance(20);
  session.skip(-30);
  assert.equal(session.position(), 0);
});

test('skipping forward past the end finishes the book', () => {
  const { session, events } = setup();
  session.start(book(), { position: 340 });
  session.skip(30);
  assert.equal(session.state, 'idle');
  assert.deepEqual(events.finished, ['book-a']);
});

test('next chapter jumps to the start of the following chapter', () => {
  const { audio, session } = setup();
  session.start(book());
  audio.advance(40);
  const chapter = session.nextChapter();
  assert.equal(chapter.title, 'Two');
  assert.equal(session.position(), 100);
});

test('next chapter in the last chapter changes nothing', () => {
  const { audio, session } = setup();
  session.start(book(), { position: 320 });
  const before = audio.requests.length;
  assert.equal(session.nextChapter(), null);
  assert.equal(audio.requests.length, before);
});

test('previous chapter restarts the current chapter when well into it', () => {
  const { audio, session } = setup();
  session.start(book(), { position: 150 });
  audio.advance(1);
  assert.equal(session.prevChapter().title, 'Two');
  assert.equal(session.position(), 100);
});

test('previous chapter goes back one chapter when at the chapter start', () => {
  const { session } = setup();
  session.start(book(), { position: 102 });
  assert.equal(session.prevChapter().title, 'One');
  assert.equal(session.position(), 0);
});

test('goToChapter jumps by chapter number and rejects numbers out of range', () => {
  const { session } = setup();
  session.start(book());
  assert.equal(session.goToChapter(2).title, 'Three');
  assert.equal(session.position(), 300);
  assert.equal(session.goToChapter(3), null);
  assert.equal(session.goToChapter(-1), null);
});

test('changing speed keeps the place and is remembered for the server', () => {
  const { db, audio, session } = setup();
  session.start(book());
  audio.advance(60);
  session.setSpeed(1.5);
  assert.deepEqual(audio.last, { path: '/b/1.mp3', offset: 60, speed: 1.5 });
  assert.equal(db.getSpeed('g1'), 1.5);
});

test('changing speed while paused stays paused at the same place', () => {
  const { audio, session } = setup();
  session.start(book());
  audio.advance(60);
  session.pause();
  session.setSpeed(2);
  assert.equal(session.state, 'paused');
  assert.equal(audio.paused, true);
  assert.equal(session.position(), 60);
});

test('save writes the current position', () => {
  const { db, audio, session } = setup();
  session.start(book());
  audio.advance(12);
  session.save();
  assert.equal(db.getProgress('g1', 'book-a').position, 12);
});

test('stop saves the position and releases the audio', () => {
  const { db, audio, session } = setup();
  session.start(book());
  audio.advance(25);
  session.stop();
  assert.equal(audio.stopped, true);
  assert.equal(session.state, 'idle');
  assert.equal(session.book, null);
  assert.equal(db.getProgress('g1', 'book-a').position, 25);
});

test('status describes the book, chapter and position', () => {
  const { audio, session } = setup();
  session.start(book(), { position: 100 });
  audio.advance(20);
  const s = session.status();
  assert.equal(s.book.title, 'Book A');
  assert.equal(s.position, 120);
  assert.equal(s.duration, 350);
  assert.equal(s.chapterIndex, 1);
  assert.equal(s.chapter.title, 'Two');
  assert.equal(s.chapterCount, 3);
  assert.equal(s.state, 'playing');
  assert.equal(s.speed, 1);
});

test('status is null when nothing is loaded', () => {
  assert.equal(setup().session.status(), null);
});
