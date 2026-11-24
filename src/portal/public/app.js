// Page behaviour: search, add to shelf, show progress, list the shelf.
const $ = (id) => document.getElementById(id);
const form = $('search');
const statusLine = $('status');
const resultsList = $('results');
const shelfList = $('shelf');

let lastResults = [];
let lastType = 'audiobook';
let jobs = [];
let pollTimer = null;
const freshlyDone = new Set();

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

function say(text, problem = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle('problem', problem);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong. Try again.');
  return body;
}

function duration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

const isMedia = (type) => type === 'movie' || type === 'tv';
const MEDIA_STAMPS = { available: 'On Jellyfin', partial: 'Partly on Jellyfin', requested: 'Requested' };

// Movies and TV: a Request button, or a stamp saying where the title stands.
function mediaAction(item) {
  if (item.state === 'blocked') return el('div', { className: 'act' }, el('span', { textContent: 'Not available' }));
  if (MEDIA_STAMPS[item.state]) {
    const stamp = el('span', { className: 'stamp', textContent: MEDIA_STAMPS[item.state] });
    if (item.fresh) { stamp.classList.add('fresh'); item.fresh = false; }
    return el('div', { className: 'act' }, stamp);
  }
  const button = el('button', { type: 'button', textContent: 'Request' });
  button.addEventListener('click', () => requestMedia(item, button));
  return el('div', { className: 'act' }, button);
}

async function requestMedia(item, button) {
  button.disabled = true;
  try {
    const { state } = await api('/api/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: lastType, id: item.id }),
    });
    item.state = 'requested';
    item.fresh = true;
    say(state === 'exists'
      ? `"${item.title}" was already requested.`
      : `Requested "${item.title}". It appears on Jellyfin once it has downloaded.`);
    renderResults();
  } catch (err) {
    button.disabled = false;
    say(err.message, true);
  }
}

function actionFor(item) {
  if (isMedia(lastType)) return mediaAction(item);
  const job = jobs.find((j) => j.key === `${lastType}:${item.id}`);
  if (!job || job.state === 'failed') {
    const button = el('button', { type: 'button', textContent: 'Add to shelf' });
    button.addEventListener('click', () => add(item, button));
    return job ? el('div', { className: 'act' }, button, el('span', { className: 'problem', textContent: job.error })) : el('div', { className: 'act' }, button);
  }
  if (job.state === 'queued') return el('div', { className: 'act' }, el('span', { textContent: 'Waiting its turn' }));
  if (job.state === 'working') {
    const p = job.progress;
    return el('div', { className: 'act' }, el('span', { textContent: p ? `Adding, file ${p.done} of ${p.total}` : 'Adding' }));
  }
  const stamp = el('span', { className: 'stamp', textContent: 'On the shelf' });
  if (freshlyDone.delete(job.key)) stamp.classList.add('fresh');
  return el('div', { className: 'act' }, stamp);
}

function renderResults() {
  resultsList.replaceChildren(...lastResults.map((item) =>
    el('li', {},
      el('p', { className: 'title', textContent: item.title }),
      el('p', { className: 'meta', textContent: [item.author, item.detail].filter(Boolean).join(', ') }),
      actionFor(item))));
}

