import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildTimeline } from '../src/timeline.js';
import { definitions, createCommands } from '../src/commands.js';
import { bookA, bookB, fakeSessions, interaction } from './helpers/fakes.js';

function setup({ books = [bookA(), bookB()], shelfUrl } = {}) {
  const db = openDb(':memory:');
  const sessions = fakeSessions(db);
  const library = {
    books,
    rescans: 0,
    async rescan() { this.rescans += 1; return { count: this.books.length, warnings: [] }; },
  };
  const commands = createCommands({ db, sessions, library, shelfUrl });
  const run = (name, options, extra) => commands.execute(interaction(name, options, extra));
  return { db, sessions, library, commands, run };
}

// Starts Book A and returns the pieces a test usually pokes at.
async function playing(position) {
  const ctx = setup();
  if (position !== undefined) ctx.db.saveProgress('g1', 'book-a', position + 5); // +5 cancels the resume rewind
  await ctx.run('play', { book: 'book-a' });
  return { ...ctx, session: ctx.sessions.get('g1'), audio: ctx.sessions.audio('g1') };
}

test('every command is registered once with a valid definition', () => {
  const names = definitions.map((d) => d.name).sort();
  assert.deepEqual(names, [
    'back', 'bookmark', 'chapter', 'chapters', 'forward', 'help', 'library', 'next', 'nowplaying',
    'pause', 'play', 'prev', 'rescan', 'resume', 'seek', 'speed', 'stop',
  ]);
  assert.ok(definitions.every((d) => d.description.length > 0 && d.description.length <= 100));
});

test('commands refuse to run outside a server', async () => {
  const { run } = setup();
  assert.match(await run('nowplaying', {}, { guildId: null }), /server/i);
});

// --- play / resume / stop -------------------------------------------------

test('play asks the user to join a voice channel first', async () => {
  const { run, sessions } = setup();
  assert.match(await run('play', { book: 'book-a' }, { inVoice: false }), /join a voice channel/i);
  assert.equal(sessions.get('g1'), null);
});

test('play starts the chosen book and says what is playing', async () => {
  const { run, sessions } = setup();
  const reply = await run('play', { book: 'book-a' });
  assert.match(reply, /Book A/);
  assert.match(reply, /Chapter 1\/3/);
  assert.equal(sessions.audio('g1').last.path, '/b/1.mp3');
});

test('play accepts a typed title when it matches exactly one book', async () => {
  const { run, sessions } = setup();
  await run('play', { book: 'second' });
  assert.equal(sessions.get('g1').book.id, 'book-b');
});

test('play lists the candidates when a typed title matches several books', async () => {
  const { run, sessions } = setup();
  const reply = await run('play', { book: 'o' }); // "Book A" and "Second Story"
  assert.match(reply, /Book A/);
  assert.match(reply, /Second Story/);
  assert.equal(sessions.get('g1'), null);
});

