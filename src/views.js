// Text the bot sends back. Kept apart from the handlers so wording and the
// Discord 2000-character limit are handled in one place.
import { formatTime } from './format.js';

const LIMIT = 1900; // headroom under Discord's 2000-character message cap

/** What /help says: how to start, then every command in the order you need them. */
export function helpText({ shelfUrl = null } = {}) {
  const lines = [
    '**Audiobook bot**',
    '1. Join a voice channel.',
    '2. `/play` and pick a book. It picks up where this server left off.',
    '3. `/pause`, `/resume` or `/stop`. Your place is saved every time.',
    '',
    '**Move around a book**',
    '`/chapter` pick a chapter from the list, or type its number or title',
    '`/chapters` list the chapters',
    '`/next` `/prev` one chapter forward or back',
    '`/forward` `/back` 30 seconds, or a number you choose',
    '`/seek` jump to a time, for example `1:23:45` or `90m`',
    '`/nowplaying` book, chapter and position',
    '',
    '**More**',
    '`/library` every book with your progress',
    '`/speed` 0.75x to 2x, remembered for this server',
    '`/bookmark add` `list` `goto` `remove` save spots in the current book',
    '`/rescan` reload the library after adding books (needs Manage Server)',
    '`/help` this message',
  ];
  // Angle brackets keep Discord from unfurling the link into a preview card.
  if (shelfUrl) lines.push('', `**Add a book**: search or upload at <${shelfUrl}>`);
  return lines.join('\n');
}

export function statusText(status) {
  const { book, position, duration, chapterIndex, chapter, chapterCount, state, speed } = status;
  const percent = duration > 0 ? Math.floor((position / duration) * 100) : 0;
  const icon = state === 'paused' ? '⏸' : '▶';
  const rate = speed === 1 ? '' : ` · ${speed}x`;
  return [
    `${icon} **${book.title}**`,
    `Chapter ${chapterIndex + 1}/${chapterCount}: ${chapter.title}`,
    `\`${bar(position / duration)}\` ${formatTime(position)} / ${formatTime(duration)} (${percent}%)${rate}`,
  ].join('\n');
}

function bar(fraction, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((fraction || 0) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** All chapters when they fit, otherwise a window centred on the current one. */
export function chaptersText(status) {
  const { chapters } = status.book.timeline;
  const lines = chapters.map((ch, i) => {
    const marker = i === status.chapterIndex ? '→' : ' ';
    return `${marker} ${i + 1}. ${ch.title} (${formatTime(ch.start)})`;
  });

  let first = status.chapterIndex;
  let last = status.chapterIndex;
  let size = lines[first].length + 1;
  // Grow outwards from the current chapter until the next line would not fit.
  for (;;) {
    const before = first > 0 ? lines[first - 1].length + 1 : Infinity;
    const after = last < lines.length - 1 ? lines[last + 1].length + 1 : Infinity;
    if (before === Infinity && after === Infinity) break;
    const takeBefore = before <= after;
    const cost = takeBefore ? before : after;
    if (size + cost > LIMIT - 100) break;
    if (takeBefore) first -= 1; else last += 1;
    size += cost;
  }

  const whole = first === 0 && last === lines.length - 1;
  const header = whole
    ? `**${status.book.title}** · ${lines.length} chapters`
    : `**${status.book.title}** · chapters ${first + 1}-${last + 1} of ${lines.length}`;
  return `${header}\n\`\`\`\n${lines.slice(first, last + 1).join('\n')}\n\`\`\``;
}

export function libraryText(books, progress) {
  if (books.length === 0) {
    return 'No books in the library yet. Copy audiobook folders into the books directory, then run /rescan.';
  }
  const header = `**Library** · ${books.length} books`;
  const lines = [];
  let size = header.length;
  for (const book of books) {
    const line = `• **${book.title}** · ${formatTime(book.timeline.duration)}${progressNote(book, progress[book.id])}`;
    if (size + line.length + 1 > LIMIT - 60) break;
    lines.push(line);
    size += line.length + 1;
  }
  const hidden = books.length - lines.length;
  const footer = hidden > 0 ? `\n…and ${hidden} more. Type a title in /play to search.` : '';
  return `${header}\n${lines.join('\n')}${footer}`;
}

function progressNote(book, position) {
  if (position === undefined) return '';
  if (position >= book.timeline.duration) return ' · finished';
  return ` · ${Math.floor((position / book.timeline.duration) * 100)}%`;
}

export function bookmarksText(book, bookmarks) {
  if (bookmarks.length === 0) return `No bookmarks in **${book.title}** yet. Add one with /bookmark add.`;
  const lines = [];
  let size = 0;
  for (const mark of bookmarks) {
    const line = `• ${formatTime(mark.position)} · ${mark.label}`;
    if (size + line.length + 1 > LIMIT - 100) break;
    lines.push(line);
    size += line.length + 1;
  }
  return `**Bookmarks in ${book.title}**\n${lines.join('\n')}`;
}
