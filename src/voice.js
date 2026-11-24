// Owns the voice connection and the Session for each server.
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { DiscordAudio } from './audio.js';
import { Session } from './session.js';

export class SessionManager {
  #db;
  #notify;
  #onLeave;
  #entries = new Map(); // guildId -> { session, audio, connection }

  /**
   * @param {{ db: object, notify?: (guildId: string, text: string) => void, onLeave?: (guildId: string) => void }} options
   */
  constructor({ db, notify = () => {}, onLeave = () => {} }) {
    this.#db = db;
    this.#notify = notify;
    this.#onLeave = onLeave;
  }

  get(guildId) {
    return this.#entries.get(guildId)?.session ?? null;
  }

  /** Join (or move to) a voice channel and return the server's session. */
  async join(channel) {
    const guildId = channel.guild.id;
    // For a guild that is already connected this returns the same connection
    // object and moves it to the requested channel.
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.leave(guildId);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw new Error('I could not connect to that voice channel. Check that I have Connect and Speak permissions.');
    }

    let entry = this.#entries.get(guildId);
    if (!entry) {
      const audio = new DiscordAudio();
      const session = new Session({
        guildId,
        db: this.#db,
        audio,
        onFinished: (book) => {
          this.#notify(guildId, `Finished **${book.title}**.`);
          this.leave(guildId);
        },
        onError: (message) => {
          this.#notify(guildId, `${message}. Your place is saved.`);
          this.leave(guildId);
        },
      });
      entry = { session, audio, connection: null };
      this.#entries.set(guildId, entry);
    }

    if (entry.connection !== connection) {
      entry.connection = connection;
      connection.subscribe(entry.audio.player);
      this.#watch(guildId, connection);
    }
    return entry.session;
  }

  /** Save, stop playback and disconnect. Safe to call when not connected. */
  leave(guildId) {
    const entry = this.#entries.get(guildId);
    if (!entry) return;
    this.#entries.delete(guildId);
    entry.session.stop();
    if (entry.connection && entry.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      entry.connection.destroy();
    }
    this.#onLeave(guildId);
  }

  saveAll() {
    for (const { session } of this.#entries.values()) {
      if (session.state === 'playing') session.save();
    }
  }

  leaveAll() {
    for (const guildId of [...this.#entries.keys()]) this.leave(guildId);
  }

  #watch(guildId, connection) {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Discord moves bots between voice servers; that shows up as a brief
        // disconnect which recovers on its own within a few seconds.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.leave(guildId); // kicked, or the channel was deleted
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.#entries.get(guildId)?.connection === connection) this.leave(guildId);
    });
  }
}