test('play reports a book that is not in the library', async () => {
  const { run } = setup();
  assert.match(await run('play', { book: 'missing' }), /couldn't find/i);
});

test('play resumes from the saved position', async () => {
  const { session } = await playing(150);
  assert.equal(session.position(), 150);
});

test('resume continues a paused book', async () => {
  const { run, session } = await playing();
  await run('pause');
  assert.match(await run('resume'), /Book A/);
  assert.equal(session.state, 'playing');
});

test('resume with nothing loaded picks up the most recent book', async () => {
  const { run, db, sessions } = setup();
  db.saveProgress('g1', 'book-b', 400);
  const reply = await run('resume');
  assert.match(reply, /Second Story/);
  assert.equal(sessions.get('g1').book.id, 'book-b');
});

test('resume with no history points to /play', async () => {
  const { run } = setup();
  assert.match(await run('resume'), /\/play/);
});

test('resume skips a remembered book that has left the library', async () => {
  const { run, db } = setup();
  db.saveProgress('g1', 'deleted-book', 400);
  assert.match(await run('resume'), /\/play/);
});

test('pause reports when nothing is playing', async () => {
  const { run } = setup();
  assert.match(await run('pause'), /nothing is playing/i);
});

test('pause pauses and shows where it stopped', async () => {
  const { run, session, audio } = await playing();
  audio.advance(65);
  const reply = await run('pause');
  assert.equal(session.state, 'paused');
  assert.match(reply, /1:05/);
});

test('stop saves the position and leaves the voice channel', async () => {
  const { run, db, audio, sessions } = await playing();
  audio.advance(42);
  const reply = await run('stop');
  assert.equal(db.getProgress('g1', 'book-a').position, 42);
  assert.deepEqual(sessions.left, ['g1']);
  assert.match(reply, /0:42/);
});

// --- navigation -----------------------------------------------------------

test('next moves to the following chapter', async () => {
  const { run, session } = await playing();
  assert.match(await run('next'), /Chapter 2\/3/);
  assert.equal(session.position(), 100);
});

test('next in the last chapter says so and keeps playing', async () => {
  const { run, session } = await playing(320);
  assert.match(await run('next'), /last chapter/i);
  assert.equal(session.position(), 320);
});

test('prev goes back to the start of the chapter', async () => {
  const { run, session } = await playing(150);
  assert.match(await run('prev'), /Chapter 2\/3/);
  assert.equal(session.position(), 100);
});

test('chapter jumps to a chapter by its 1-based number', async () => {
  const { run, session } = await playing();
  assert.match(await run('chapter', { number: 3 }), /Chapter 3\/3/);
  assert.equal(session.position(), 300);
});

test('chapter rejects a number outside the book', async () => {
  const { run, session } = await playing();
  assert.match(await run('chapter', { number: 4 }), /1.*3/);
  assert.equal(session.position(), 0);
});

test('chapters lists every chapter and marks the current one', async () => {
  const { run } = await playing(150);
  const reply = await run('chapters');
  assert.match(reply, /1\. One/);
  assert.match(reply, /→ 2\. Two/);
  assert.match(reply, /3\. Three/);
});

test('chapters stays inside Discord\'s message limit for a very long book', async () => {
  const tracks = Array.from({ length: 400 }, (_, i) => ({
    path: `/long/${i}.mp3`, title: `Chapter ${i + 1}: a fairly descriptive chapter title`, duration: 600, chapters: [],
  }));
  const long = { id: 'long', title: 'Long Book', timeline: buildTimeline(tracks) };
  const { run, db } = setup({ books: [long] });
  db.saveProgress('g1', 'long', 600 * 250 + 30);
  await run('play', { book: 'long' });
  const reply = await run('chapters');
  assert.ok(reply.length <= 2000, `reply is ${reply.length} chars`);
  assert.match(reply, /→ 251\./);
});

test('back rewinds 30 seconds by default', async () => {
  const { run, session } = await playing(150);
  await run('back');
  assert.equal(session.position(), 120);
});

test('forward skips ahead by the requested seconds', async () => {
  const { run, session } = await playing(150);
  await run('forward', { seconds: 45 });
  assert.equal(session.position(), 195);
});

test('seek jumps to a typed time', async () => {
  const { run, session } = await playing();
  assert.match(await run('seek', { time: '2:30' }), /2:30/);
  assert.equal(session.position(), 150);
});

test('seek explains the accepted formats when the time is unreadable', async () => {
  const { run, session } = await playing(150);
  assert.match(await run('seek', { time: 'halfway' }), /1:23:45/);
  assert.equal(session.position(), 150);
});

test('seek refuses a time past the end of the book', async () => {
  const { run, session } = await playing(150);
  assert.match(await run('seek', { time: '10:00' }), /5:50/);
  assert.equal(session.state, 'playing');
});

test('navigation commands report when nothing is loaded', async () => {
  const { run } = setup();
  for (const name of ['next', 'prev', 'chapters', 'back', 'forward', 'nowplaying']) {
    assert.match(await run(name), /nothing is playing/i, name);
  }
});

test('speed changes the playback rate', async () => {
  const { run, session, audio } = await playing();
  assert.match(await run('speed', { rate: 1.5 }), /1\.5x/);
  assert.equal(session.speed, 1.5);
  assert.equal(audio.last.speed, 1.5);
});

test('speed is remembered even when nothing is playing', async () => {
  const { run, db } = setup();
  await run('speed', { rate: 1.25 });
  assert.equal(db.getSpeed('g1'), 1.25);
});

test('nowplaying shows book, chapter, position and total length', async () => {
  const { run } = await playing(150);
  const reply = await run('nowplaying');
  assert.match(reply, /Book A/);
  assert.match(reply, /Chapter 2\/3: Two/);
  assert.match(reply, /2:30 \/ 5:50/);
});

// --- bookmarks ------------------------------------------------------------

test('bookmark add saves the current position with the given label', async () => {
  const { run, db } = await playing(150);
  assert.match(await run('bookmark', { label: 'the twist' }, { subcommand: 'add' }), /the twist/);
  assert.deepEqual(
    db.listBookmarks('g1', 'book-a').map((b) => [b.label, b.position, b.userId]),
    [['the twist', 150, 'u1']],
  );
});

test('bookmark add without a label uses the chapter title', async () => {
  const { run, db } = await playing(150);
  await run('bookmark', {}, { subcommand: 'add' });
  assert.equal(db.listBookmarks('g1', 'book-a')[0].label, 'Two');
});

test('bookmark list shows each bookmark with its time', async () => {
  const { run } = await playing(150);
  await run('bookmark', { label: 'the twist' }, { subcommand: 'add' });
  const reply = await run('bookmark', {}, { subcommand: 'list' });
  assert.match(reply, /the twist/);
  assert.match(reply, /2:30/);
});

test('bookmark list says when the book has none', async () => {
  const { run } = await playing();
  assert.match(await run('bookmark', {}, { subcommand: 'list' }), /no bookmarks/i);
});

test('bookmark goto jumps to the saved spot', async () => {
  const { run, db, session } = await playing(150);
  await run('bookmark', { label: 'here' }, { subcommand: 'add' });
  const id = db.listBookmarks('g1', 'book-a')[0].id;
  await run('seek', { time: '0:10' });
  await run('bookmark', { bookmark: id }, { subcommand: 'goto' });
  assert.equal(session.position(), 150);
});

test('bookmark goto rejects a bookmark from another book', async () => {
  const { run, db, session } = await playing(150);
  const id = db.addBookmark({ guildId: 'g1', bookId: 'book-b', position: 900, label: 'elsewhere', userId: 'u1' });
  assert.match(await run('bookmark', { bookmark: id }, { subcommand: 'goto' }), /couldn't find/i);
  assert.equal(session.position(), 150);
});

test('bookmark remove deletes the bookmark', async () => {
  const { run, db } = await playing(150);
  await run('bookmark', { label: 'here' }, { subcommand: 'add' });
  const id = db.listBookmarks('g1', 'book-a')[0].id;
  assert.match(await run('bookmark', { bookmark: id }, { subcommand: 'remove' }), /removed/i);
  assert.deepEqual(db.listBookmarks('g1', 'book-a'), []);
});

test('bookmark commands need a loaded book', async () => {
  const { run } = setup();
  assert.match(await run('bookmark', {}, { subcommand: 'add' }), /nothing is playing/i);
});

// --- library --------------------------------------------------------------

test('library lists books with length and progress', async () => {
  const { run, db } = setup();
  db.saveProgress('g1', 'book-b', 500);
  const reply = await run('library');
  assert.match(reply, /Book A.*5:50/);
  assert.match(reply, /Second Story.*16:40.*50%/);
});

test('library explains how to add books when it is empty', async () => {
  const { run } = setup({ books: [] });
  assert.match(await run('library'), /no books/i);
});

test('library stays inside Discord\'s message limit for a big collection', async () => {
  const books = Array.from({ length: 300 }, (_, i) => ({ ...bookB(), id: `b${i}`, title: `A Long Descriptive Book Title Number ${i}` }));
  const { run } = setup({ books });
  const reply = await run('library');
  assert.ok(reply.length <= 2000, `reply is ${reply.length} chars`);
  assert.match(reply, /300/);
});

test('rescan reloads the library and reports the count', async () => {
  const { run, library } = setup();
  assert.match(await run('rescan'), /2 books/);
  assert.equal(library.rescans, 1);
});

// --- autocomplete ---------------------------------------------------------

test('book autocomplete filters by what the user typed', async () => {
  const { commands } = setup();
  const choices = commands.autocomplete(interaction('play', {}, { focused: 'sec' }));
  assert.deepEqual(choices, [{ name: 'Second Story', value: 'book-b' }]);
});

test('book autocomplete never returns more than Discord\'s 25 choices or over-long names', async () => {
  const books = Array.from({ length: 60 }, (_, i) => ({ ...bookB(), id: `b${i}`, title: `${'Very Long Title '.repeat(10)}${i}` }));
  const { commands } = setup({ books });
  const choices = commands.autocomplete(interaction('play', {}, { focused: '' }));
  assert.equal(choices.length, 25);
  assert.ok(choices.every((c) => c.name.length <= 100));
});

test('bookmark autocomplete offers the bookmarks of the loaded book', async () => {
  const { run, commands, db } = await playing(150);
  await run('bookmark', { label: 'the twist' }, { subcommand: 'add' });
  const id = db.listBookmarks('g1', 'book-a')[0].id;
  const choices = commands.autocomplete(interaction('bookmark', {}, { subcommand: 'goto', focused: '' }));
  assert.deepEqual(choices, [{ name: '2:30 the twist', value: id }]);
});

// --- chapter picker ---------------------------------------------------------

// A 120-chapter book, playing, parked on the given chapter number.
async function longBook(onChapter = 1) {
  const timeline = buildTimeline(Array.from({ length: 120 }, (_, i) => ({
    path: `/long/${i}.mp3`, title: `Part ${i + 1}`, duration: 600, chapters: [],
  })));
  const ctx = setup({ books: [{ id: 'long', title: 'Long Book', timeline }] });
  await ctx.run('play', { book: 'long' });
  if (onChapter > 1) await ctx.run('chapter', { number: onChapter });
  const pick = (focused) => ctx.commands.autocomplete(interaction('chapter', {}, { focused }));
  return { ...ctx, pick };
}

test('the chapter option offers a picker instead of asking for a bare number', () => {
  const option = definitions.find((d) => d.name === 'chapter').options[0];
  assert.equal(option.autocomplete, true);
  assert.equal(option.type, 4); // still an integer, so typing 12 keeps working
});

test('the chapter picker lists every chapter by number and title, marking the current one', async () => {
  const { commands } = await playing(150); // 150s is inside chapter Two
  assert.deepEqual(commands.autocomplete(interaction('chapter', {}, { focused: '' })), [
    { name: '1. One', value: 1 },
    { name: '2. Two (playing now)', value: 2 },
    { name: '3. Three', value: 3 },
  ]);
});

test('picking a chapter from the picker jumps to it', async () => {
  const { run, commands } = await playing(0);
  const choice = commands.autocomplete(interaction('chapter', {}, { focused: 'thr' }))[0];
  assert.match(await run('chapter', { number: choice.value }), /Chapter 3\/3: Three/);
});

test('typing part of a title narrows the chapter picker', async () => {
  const { commands } = await playing(0);
  assert.deepEqual(commands.autocomplete(interaction('chapter', {}, { focused: 'TW' })), [{ name: '2. Two', value: 2 }]);
});

test('typing a number puts that chapter first, then the numbers that start with it', async () => {
  const { pick } = await longBook();
  assert.deepEqual(pick('12').map((c) => c.value), [12, 120, 112]);
});

test('a long book shows 25 chapters around the current one when nothing is typed', async () => {
  const { pick } = await longBook(50);
  const values = pick('').map((c) => c.value);
  assert.equal(values.length, 25);
  assert.equal(values[0], 48); // two before, so going back a little is one click
  assert.equal(values.at(-1), 72);
});

test('near the end of a long book the picker still fills all 25 slots', async () => {
  const { pick } = await longBook(119);
  const values = pick('').map((c) => c.value);
  assert.deepEqual([values[0], values.at(-1), values.length], [96, 120, 25]);
});

test('the chapter picker never exceeds 25 choices or 100-character names', async () => {
  const timeline = buildTimeline(Array.from({ length: 40 }, (_, i) => ({
    path: `/w/${i}.mp3`, title: `${'A very wordy chapter title '.repeat(6)}${i + 1}`, duration: 60, chapters: [],
  })));
  const ctx = setup({ books: [{ id: 'wordy', title: 'Wordy', timeline }] });
  await ctx.run('play', { book: 'wordy' });
  const choices = ctx.commands.autocomplete(interaction('chapter', {}, { focused: 'wordy' }));
  assert.equal(choices.length, 25);
  assert.ok(choices.every((c) => c.name.length <= 100));
});

test('the chapter picker is empty when no book is loaded', () => {
  const { commands } = setup();
  assert.deepEqual(commands.autocomplete(interaction('chapter', {}, { focused: '' })), []);
});

// --- chapter picker with nothing loaded (for example after the bot restarts) ---

// Listened to Book A up to 150s (inside chapter Two), then stopped. Nothing is loaded now.
async function stoppedMidBook() {
  const ctx = await playing(150);
  await ctx.run('stop');
  assert.equal(ctx.sessions.get('g1'), null);
  return ctx;
}

test('with nothing loaded the chapter picker offers the last book, marking where you left off', async () => {
  const { commands } = await stoppedMidBook();
  assert.deepEqual(commands.autocomplete(interaction('chapter', {}, { focused: '' })), [
    { name: '1. One', value: 1 },
    { name: '2. Two (left off here)', value: 2 },
    { name: '3. Three', value: 3 },
  ]);
});

test('with nothing loaded /chapter starts the last book at the chosen chapter', async () => {
  const { run, sessions } = await stoppedMidBook();
  const reply = await run('chapter', { number: 3 });
  assert.match(reply, /Book A/);
  assert.match(reply, /Chapter 3\/3: Three/);
  assert.equal(sessions.get('g1').position(), 300); // the start of chapter Three, not the saved 150s
});

test('with nothing loaded /chapter needs you in a voice channel', async () => {
  const { run, sessions } = await stoppedMidBook();
  assert.match(await run('chapter', { number: 3 }, { inVoice: false }), /join a voice channel/i);
  assert.equal(sessions.get('g1'), null);
});

test('with nothing loaded a chapter number outside the last book is refused without joining', async () => {
  const { run, sessions } = await stoppedMidBook();
  assert.match(await run('chapter', { number: 9 }), /1 to 3/);
  assert.equal(sessions.get('g1'), null);
});

test('before any book has been played /chapter has nothing to offer', async () => {
  const { run, commands } = setup();
  assert.deepEqual(commands.autocomplete(interaction('chapter', {}, { focused: '' })), []);
  assert.match(await run('chapter', { number: 1 }), /nothing is playing/i);
});

// --- help -----------------------------------------------------------------

test('help names every command, so a new command cannot be left out of it', async () => {
  const { run } = setup();
  const reply = await run('help');
  for (const { name } of definitions) assert.match(reply, new RegExp(`/${name}\\b`), `/${name} is missing from /help`);
  assert.ok(reply.length <= 2000, `help is ${reply.length} characters, over Discord's limit`);
});

test('help starts with how to get a book playing', async () => {
  const { run } = setup();
  const reply = await run('help');
  assert.match(reply, /voice channel/i);
  assert.ok(reply.indexOf('/play') < reply.indexOf('/bookmark'), 'the basics come before the extras');
});

test('help works with nothing playing and without being in voice', async () => {
  const { run, sessions } = setup();
  assert.match(await run('help', {}, { inVoice: false }), /\/play/);
  assert.equal(sessions.get('g1'), null);
});

test('help links the shelf only when its address is set', async () => {
  assert.doesNotMatch(await setup().run('help'), /https?:/);
  const reply = await setup({ shelfUrl: 'https://friends.example' }).run('help');
  assert.match(reply, /<https:\/\/friends\.example>/, 'angle brackets stop Discord from adding a preview card');
  assert.ok(reply.length <= 2000);
});

test('help is answered privately, playback commands are not', () => {
  const { commands } = setup();
  assert.equal(commands.isPrivate('help'), true);
  assert.equal(commands.isPrivate('play'), false);
  assert.equal(commands.isPrivate('nowplaying'), false);
});
