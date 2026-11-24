import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createPresenceWatcher } from '../src/presence.js';
import { bookA, fakeSessions } from './helpers/fakes.js';

const MINUTE = 60_000;

async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sessions = fakeSessions(openDb(':memory:'));
  const session = await sessions.join({ id: 'vc1', guild: { id: 'g1' } });
  session.start(bookA());
  const watcher = createPresenceWatcher({ sessions, leaveAfterMs: 5 * MINUTE });
  return { sessions, session, watcher, tick: (ms) => t.mock.timers.tick(ms) };
}

test('playback pauses when the last listener leaves the channel', async (t) => {
  const { session, watcher } = await setup(t);
  watcher.update('g1', 0);
  assert.equal(session.state, 'paused');
});

test('playback resumes when a listener comes back', async (t) => {
  const { session, watcher } = await setup(t);
  watcher.update('g1', 0);
  watcher.update('g1', 1);
  assert.equal(session.state, 'playing');
});

test('a book the user paused themselves stays paused when someone joins', async (t) => {
  const { session, watcher } = await setup(t);
  session.pause();
  watcher.update('g1', 0);
  watcher.update('g1', 1);
  assert.equal(session.state, 'paused');
});

test('the bot leaves after the channel has been empty for the grace period', async (t) => {
  const { sessions, watcher, tick } = await setup(t);
  watcher.update('g1', 0);
  tick(5 * MINUTE - 1);
  assert.deepEqual(sessions.left, []);
  tick(1);
  assert.deepEqual(sessions.left, ['g1']);
});

test('a listener returning in time cancels the leave', async (t) => {
  const { sessions, watcher, tick } = await setup(t);
  watcher.update('g1', 0);
  tick(4 * MINUTE);
  watcher.update('g1', 1);
  tick(10 * MINUTE);
  assert.deepEqual(sessions.left, []);
});

test('repeated empty updates do not restart the grace period', async (t) => {
  const { sessions, watcher, tick } = await setup(t);
  watcher.update('g1', 0);
  tick(4 * MINUTE);
  watcher.update('g1', 0);
  tick(1 * MINUTE);
  assert.deepEqual(sessions.left, ['g1']);
});

test('updates for a server with no session are ignored', async (t) => {
  const { watcher } = await setup(t);
  assert.doesNotThrow(() => watcher.update('other-guild', 0));
});
