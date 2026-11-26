// Turns a folder on disk into a list of books.
//
// Rules:
//   - an audio file sitting directly in the library root is a one-file book
//   - a folder that directly contains audio files is a book (files = parts)
//   - a folder with no audio is searched one level deeper (Author/Book layouts)
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { probeFile } from './probe.js';
import { buildTimeline } from './timeline.js';

const AUDIO = new Set(['.mp3', '.m4b', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wav']);
const MAX_DEPTH = 4;

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const isAudio = (name) => AUDIO.has(extname(name).toLowerCase());
const stem = (name) => basename(name, extname(name));

export async function scanLibrary(root, { onWarning = () => {} } = {}) {
  const candidates = [];
  await collect(root, root, 0, candidates);

  const books = [];
  for (const candidate of candidates) {
    const tracks = [];
    for (const path of candidate.files) {
      try {
        const info = await probeFile(path);
        tracks.push({ path, title: info.title || stem(path), duration: info.duration, chapters: info.chapters });
      } catch (err) {
        onWarning(`Skipped ${path}: ${firstLine(err)}`);
      }
    }
    if (tracks.length === 0) continue;

    books.push({
      // Hash of the path relative to the library root: stable across rescans
      // and restarts, and always short enough for a Discord choice value.
      id: createHash('sha1').update(relative(root, candidate.path)).digest('hex').slice(0, 12),
      title: candidate.title,
      timeline: buildTimeline(tracks),
    });
  }

  return books.sort((a, b) => natural.compare(a.title, b.title));
}

async function collect(root, dir, depth, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable folder: nothing to add
  }

  const audio = entries.filter((e) => e.isFile() && isAudio(e.name)).map((e) => e.name).sort(natural.compare);
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);

  if (dir === root) {
    for (const name of audio) out.push({ path: join(dir, name), title: stem(name), files: [join(dir, name)] });
  } else if (audio.length > 0) {
    out.push({ path: dir, title: basename(dir), files: audio.map((name) => join(dir, name)) });
    return; // a book folder is a leaf; sub-folders (e.g. "extras") are ignored
  }

  if (depth >= MAX_DEPTH) return;
  for (const name of folders) await collect(root, join(dir, name), depth + 1, out);
}

export function findBook(books, id) {
  return books.find((b) => b.id === id) ?? null;
}

export function searchBooks(books, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return books;
  return books.filter((b) => b.title.toLowerCase().includes(q));
}

const firstLine = (err) => String(err?.stderr || err?.message || err).trim().split('\n')[0];
