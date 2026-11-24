// The friends homepage: search the public-domain catalogs, add a book to the
// shelf, see what is there. Meant to sit behind Cloudflare Access, which is
// what decides who may open it.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const asset = (name) => readFileSync(fileURLToPath(new URL(`./public/${name}`, import.meta.url)));
const STATIC = {
  '/': ['text/html; charset=utf-8', asset('index.html')],
  '/app.css': ['text/css; charset=utf-8', asset('app.css')],
  '/app.js': ['text/javascript; charset=utf-8', asset('app.js')],
};
const SECURITY = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const MAX_WAITING = 5;
const KEEP_JOBS = 30;
const MAX_PROWLARR_SEARCHES = 2; // at once, so the page cannot hammer the indexers
const MEDIA_TYPES = ['movie', 'tv'];
const MAX_REQUESTS_PER_DAY = 10; // per person, so one click-happy friend cannot fill the disk
const DAY_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {{ catalog: object, library: object, listenUrl?: string|null,
 *           addBook: (type: string, plan: object, onProgress: Function) => Promise<{status: string}>,
 *           prowlarr?: { search: (query: string) => Promise<object[]> } | null,
 *           seerr?: { search: Function, request: Function } | null,
 *           now?: () => number, log?: Function }} deps
 */
export function createPortal({ catalog, library, addBook, listenUrl = null, prowlarr = null, seerr = null, now = Date.now, log = () => {} }) {
  const jobs = new Map(); // key -> job, insertion order = age
  let chain = Promise.resolve(); // downloads run one at a time
  let prowlarrSearches = 0;
  const requestTimes = new Map(); // person -> times of their requests in the last day

  // A browser on another site must not be able to trigger anything here.
  function guardPost(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      throw new HttpError(403, 'Requests from other sites are not allowed.');
    }
  }

  function enqueue(type, id, plan, by) {
    const key = `${type}:${id}`;
    const current = jobs.get(key);
    if (current && (current.state === 'queued' || current.state === 'working')) return current;
    const waiting = [...jobs.values()].filter((j) => j.state === 'queued').length;
    if (waiting >= MAX_WAITING) throw new HttpError(429, 'Several books are already downloading. Try again in a few minutes.');

    const job = { key, type, title: plan.title, author: plan.author, state: 'queued', progress: null, error: null, by };
    jobs.delete(key);
    jobs.set(key, job);
    while (jobs.size > KEEP_JOBS) jobs.delete(jobs.keys().next().value);

    chain = chain.then(async () => {
      job.state = 'working';
      try {
        const result = await addBook(type, plan, (progress) => { job.progress = progress; });
        if (result.status === 'added') await library.rescan();
        job.state = result.status === 'exists' ? 'exists' : 'done';
        log(`[portal] ${job.state}: "${job.title}" (${type}) for ${by ?? 'unknown'}`);
      } catch (err) {
        job.state = 'failed';
        job.error = err.message;
        log(`[portal] failed: "${job.title}" (${type}): ${err.message}`);
      }
    });
    return job;
  }

  const routes = {
    'GET /api/search': async (req, url) => {
      const type = url.searchParams.get('type');
      const source = seerr && MEDIA_TYPES.includes(type) ? seerr : catalog;
      try {
        return { results: await source.search(type, url.searchParams.get('q')) };
      } catch (err) {
        throw new HttpError(/type/i.test(err.message) ? 400 : 502, err.message);
      }
    },

    // Movies and TV: file a request with Seerr. What happens next is Seerr's business.
    'POST /api/request': async (req) => {
      if (!seerr) throw new HttpError(404, 'Movie and TV requests are not set up.');
      guardPost(req);
      const { type, id } = await readJson(req);
      const who = req.headers['cf-access-authenticated-user-email'] ?? 'unknown';
      const recent = (requestTimes.get(who) ?? []).filter((at) => now() - at < DAY_MS);
      if (recent.length >= MAX_REQUESTS_PER_DAY) {
        throw new HttpError(429, `You have made ${MAX_REQUESTS_PER_DAY} requests in the last day. Try again tomorrow.`);
      }
      let result;
      try {
        result = await seerr.request(type, id);
      } catch (err) {
        log(`[portal] request failed: ${type} ${id} for ${who}: ${err.message}`);
        throw new HttpError(502, err.message);
      }
      if (result.status === 'requested') {
        requestTimes.set(who, [...recent, now()]);
        log(`[portal] requested: ${type} ${id} for ${who}`);
      }
      // "state", not "status": the latter is how a route sets its HTTP status.
      return { state: result.status };
    },

    'POST /api/add': async (req) => {
      guardPost(req);
      const { type, id } = await readJson(req);
      let plan;
      try {
        plan = await catalog.plan(type, id);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      const job = enqueue(type, id, plan, req.headers['cf-access-authenticated-user-email'] ?? null);
      return { status: 202, job };
    },

    'GET /api/jobs': async () => ({ jobs: [...jobs.values()].reverse() }),

    // Read-only: lists what Prowlarr's indexers have. Nothing can be added from it.
    'GET /api/prowlarr': async (req, url) => {
      if (!prowlarr) throw new HttpError(404, 'Prowlarr search is not set up.');
      if (prowlarrSearches >= MAX_PROWLARR_SEARCHES) throw new HttpError(429, 'A search is already running. Try again in a moment.');
      prowlarrSearches += 1;
      try {
        return { results: await prowlarr.search(url.searchParams.get('q')) };
      } catch (err) {
        throw new HttpError(502, err.message);
      } finally {
        prowlarrSearches -= 1;
      }
    },

    'GET /api/library': async () => ({
      listenUrl,
      prowlarr: Boolean(prowlarr),
      types: [...catalog.types, ...(seerr ? MEDIA_TYPES : [])],
      books: library.books.map((b) => ({ title: b.title, duration: Math.round(b.timeline.duration), chapters: b.timeline.chapters.length })),
    }),

    'GET /healthz': async () => ({ ok: true }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (status, type, body) => {
      res.writeHead(status, { ...SECURITY, 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    if (req.method === 'GET' && STATIC[url.pathname]) return send(200, ...STATIC[url.pathname]);

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, 'application/json', JSON.stringify({ error: 'Not found.' }));
    try {
      const { status = 200, ...body } = await handler(req, url);
      send(status, 'application/json', JSON.stringify(body));
    } catch (err) {
      if (!(err instanceof HttpError)) log(`[portal] ${req.method} ${url.pathname}: ${err.stack ?? err}`);
      send(err.status ?? 500, 'application/json', JSON.stringify({ error: err instanceof HttpError ? err.message : 'Something went wrong on the server.' }));
    }
  });

  return { server };
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2048) throw new HttpError(413, 'Request too large.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'That was not valid JSON.');
  }
}
