import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { makeLibrary } from './helpers/fixtures.js';
import { openStream } from '../src/ffmpeg.js';

let root;
before(() => { root = makeLibrary(); });
after(() => rmSync(root, { recursive: true, force: true }));

// Runs the real ffmpeg pipeline into a file and inspects what came out.
async function render(request) {
  const out = join(root, `out-${Math.random().toString(36).slice(2)}.ogg`);
  const source = openStream(request);
  await pipeline(source.stream, createWriteStream(out));
  const result = await source.done;
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString(),
  );
  return { result, codec: probe.streams[0].codec_name, sampleRate: probe.streams[0].sample_rate, duration: Number(probe.format.duration) };
}

const near = (actual, expected, tolerance = 0.25) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('a file is streamed as 48 kHz Ogg Opus, which Discord plays without re-encoding', async () => {
  const out = await render({ path: join(root, 'Multi Book', '2.mp3'), offset: 0, speed: 1 });
  assert.equal(out.codec, 'opus');
  assert.equal(out.sampleRate, '48000');
  near(out.duration, 3);
  assert.deepEqual(out.result, { ok: true });
});

test('an offset skips that much audio from the start of the file', async () => {
  const out = await render({ path: join(root, 'Single Book.m4b'), offset: 4, speed: 1 });
  near(out.duration, 2);
});

test('double speed halves the playing time', async () => {
  const out = await render({ path: join(root, 'Single Book.m4b'), offset: 0, speed: 2 });
  near(out.duration, 3);
});

test('a missing file is reported as a failure instead of a clean end', async () => {
  const source = openStream({ path: join(root, 'nope.mp3'), offset: 0, speed: 1 }, { log: () => {} });
  source.stream.resume();
  assert.deepEqual(await source.done, { ok: false });
});

test('kill ends the stream early and is not treated as a playback failure', async () => {
  const source = openStream({ path: join(root, 'Single Book.m4b'), offset: 0, speed: 1 });
  source.kill();
  source.stream.resume();
  assert.deepEqual(await source.done, { ok: true });
});
