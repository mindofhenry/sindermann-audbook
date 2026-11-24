// Runs the real @discordjs/voice audio player against real ffmpeg output.
// Only the network leg to Discord is missing: with NoSubscriberBehavior.Play
// the player consumes audio in real time even though nobody is connected.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { NoSubscriberBehavior } from '@discordjs/voice';
import { makeLibrary } from './helpers/fixtures.js';
import { DiscordAudio } from '../src/audio.js';

let root;
before(() => { root = makeLibrary(); });
after(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const audio = new DiscordAudio({ noSubscriber: NoSubscriberBehavior.Play, log: () => {} });
  const ends = [];
  let wake;
  audio.onEnd((result) => { ends.push(result); wake?.(); });
  const nextEnd = (ms) => Promise.race([new Promise((resolve) => { wake = resolve; }), sleep(ms)]);
  return { audio, ends, nextEnd };
}

const oneSecond = () => join(root, 'Multi Book', '10.mp3');
const sixSeconds = () => join(root, 'Single Book.m4b');

test('playing a file to the end reports a clean end and about the right played time', async () => {
  const { audio, ends, nextEnd } = setup();
  audio.play({ path: oneSecond(), offset: 0, speed: 1 });
  await nextEnd(5000);
  assert.deepEqual(ends, [{ ok: true }]);
  assert.ok(Math.abs(audio.playedMs() - 1000) < 300, `played ${audio.playedMs()}ms`);
  audio.stop();
});

test('a file that cannot be opened reports a failed end', async () => {
  const { audio, ends, nextEnd } = setup();
  audio.play({ path: join(root, 'missing.mp3'), offset: 0, speed: 1 });
  await nextEnd(5000);
  assert.deepEqual(ends, [{ ok: false }]);
  audio.stop();
});

test('replacing the stream mid-play does not report an end for the old one', async () => {
  const { audio, ends, nextEnd } = setup();
  audio.play({ path: sixSeconds(), offset: 0, speed: 1 });
  await sleep(300);
  audio.play({ path: oneSecond(), offset: 0, speed: 1 });
  await nextEnd(5000);
  await sleep(200); // room for a stray second event
  assert.deepEqual(ends, [{ ok: true }], 'exactly one end, from the second stream');
  audio.stop();
});

test('stop does not report an end', async () => {
  const { audio, ends } = setup();
  audio.play({ path: sixSeconds(), offset: 0, speed: 1 });
  await sleep(300);
  audio.stop();
  await sleep(400);
  assert.deepEqual(ends, []);
});

test('played time stands still while paused and continues after unpause', async () => {
  const { audio } = setup();
  audio.play({ path: sixSeconds(), offset: 0, speed: 1 });
  await sleep(500);
  audio.pause();
  await sleep(100); // let the pause settle
  const frozen = audio.playedMs();
  await sleep(500);
  assert.equal(audio.playedMs(), frozen);
  audio.unpause();
  await sleep(500);
  assert.ok(audio.playedMs() > frozen + 200, `only advanced to ${audio.playedMs()} from ${frozen}`);
  audio.stop();
});

test('played time restarts from zero for each new stream', async () => {
  const { audio } = setup();
  audio.play({ path: sixSeconds(), offset: 0, speed: 1 });
  await sleep(600);
  audio.play({ path: sixSeconds(), offset: 3, speed: 1 });
  assert.ok(audio.playedMs() < 100, `played ${audio.playedMs()}ms right after a new stream`);
  audio.stop();
});
