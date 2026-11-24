// Movies and TV for the friends homepage, through a Seerr / Jellyseerr server
// (https://seerr.dev). The homepage only searches and files requests; Seerr
// and whatever it is connected to do the rest.
//
// Only a title, a year and a plain state leave this file. The API key and the
// rest of Seerr's answer stay on the server.

const TYPES = ['movie', 'tv'];
const MAX_RESULTS = 12;

// Seerr's MediaStatus: 1 unknown, 2 pending, 3 processing, 4 partially
// available, 5 available, 6 blocklisted, 7 deleted.
const STATES = { 2: 'requested', 3: 'requested', 4: 'partial', 5: 'available', 6: 'blocked' };

/**
 * @param {{ url: string, apiKey: string, userId?: number|null,
 *           accessId?: string|null, accessSecret?: string|null, fetch?: Function }} options
 */
export function createSeerr({ url, apiKey, userId = null, accessId = null, accessSecret = null, fetch = globalThis.fetch }) {
  const base = `${String(url).replace(/\/+$/, '')}/api/v1`;
  const headers = { accept: 'application/json', 'x-api-key': apiKey };
  if (accessId && accessSecret) {
    // Lets the bot through Cloudflare Access without a browser login.
    headers['cf-access-client-id'] = accessId;
    headers['cf-access-client-secret'] = accessSecret;
  }

  // Returns { status, body }. Connection problems become plain messages that
  // can never quote the request, and so never the key.
  async function call(path, init = {}) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        redirect: 'manual', // a redirect here means a login page
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(DOWN);
    }
    if (res.status === 401) throw new Error('The request service rejected the key. Check JELLYSEERR_API_KEY.');
    if (res.status >= 300 && res.status < 400) throw new Error(LOGIN_PAGE);
    if (res.status >= 500) throw new Error(DOWN);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(LOGIN_PAGE);
    }
    return { status: res.status, body };
  }

  const checkType = (type) => {
    if (!TYPES.includes(type)) throw new Error('Unknown catalog type.');
  };

  return {
    /** @returns {Promise<{id:string,title:string,author:string,detail:string,state:string|null}[]>} */
    async search(type, query) {
      checkType(type);
      const terms = cleanTerms(query);
      if (!terms) return [];
      // encodeURIComponent, not URLSearchParams: Seerr refuses "+" for a space.
      const { status, body } = await call(`/search?query=${encodeURIComponent(terms)}&page=1&language=en`);
      if (status !== 200) throw new Error(DOWN);
      return [].concat(body?.results ?? [])
        .filter((item) => item.mediaType === type)
        .slice(0, MAX_RESULTS)
        .map((item) => ({
          id: String(item.id),
          title: String(item.title ?? item.name ?? ''),
          author: '',
          detail: String(item.releaseDate ?? item.firstAirDate ?? '').slice(0, 4),
          state: STATES[item.mediaInfo?.status] ?? null,
        }));
    },

    /** Files a request. @returns {Promise<{status:'requested'|'exists'}>} */
    async request(type, id) {
      checkType(type);
      if (!/^\d{1,9}$/.test(String(id))) throw new Error('That id is not valid.');
      const wanted = { mediaType: type, mediaId: Number(id) };
      if (type === 'tv') wanted.seasons = 'all';
      if (userId) wanted.userId = userId;

      const { status, body } = await call('/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wanted),
      });
      if (status === 201 || status === 200) return { status: 'requested' };
      if (status === 409) return { status: 'exists' };
      const reason = typeof body?.message === 'string' ? body.message.slice(0, 200) : `status ${status}`;
      throw new Error(`The request was refused: ${reason}`);
    },
  };
}

const DOWN = 'The request service is not responding. Try again in a minute.';
const LOGIN_PAGE = 'The request service answered with a login page. If it sits behind Cloudflare Access, '
  + 'set JELLYSEERR_CF_ACCESS_CLIENT_ID and JELLYSEERR_CF_ACCESS_CLIENT_SECRET.';

// Letters, digits, spaces and apostrophes only, so user input can never add
// query parameters of its own.
const cleanTerms = (query) =>
  String(query ?? '').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
