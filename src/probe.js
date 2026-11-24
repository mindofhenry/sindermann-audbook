// Reads duration, title tag and embedded chapters from one audio file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function probeFile(path) {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format', '-show_chapters',
      '-show_streams', '-select_streams', 'a',
      path,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);

  const duration = Number(data.format?.duration);
  if (!data.streams?.length || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`No playable audio in ${path}`);
  }

  const tags = lowerKeys(data.format?.tags);
  const chapters = (data.chapters ?? []).map((ch, i) => ({
    title: lowerKeys(ch.tags).title || `Chapter ${i + 1}`,
    start: Number(ch.start_time),
    end: Number(ch.end_time),
  }));

  return { duration, title: tags.title || null, chapters };
}

// Tag names differ in case between containers (TITLE in ogg, title in mp4).
function lowerKeys(tags = {}) {
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
}
