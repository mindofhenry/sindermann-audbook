// Downloads a planned book onto the shelf (the library folder on disk).
//
// Safety rules, because the request starts from a web page:
//   - files only come from an allow-list of hosts, checked on every redirect
//   - names are reduced to a single safe path segment
//   - a size cap and a free-disk floor are enforced
//   - a book appears on the shelf only when every file arrived
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, statfs } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const GB = 1024 ** 3;

function safeSegment(text, fallback) {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

export const folderFor = (plan) => safeSegment(plan.title, 'Untitled');
const fileNameFor = (name) => safeSegment(String(name).split(/[\\/]/).pop(), 'file');

export async function addToShelf(plan, root, options = {}) {
  const { allowedHosts, maxBytes = 2 * GB, minFreeBytes = 2 * GB, fetch = globalThis.fetch, onProgress = () => {} } = options;
  if (!plan.files?.length) throw new Error('This book has no files to download.');

  const dest = join(root, folderFor(plan));
  if (await exists(dest)) return { status: 'exists', path: dest };

  const listed = plan.files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  if (listed > maxBytes) throw new Error('This book is too large to add.');

  await mkdir(root, { recursive: true });
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize - listed < minFreeBytes) {
    throw new Error('Not enough disk space left to add this book.');
  }

  // Dot-folders are ignored by the library scan, so a half-finished book is
  // never visible to the bot.
  const staging = join(root, `.incoming-${randomBytes(6).toString('hex')}`);
  await mkdir(staging);
  try {
    let received = 0;
    for (const [index, file] of plan.files.entries()) {
      const res = await fetchAllowed(file.url, allowedHosts, fetch);
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${file.name}`);
      const meter = new Transform({
        transform(chunk, _encoding, done) {
          received += chunk.length;
          done(received > maxBytes ? new Error('This book is too large to add.') : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(join(staging, fileNameFor(file.name))));
      onProgress({ done: index + 1, total: plan.files.length });
    }
    await rename(staging, dest);
    return { status: 'added', path: dest };
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

// fetch() would follow a redirect anywhere. Follow by hand and check each hop.
async function fetchAllowed(url, allowedHosts, fetch, hops = 5) {
  let current = new URL(url);
  for (let i = 0; i <= hops; i++) {
    const allowed = /^https?:$/.test(current.protocol)
      && allowedHosts.some((host) => current.hostname === host || current.hostname.endsWith(`.${host}`));
    if (!allowed) throw new Error(`Downloads from ${current.hostname} are not allowed.`);
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(15 * 60_000) });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    await res.body?.cancel();
    current = new URL(location, current);
  }
  throw new Error('Too many redirects while downloading.');
}

const exists = (path) => access(path).then(() => true, () => false);