async function renderShelf() {
  try {
    const { books, listenUrl, types, prowlarr } = await api('/api/library');
    $('prowlarr').hidden = !prowlarr;
    // Offer the audiobook/ebook choice only when both are switched on.
    const kinds = document.querySelector('.kinds');
    kinds.hidden = types.length < 2;
    for (const radio of kinds.querySelectorAll('input')) radio.closest('label').hidden = !types.includes(radio.value);
    if (types.includes('movie')) $('lede').textContent = 'Audiobooks, movies and TV in one place.';
    $('listen').replaceChildren(...(listenUrl
      ? [el('a', { href: listenUrl, textContent: 'Listen or read in the browser' })]
      : []));
    if (books.length === 0) {
      shelfList.replaceChildren(el('li', {}, el('p', { className: 'meta', textContent: 'Nothing here yet. Search above and add the first book.' })));
      return;
    }
    shelfList.replaceChildren(...books.map((book) => {
      const command = `/play ${book.title}`;
      const copy = el('button', { type: 'button', className: 'quiet', textContent: 'Copy command' });
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(command).catch(() => {});
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy command'; }, 1500);
      });
      return el('li', {},
        el('p', { className: 'title', textContent: book.title }),
        el('p', { className: 'meta' }, `${duration(book.duration)}, ${book.chapters} chapters. In Discord: `, el('code', { textContent: command })),
        el('div', { className: 'act' }, copy));
    }));
  } catch (err) {
    shelfList.replaceChildren(el('li', {}, el('p', { className: 'problem', textContent: err.message })));
  }
}

async function refreshJobs() {
  const before = new Map(jobs.map((j) => [j.key, j.state]));
  jobs = (await api('/api/jobs')).jobs;
  let finished = false;
  for (const job of jobs) {
    const was = before.get(job.key);
    if ((job.state === 'done' || job.state === 'exists') && was && was !== job.state) {
      freshlyDone.add(job.key);
      finished = true;
    }
  }
  renderResults();
  if (finished) renderShelf();
  const active = jobs.some((j) => j.state === 'queued' || j.state === 'working');
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(() => refreshJobs().catch(() => {}), 2000);
}

async function add(item, button) {
  button.disabled = true;
  try {
    await api('/api/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: lastType, id: item.id }),
    });
    say(`Adding "${item.title}". Big books take a few minutes.`);
    await refreshJobs();
  } catch (err) {
    button.disabled = false;
    say(err.message, true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const q = String(data.get('q')).trim();
  if (!q) return;
  lastType = String(data.get('type'));
  say(isMedia(lastType) ? 'Searching' : 'Searching the catalog');
  try {
    lastResults = (await api(`/api/search?type=${encodeURIComponent(lastType)}&q=${encodeURIComponent(q)}`)).results;
    const nothing = isMedia(lastType) ? `Nothing matches "${q}".` : `Nothing in the catalog matches "${q}". Try the author's last name.`;
    say(lastResults.length ? '' : nothing);
    renderResults();
  } catch (err) {
    lastResults = [];
    renderResults();
    say(err.message, true);
  }
});

// Prowlarr: a read-only lookup. Results are plain text with no links or buttons.
function size(bytes) {
  if (!bytes) return '';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function age(days) {
  if (days === null) return '';
  if (days < 1) return 'today';
  return days < 365 ? `${days} d old` : `${Math.floor(days / 365)} y old`;
}

$('prowlarr-search').addEventListener('submit', async (event) => {
  event.preventDefault();
  const line = $('prowlarr-status');
  const list = $('prowlarr-results');
  const tell = (text, problem = false) => {
    line.textContent = text;
    line.classList.toggle('problem', problem);
  };
  const q = String(new FormData(event.target).get('q')).trim();
  if (!q) return;
  tell('Asking the indexers. This can take half a minute.');
  list.replaceChildren();
  try {
    const { results } = await api(`/api/prowlarr?q=${encodeURIComponent(q)}`);
    tell(results.length ? `${results.length} found` : `No indexer lists anything for "${q}".`);
    list.replaceChildren(...results.map((r) =>
      el('li', {},
        el('p', { className: 'title', textContent: r.title }),
        el('p', {
          className: 'meta',
          textContent: [r.indexer, size(r.size), r.seeders === null ? r.protocol : `${r.seeders} seeding`, age(r.age)].filter(Boolean).join(', '),
        }))));
  } catch (err) {
    tell(err.message, true);
  }
});

// The search box hint follows the kind being searched.
for (const radio of form.querySelectorAll('input[name="type"]')) {
  radio.addEventListener('change', () => {
    $('q').placeholder = isMedia(radio.value) ? 'Title' : 'Title or author';
  });
}

refreshJobs().catch(() => {});
renderShelf();
