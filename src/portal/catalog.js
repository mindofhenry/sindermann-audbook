// Search and lookup against the two public-domain catalogs the homepage uses:
//   audiobook -> LibriVox recordings hosted on the Internet Archive
//   ebook     -> Project Gutenberg, through the Gutendex API
// Only public-domain items are ever returned or planned for download.

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ID_RULES = { audiobook: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, ebook: /^\d{1,7}$/ };
const EPUB = 'application/epub+zip';

export function createCatalog({ fetch = globalThis.fetch, types = ['audiobook'] } = {}) {
  const getJson = async (url) => {
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    } catch {
      res = null;
    }
    if (!res?.ok) throw new Error('The book catalog is not responding. Try again in a minute.');
    return res.json();
  };

  const searchers = {
    async audiobook(terms) {
      const url = new URL('https://archive.org/advancedsearch.php');
      url.searchParams.set('q', `collection:librivoxaudio AND (title:(${terms}) OR creator:(${terms}))`);
      for (const field of ['identifier', 'title', 'creator', 'runtime']) url.searchParams.append('fl[]', field);
      url.searchParams.append('sort[]', 'downloads desc');
      url.searchParams.set('rows', '12');
      url.searchParams.set('output', 'json');
      const data = await getJson(url);
      return (data.response?.docs ?? []).map((doc) => ({
        id: doc.identifier,
        title: String(doc.title ?? doc.identifier),
        author: first(doc.creator),
        detail: doc.runtime ? String(doc.runtime) : '',
      }));
    },

    async ebook(terms) {
      const data = await getJson(`https://gutendex.com/books/?search=${encodeURIComponent(terms)}`);
      return (data.results ?? [])
        .filter((book) => book.copyright === false && book.formats?.[EPUB])
        .slice(0, 12)
        .map((book) => ({ id: String(book.id), title: book.title, author: gutenbergAuthor(book), detail: 'EPUB' }));
    },
  };

  const planners = {
    async audiobook(id) {
      const item = await getJson(`https://archive.org/metadata/${id}`);
      const collections = [].concat(item.metadata?.collection ?? []);
      if (!collections.includes('librivoxaudio')) {
        throw new Error('Only public-domain LibriVox recordings can be added.');
      }
      const mp3 = (item.files ?? []).filter((f) => /\.mp3$/i.test(f.name));
      const preferred = mp3.filter((f) => f.format === '64Kbps MP3');
      const files = (preferred.length ? preferred : mp3)
        .sort((a, b) => natural.compare(a.name, b.name))
        .map((f) => ({
          name: f.name,
          url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`,
          size: Number(f.size) || null,
        }));
      const author = first(item.metadata?.creator);
      return { title: String(item.metadata?.title ?? id).replace(/,\s+by\s+.+$/i, ''), author, files };
    },

    async ebook(id) {
      const book = await getJson(`https://gutendex.com/books/${id}/`);
      if (book.copyright !== false || !book.formats?.[EPUB]) {
        throw new Error('Only public-domain books with an EPUB can be added.');
      }
      return {
        title: book.title,
        author: gutenbergAuthor(book),
        files: [{ name: `${book.title}.epub`, url: book.formats[EPUB], size: null }],
      };
    },
  };

  const enabled = (type) => types.includes(type) && searchers[type];

  return {
    /** Which kinds of book this catalog offers, e.g. ['audiobook']. */
    types,

    /** @returns {Promise<{id:string,title:string,author:string,detail:string}[]>} */
    async search(type, query) {
      if (!enabled(type)) throw new Error('Unknown catalog type.');
      const terms = cleanTerms(query);
      return terms ? searchers[type](terms) : [];
    },

    /** @returns {Promise<{title:string,author:string,files:{name:string,url:string,size:number|null}[]}>} */
    async plan(type, id) {
      if (!enabled(type)) throw new Error('Unknown catalog type.');
      if (!ID_RULES[type].test(String(id))) throw new Error('That book id is not valid.');
      return planners[type](String(id));
    },
  };
}

// Letters, digits, spaces and apostrophes only, so user input can never add
// search operators of its own.
const cleanTerms = (query) =>
  String(query ?? '').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

const first = (value) => String([].concat(value ?? [])[0] ?? '');

// Gutenberg stores "Austen, Jane"; show "Jane Austen".
function gutenbergAuthor(book) {
  const name = book.authors?.[0]?.name ?? '';
  const [last, rest] = name.split(/,\s*/, 2);
  return rest ? `${rest} ${last}` : name;
}
