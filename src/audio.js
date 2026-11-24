// The audio side of a session: an @discordjs/voice player fed by ffmpeg.
// Implements the small interface Session expects:
//   play({path, offset, speed}), pause(), unpause(), stop(), playedMs(), onEnd(cb)
import { AudioPlayerStatus, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource } from '@discordjs/voice';
import { openStream } from './ffmpeg.js';

export class DiscordAudio {
  #player;
  #log;
  #resource = null;
  #source = null;
  #generation = 0; // bumps on every play/stop so late events can be ignored
  #onEnd = () => {};

  constructor({ noSubscriber = NoSubscriberBehavior.Pause, log = console.error } = {}) {
    this.#log = log;
    // Pause (the default) means a dropped voice connection holds the book
    // in place instead of reading it out to an empty room.
    this.#player = createAudioPlayer({ behaviors: { noSubscriber } });

    this.#player.on(AudioPlayerStatus.Idle, (oldState) => {
      if (oldState.resource !== this.#resource) return; // an older stream we already replaced
      const generation = this.#generation;
      // The stream is drained; ffmpeg's exit code says whether that was the
      // real end of the file or a failure to read it.
      this.#source.done.then((result) => {
        if (generation === this.#generation) this.#onEnd(result);
      });
    });
    this.#player.on('error', (err) => this.#log(`[audio] ${err.message}`));
  }

  /** The player a voice connection subscribes to. */
  get player() {
    return this.#player;
  }

  play(request) {
    this.#generation += 1;
    this.#source?.kill();
    this.#source = openStream(request, { log: this.#log });
    // ffmpeg already produced Ogg Opus, so Discord gets it without re-encoding.
    this.#resource = createAudioResource(this.#source.stream, { inputType: StreamType.OggOpus });
    this.#player.play(this.#resource);
  }

  pause() {
    this.#player.pause(true);
  }

  unpause() {
    this.#player.unpause();
  }

  stop() {
    this.#generation += 1;
    this.#source?.kill();
    this.#source = null;
    this.#resource = null;
    this.#player.stop(true);
  }

  /** Milliseconds of audio actually sent since the last play(). */
  playedMs() {
    return this.#resource?.playbackDuration ?? 0;
  }

  onEnd(callback) {
    this.#onEnd = callback;
  }
}
