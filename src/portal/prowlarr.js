// Read-only search against a Prowlarr instance (https://prowlarr.com).
//
// This only answers "what do my indexers list for these words?". Nothing can
// be downloaded from here: download links, magnets and tracker pages are
// dropped before a result leaves this file, and so is anything that could
// carry the API key.

const AUDIOBOOKS = 3030; // Newznab category: Audio > Audiobook
const MAX_RESULTS = 25;

/**
 * @param {{ url: string, apiKey: string, indexerIds?: number[],
 *           accessId?: string|null, accessSecret?: string|null, fetch?: Function }} options
 */
export function createProwlarr({ url, apiKey, indexerIds = [], accessId = null, accessSecret = null, fetch = globalThis.fetch }) {
  const headers = { accept: 'application/json', 'x-api-key': apiKey };
  if (accessId && accessSecret) {
    // Lets the bot through Cloudflare Access without a browser login.
    headers['cf-access-client-id'] = accessId;
    headers['cf-access-client-secret'] = accessSecret;
  }

  return {
    /** @returns {Promise<{title:string,indexer:string,size:number|null,seeders:number|null,age:number|null,protocol:string}[]>} */
    async search(query) {
      const terms = cleanTerms(query);
      if (!terms) return [];

      const target = new URL(`${String(url).replace(/\/+$/, '')}/api/v1/search`);
      target.searchParams.set('query', terms);
      target.searchParams.set('type', 'search');
      target.searchParams.append('categories', String(AUDIOBOOKS));
      for (const id of indexerIds) target.searchParams.append('indexerIds', String(id));

      let res;
      try {
        // A redirect here means a login page, so it is reported instead of followed.
        res = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(45_000) });
      } catch {
        res = null; // the thrown error can quote request details; never pass it on
      }
      if (res?.status === 401 || res?.status === 403) {
        throw new Error('Prowlarr rejected the request. Check PROWLARR_API_KEY.');
      }
      if (res && res.status >= 300 && res.status < 400) throw new Error(LOGIN_PAGE);
      if (!res?.ok) throw new Error('Prowlarr is not responding. Try again in a minute.');

      let releases;
      try {
        releases = await res.json();
      } catch {
        throw new Error(LOGIN_PAGE);
      }

      return [].concat(releases ?? [])
        .map((r) => ({
          title: String(r.title ?? ''),
          indexer: String(r.indexer ?? ''),
          size: number(r.size),
          seeders: number(r.seeders),
          age: number(r.age),
          protocol: r.protocol === 'usenet' ? 'usenet' : 'torrent',
        }))
        .filter((r) => r.title)
        .sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1))
        .slice(0, MAX_RESULTS);
    },
  };
}

const LOGIN_PAGE = 'Prowlarr answered with a login page. If it sits behind Cloudflare Access, '
  + 'set PROWLARR_CF_ACCESS_CLIENT_ID and PROWLARR_CF_ACCESS_CLIENT_SECRET.';

// Letters, digits, spaces and apostrophes only, so user input can never add
// Prowlarr search operators such as {ImdbId:...} of its own.
const cleanTerms = (query) =>
  String(query ?? '').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

const number = (value) => (Number.isFinite(value) ? value : null);
