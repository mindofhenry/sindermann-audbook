// Builds a small real audiobook library with ffmpeg so tests exercise the
// actual ffprobe output instead of hand-written JSON.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tone(out, seconds, extraArgs = []) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    ...extraArgs,
    out,
  ]);
}

/**
 * Layout:
 *   Multi Book/1.mp3 (2s, tagged "Opening"), 2.mp3 (3s), 10.mp3 (1s), cover.txt
 *   Author Name/Nested Book/a.mp3 (1s)
 *   Single Book.m4b (6s, chapters Intro 0-2, Middle 2-5, End 5-6)
 *   readme.txt
 */
export function makeLibrary() {
  const root = mkdtempSync(join(tmpdir(), 'abbot-lib-'));

  const multi = join(root, 'Multi Book');
  mkdirSync(multi);
  tone(join(multi, '1.mp3'), 2, ['-metadata', 'title=Opening']);
  tone(join(multi, '2.mp3'), 3);
  tone(join(multi, '10.mp3'), 1);
  writeFileSync(join(multi, 'cover.txt'), 'not audio');

  const nested = join(root, 'Author Name', 'Nested Book');
  mkdirSync(nested, { recursive: true });
  tone(join(nested, 'a.mp3'), 1);

  const meta = join(root, 'chapters.ffmeta');
  writeFileSync(
    meta,
    [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Intro',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=5000', 'title=Middle',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=5000', 'END=6000', 'title=End',
      '',
    ].join('\n'),
  );
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-i', meta, '-map_metadata', '1', '-map_chapters', '1',
    '-c:a', 'aac', '-f', 'ipod', join(root, 'Single Book.m4b'),
  ]);

  writeFileSync(join(root, 'readme.txt'), 'ignore me');
  return root;
}
