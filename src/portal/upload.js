// Uploads of your own audiobooks from the homepage.
//
// Cloudflare refuses request bodies over 100 MB on the free plan, and one
// book is often several times that, so the browser sends each file in small
// pieces. Safety rules, because the bytes come from a web page:
//   - the title and every file name are reduced to one safe path segment
//   - only audio files, a size cap per book, and a free-disk floor
//   - pieces go to a dot-folder the library scan ignores, so a book appears
//     on the shelf only when every byte of every file has arrived
//   - an upload belongs to the person who started it and expires when idle
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm, statfs, truncate, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isAudio } from '../library.js';
import { fileNameFor, folderFor } from './shelf.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const STAGING = '.incoming-upload-';

export class UploadError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const GONE = 'That upload is not running any more. Start it again.';

export function createUploads({
  root,
  maxBytes = 2 * GB,
  minFreeBytes = 2 * GB,
  chunkBytes = 16 * MB,
  maxFiles = 500,
  maxActive = 2,
  idleMs = 30 * 60_000,
  now = Date.now,
}) {
  const uploads = new Map(); // id -> upload

  const drop = async (upload) => {
    uploads.delete(upload.id);
    await rm(upload.staging, { recursive: true, force: true });
  };

  async function expire() {
    for (const upload of [...uploads.values()]) {
      if (!upload.busy && now() - upload.touched > idleMs) await drop(upload);
    }
  }

  function find(id, by) {
    const upload = uploads.get(String(id));
    if (!upload || upload.by !== by) throw new UploadError(404, GONE);
    return upload;
  }

  return {
    chunkBytes,
    maxBytes,

    /** @returns {Promise<{id: string, chunkBytes: number, files: string[]}>} */
    async start({ title, files, by }) {
      const folder = folderFor({ title: typeof title === 'string' ? title : '' }, '');
      if (!folder) throw new UploadError(400, 'Give the book a title.');
      if (!Array.isArray(files) || files.length === 0) throw new UploadError(400, 'Choose at least one audio file.');
      if (files.length > maxFiles) throw new UploadError(400, `Too many files. A book can have up to ${maxFiles}.`);

      const seen = new Set();
      const wanted = files.map((file) => {
        const name = fileNameFor(file?.name ?? '');
        if (!isAudio(name)) throw new UploadError(400, `"${name}" is not an audio file. Use mp3, m4b, m4a, aac, ogg, opus, flac or wav.`);
        if (!Number.isSafeInteger(file.size) || file.size < 1) throw new UploadError(400, `"${name}" has no valid size.`);
        if (seen.has(name.toLowerCase())) throw new UploadError(400, `Two files have the same name: "${name}".`);
        seen.add(name.toLowerCase());
        return { name, size: file.size, received: 0 };
      });

      const total = wanted.reduce((sum, file) => sum + file.size, 0);
      if (total > maxBytes) throw new UploadError(413, `This book is too large to upload. The limit is ${Math.floor(maxBytes / MB)} MB.`);

      const dest = join(root, folder);
      if (await exists(dest)) throw new UploadError(409, `"${folder}" is already on the shelf.`);

      await expire();
      if (uploads.size >= maxActive) throw new UploadError(429, 'Other uploads are already running. Try again in a few minutes.');

      await mkdir(root, { recursive: true });
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize - total < minFreeBytes) throw new UploadError(507, 'Not enough disk space left for this book.');

      const id = randomBytes(12).toString('hex');
      const upload = { id, by, folder, dest, staging: join(root, `${STAGING}${id}`), files: wanted, touched: now(), busy: false };
      await mkdir(upload.staging);
      for (const file of wanted) await writeFile(join(upload.staging, file.name), '');
      uploads.set(id, upload);
      return { id, chunkBytes, files: wanted.map((file) => file.name) };
    },

    /** Appends one piece of one file. @returns {Promise<{received: number}>} */
    async chunk({ id, file: index, offset, by }, stream) {
      const upload = find(id, by);
      const file = upload.files[index];
      if (!file) throw new UploadError(400, 'That file is not part of this upload.');
      if (upload.busy) throw new UploadError(409, 'Another piece of this upload is still arriving.', { received: file.received });
      // The usual cause: our answer to the last piece got lost. Say where we are.
      if (offset !== file.received) throw new UploadError(409, 'That piece is out of order.', { received: file.received });

      const path = join(upload.staging, file.name);
      const room = file.size - file.received;
      let got = 0;
      const meter = new Transform({
        transform(piece, _encoding, done) {
          got += piece.length;
          if (got > room) return done(new UploadError(413, `"${file.name}" is larger than it said it would be.`));
          if (got > chunkBytes) return done(new UploadError(413, `Send at most ${chunkBytes} bytes per chunk.`));
          done(null, piece);
        },
      });

      upload.busy = true;
      try {
        await pipeline(stream, meter, createWriteStream(path, { flags: 'a' }));
        file.received += got;
        return { received: file.received };
      } catch (err) {
        await truncate(path, file.received).catch(() => {});
        throw err;
      } finally {
        upload.busy = false;
        upload.touched = now();
      }
    },

    /** Moves the finished book onto the shelf. @returns {Promise<{status: 'added', title: string}>} */
    async finish({ id, by }) {
      const upload = find(id, by);
      if (upload.busy) throw new UploadError(409, 'A piece of this upload is still arriving.');
      const short = upload.files.find((file) => file.received !== file.size);
      if (short) throw new UploadError(400, `"${short.name}" did not arrive completely.`);
      if (await exists(upload.dest)) {
        await drop(upload);
        throw new UploadError(409, `"${upload.folder}" is already on the shelf.`);
      }
      await rename(upload.staging, upload.dest);
      uploads.delete(upload.id);
      return { status: 'added', title: upload.folder };
    },

    async cancel({ id, by }) {
      await drop(find(id, by));
    },

    /** Removes staging folders no running upload owns, for example after a restart. */
    async sweep() {
      const live = new Set([...uploads.values()].map((upload) => upload.staging));
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory() && entry.name.startsWith(STAGING) && !live.has(path)) {
          await rm(path, { recursive: true, force: true });
        }
      }
    },
  };
}

const exists = (path) => access(path).then(() => true, () => false);
