// Slash commands: their definitions and what each one does.
//
// Every handler returns the reply text. Nothing in here touches Discord's
// network API, so the whole command surface runs in tests.
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { formatTime, parseTime } from './format.js';
import { findBook, searchBooks } from './library.js';
import { bookmarksText, chaptersText, libraryText, statusText } from './views.js';

const NOTHING = 'Nothing is playing. Use /play to start a book.';
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

const command = (name, description) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);

const seconds = (option) =>
  option.setName('seconds').setDescription('How many seconds (default 30)').setMinValue(1).setMaxValue(3600);

const bookmarkPicker = (option) =>
  option.setName('bookmark').setDescription('Which bookmark').setRequired(true).setAutocomplete(true);

export const definitions = [
  command('library', 'List the audiobooks on the server'),
  command('play', 'Play a book from where you left off').addStringOption((o) =>
    o.setName('book').setDescription('Book title').setRequired(true).setAutocomplete(true)),
  command('pause', 'Pause and save your place'),
  command('resume', 'Resume the paused book, or the last book you listened to'),
  command('stop', 'Save your place and leave the voice channel'),
  command('nowplaying', 'Show the current book, chapter and position'),
  command('next', 'Skip to the next chapter'),
  command('prev', 'Go back to the start of this chapter, or the one before'),
  command('chapters', 'List the chapters of the current book'),
  command('chapter', 'Jump to a chapter by number').addIntegerOption((o) =>
    o.setName('number').setDescription('Chapter number').setRequired(true).setMinValue(1)),
  command('back', 'Rewind a few seconds').addIntegerOption(seconds),
  command('forward', 'Skip ahead a few seconds').addIntegerOption(seconds),
  command('seek', 'Jump to a time in the book').addStringOption((o) =>
    o.setName('time').setDescription('For example 1:23:45, 12:30 or 90m').setRequired(true)),
  command('speed', 'Set the playback speed').addNumberOption((o) =>
    o.setName('rate').setDescription('Playback speed').setRequired(true)
      .addChoices(...SPEEDS.map((s) => ({ name: `${s}x`, value: s })))),
  command('bookmark', 'Bookmarks for the current book')
    .addSubcommand((s) => s.setName('add').setDescription('Bookmark the current position')
      .addStringOption((o) => o.setName('label').setDescription('A note to find it by').setMaxLength(80)))
    .addSubcommand((s) => s.setName('list').setDescription('List bookmarks in this book'))
    .addSubcommand((s) => s.setName('goto').setDescription('Jump to a bookmark').addIntegerOption(bookmarkPicker))
    .addSubcommand((s) => s.setName('remove').setDescription('Delete a bookmark').addIntegerOption(bookmarkPicker)),
  command('rescan', 'Reload the library after adding or removing books')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((builder) => builder.toJSON());

/**
 * @param {{ db: object, sessions: object, library: { books: object[], rescan: () => Promise<{count:number, warnings:string[]}> } }} ctx
 */
export function createCommands({ db, sessions, library }) {
  // Sessions with a loaded book only; an idle session counts as "nothing".
  const active = (guildId) => {
    const session = sessions.get(guildId);
    return session?.book ? session : null;
  };

  const resolveBook = (input) => {
    const byId = findBook(library.books, input);
    if (byId) return { book: byId };
    const matches = searchBooks(library.books, input);
    const exact = matches.find((b) => b.title.toLowerCase() === input.trim().toLowerCase());
    if (exact || matches.length === 1) return { book: exact ?? matches[0] };
    return { matches };
  };

  const startBook = async (i, book) => {
    const channel = i.member?.voice?.channel;
    if (!channel) return 'Join a voice channel first, then run the command again.';
    const session = await sessions.join(channel);
    session.start(book);
    return statusText(session.status());
  };

  // Handlers that need a loaded book are wrapped so each one can assume it.
  const withBook = (handler) => (i) => {
    const session = active(i.guildId);
    return session ? handler(i, session) : NOTHING;
  };

  const skipBy = (sign) => withBook((i, session) => {
    session.skip(sign * (i.options.getInteger('seconds') ?? 30));
    return session.book ? statusText(session.status()) : 'Reached the end of the book.';
  });

  const handlers = {
    library: (i) => libraryText(library.books, db.allProgress(i.guildId)),

    play: async (i) => {
      const input = i.options.getString('book');
      const { book, matches } = resolveBook(input);
      if (book) return startBook(i, book);
      if (matches.length === 0) return `I couldn't find a book matching "${input}". Try /library.`;
      const shown = matches.slice(0, 10).map((b) => `• ${b.title}`).join('\n');
      return `Several books match "${input}". Pick one from the list as you type:\n${shown}`;
    },

    pause: (i) => {
      const session = active(i.guildId);
      if (!session?.pause()) return 'Nothing is playing.';
      return `Paused at ${formatTime(session.position())}.\n${statusText(session.status())}`;
    },

    resume: async (i) => {
      const session = active(i.guildId);
      if (session) {
        session.resume();
        return statusText(session.status());
      }
      const last = findBook(library.books, db.lastBookId(i.guildId) ?? '');
      if (!last) return 'Nothing to resume yet. Use /play to pick a book.';
      return startBook(i, last);
    },

    stop: (i) => {
      const session = active(i.guildId);
      if (!session) {
        sessions.leave(i.guildId);
        return 'Nothing is playing.';
      }
      const at = formatTime(session.position());
      const title = session.book.title;
      sessions.leave(i.guildId); // leave() stops the session, which saves
      return `Stopped **${title}** at ${at}. Your place is saved.`;
    },

    nowplaying: withBook((i, session) => statusText(session.status())),

    next: withBook((i, session) =>
      session.nextChapter() ? statusText(session.status()) : 'This is the last chapter.'),

    prev: withBook((i, session) => {
      session.prevChapter();
      return statusText(session.status());
    }),

    chapters: withBook((i, session) => chaptersText(session.status())),

    chapter: withBook((i, session) => {
      const number = i.options.getInteger('number');
      if (!session.goToChapter(number - 1)) {
        return `Pick a chapter from 1 to ${session.book.timeline.chapters.length}.`;
      }
      return statusText(session.status());
    }),

    back: skipBy(-1),
    forward: skipBy(+1),

    seek: withBook((i, session) => {
      const target = parseTime(i.options.getString('time'));
      if (target === null) return 'I could not read that time. Use 1:23:45, 12:30, 90m or plain seconds.';
      const { duration } = session.book.timeline;
      if (target >= duration) return `That is past the end. This book is ${formatTime(duration)} long.`;
      session.seek(target);
      return statusText(session.status());
    }),

    speed: (i) => {
      const rate = i.options.getNumber('rate');
      const session = sessions.get(i.guildId);
      if (session) session.setSpeed(rate);
      else db.setSpeed(i.guildId, rate);
      return `Speed set to ${rate}x.`;
    },

    bookmark: withBook((i, session) => {
      const { book } = session;
      const lookup = () => {
        const mark = db.getBookmark(i.guildId, i.options.getInteger('bookmark'));
        return mark?.bookId === book.id ? mark : null;
      };

      switch (i.options.getSubcommand()) {
        case 'add': {
          const status = session.status();
          const label = i.options.getString('label')?.trim() || status.chapter.title;
          db.addBookmark({ guildId: i.guildId, bookId: book.id, position: status.position, label, userId: i.user.id });
          return `Bookmarked ${formatTime(status.position)} · ${label}`;
        }
        case 'list':
          return bookmarksText(book, db.listBookmarks(i.guildId, book.id));
        case 'goto': {
          const mark = lookup();
          if (!mark) return `I couldn't find that bookmark in **${book.title}**.`;
          session.seek(mark.position);
          return `Jumped to ${mark.label}.\n${statusText(session.status())}`;
        }
        case 'remove': {
          const mark = lookup();
          if (!mark) return `I couldn't find that bookmark in **${book.title}**.`;
          db.removeBookmark(i.guildId, mark.id);
          return `Removed bookmark ${formatTime(mark.position)} · ${mark.label}`;
        }
        default:
          return 'Unknown bookmark command.';
      }
    }),

    rescan: async () => {
      const { count, warnings } = await library.rescan();
      const skipped = warnings.length ? ` ${warnings.length} files were skipped (see the bot log).` : '';
      return `Library reloaded: ${count} books.${skipped}`;
    },
  };

  return {
    /** Runs a slash command and returns the reply text. */
    async execute(interaction) {
      if (!interaction.guildId) return 'Use me inside a server.';
      const handler = handlers[interaction.commandName];
      return handler ? handler(interaction) : 'Unknown command.';
    },

    /** Returns up to 25 {name, value} choices for the option being typed. */
    autocomplete(interaction) {
      const typed = String(interaction.options.getFocused() ?? '');

      if (interaction.commandName === 'play') {
        return searchBooks(library.books, typed)
          .slice(0, 25)
          .map((b) => ({ name: clip(b.title), value: b.id }));
      }

      if (interaction.commandName === 'bookmark') {
        const session = active(interaction.guildId);
        if (!session) return [];
        return db.listBookmarks(interaction.guildId, session.book.id)
          .map((m) => ({ name: clip(`${formatTime(m.position)} ${m.label}`), value: m.id }))
          .filter((c) => c.name.toLowerCase().includes(typed.toLowerCase()))
          .slice(0, 25);
      }

      return [];
    },
  };
}

// Discord rejects choice names longer than 100 characters.
const clip = (text) => (text.length > 100 ? `${text.slice(0, 99)}…` : text);
