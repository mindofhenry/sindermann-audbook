// Test doubles for the two things that need a live Discord connection:
// the voice audio player and the slash-command interaction object.
import { buildTimeline } from '../../src/timeline.js';
import { Session } from '../../src/session.js';

// Records what the session asked it to play and lets a test move the
// playback clock by hand.
export class FakeAudio {
  requests = [];
  paused = false;
  stopped = false;
  #played = 0;
  #onEnd = () => {};

  play(request) { this.requests.push(request); this.#played = 0; this.paused = false; this.stopped = false; }
  pause() { this.paused = true; }
  unpause() { this.paused = false; }
  stop() { this.stopped = true; }
  playedMs() { return this.#played; }
  onEnd(callback) { this.#onEnd = callback; }

  get last() { return this.requests.at(-1); }
  advance(seconds) { this.#played += seconds * 1000; }
  endOfFile(ok = true) { this.#onEnd({ ok }); }
}

// Files of 100s, 200s and 50s. Chapters: One 0-100, Two 100-300, Three 300-350.
export const bookA = () => ({
  id: 'book-a',
  title: 'Book A',
  timeline: buildTimeline([
    { path: '/b/1.mp3', title: 'One', duration: 100, chapters: [] },
    { path: '/b/2.mp3', title: 'Two', duration: 200, chapters: [] },
    { path: '/b/3.mp3', title: 'Three', duration: 50, chapters: [] },
  ]),
});

export const bookB = () => ({
  id: 'book-b',
  title: 'Second Story',
  timeline: buildTimeline([{ path: '/c/all.m4b', title: 'Second Story', duration: 1000, chapters: [] }]),
});

// Same surface as the real voice SessionManager, minus Discord.
export function fakeSessions(db) {
  const sessions = new Map();
  const audios = new Map();
  const left = [];
  return {
    left,
    audio: (guildId) => audios.get(guildId),
    get: (guildId) => sessions.get(guildId) ?? null,
    join: async (channel) => {
      const guildId = channel.guild.id;
      if (!sessions.has(guildId)) {
        const audio = new FakeAudio();
        audios.set(guildId, audio);
        sessions.set(guildId, new Session({ guildId, db, audio }));
      }
      return sessions.get(guildId);
    },
    leave: (guildId) => {
      sessions.get(guildId)?.stop();
      sessions.delete(guildId);
      left.push(guildId);
    },
  };
}

// The slice of a discord.js ChatInputCommandInteraction the handlers read.
export function interaction(commandName, options = {}, { inVoice = true, guildId = 'g1', subcommand = null, focused = '' } = {}) {
  return {
    commandName,
    guildId,
    user: { id: 'u1' },
    member: { voice: { channel: inVoice ? { id: 'vc1', guild: { id: guildId } } : null } },
    options: {
      getString: (name) => (options[name] === undefined ? null : String(options[name])),
      getInteger: (name) => options[name] ?? null,
      getNumber: (name) => options[name] ?? null,
      getSubcommand: () => subcommand,
      getFocused: () => focused,
    },
  };
}
