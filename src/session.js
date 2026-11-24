// Playback state for one Discord server: which book, where in it, how fast.
//
// The session knows nothing about Discord. It drives an `audio` object with
// play/pause/unpause/stop/playedMs/onEnd, which keeps all of the resume, seek
// and chapter logic testable without a voice connection.
import { chapterIndexAt, locate, nextChapterStart, prevChapterStart } from './timeline.js';

export class Session {
  book = null;
  state = 'idle'; // 'idle' | 'playing' | 'paused'
  speed = 1;

  #guildId;
  #db;
  #audio;
  #onFinished;
  #onError;
  #rewind;
  #segmentStart = 0; // book position where the current ffmpeg stream began
  #fileIndex = 0;

  constructor({ guildId, db, audio, onFinished = () => {}, onError = () => {}, rewind = 5 }) {
    this.#guildId = guildId;
    this.#db = db;
    this.#audio = audio;
    this.#onFinished = onFinished;
    this.#onError = onError;
    this.#rewind = rewind;
    audio.onEnd((result) => this.#handleFileEnd(result));
  }

  /** Load a book. Without an explicit position, resume from saved progress. */
  start(book, { position } = {}) {
    if (this.book) this.save();
    this.book = book;
    this.speed = this.#db.getSpeed(this.#guildId);

    let from = position;
    if (from === undefined) {
      const saved = this.#db.getProgress(this.#guildId, book.id)?.position ?? 0;
      // Back up a little on resume so the listener can pick up the thread.
      from = saved >= book.timeline.duration ? 0 : Math.max(0, saved - this.#rewind);
    }
    this.#playFrom(from);
  }

  position() {
    if (!this.book) return 0;
    const played = (this.#audio.playedMs() / 1000) * this.speed;
    return Math.min(this.book.timeline.duration, this.#segmentStart + played);
  }

  pause() {
    if (this.state !== 'playing') return false;
    this.save();
    this.#audio.pause();
    this.state = 'paused';
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.#audio.unpause();
    this.state = 'playing';
    return true;
  }

  stop() {
    this.save();
    this.#reset();
  }

  seek(position) {
    if (!this.book) return;
    this.#playFrom(Math.max(0, position));
  }

  skip(deltaSeconds) {
    this.seek(this.position() + deltaSeconds);
  }

  nextChapter() {
    if (!this.book) return null;
    const start = nextChapterStart(this.book.timeline, this.position());
    if (start === null) return null;
    this.#playFrom(start);
    return this.#chapterAt(start);
  }

  prevChapter() {
    if (!this.book) return null;
    const start = prevChapterStart(this.book.timeline, this.position());
    this.#playFrom(start);
    return this.#chapterAt(start);
  }

  /** Zero-based chapter index. */
  goToChapter(index) {
    const chapter = this.book?.timeline.chapters[index];
    if (!chapter || index < 0) return null;
    this.#playFrom(chapter.start);
    return chapter;
  }

  setSpeed(speed) {
    const wasPaused = this.state === 'paused';
    const at = this.position();
    this.speed = speed;
    this.#db.setSpeed(this.#guildId, speed);
    if (!this.book) return;
    // Speed is an ffmpeg filter, so the stream has to restart at this spot.
    this.#playFrom(at);
    if (wasPaused) {
      this.#audio.pause();
      this.state = 'paused';
    }
  }

  save() {
    if (!this.book) return;
    this.#db.saveProgress(this.#guildId, this.book.id, this.position());
  }

  status() {
    if (!this.book) return null;
    const { timeline } = this.book;
    const position = this.position();
    const chapterIndex = chapterIndexAt(timeline, position);
    return {
      book: this.book,
      position,
      duration: timeline.duration,
      chapterIndex,
      chapter: timeline.chapters[chapterIndex],
      chapterCount: timeline.chapters.length,
      state: this.state,
      speed: this.speed,
    };
  }

  #chapterAt(position) {
    const { timeline } = this.book;
    return timeline.chapters[chapterIndexAt(timeline, position)];
  }

  #playFrom(position) {
    const spot = locate(this.book.timeline, position);
    if (!spot) return this.#finish();
    this.#segmentStart = position;
    this.#fileIndex = spot.fileIndex;
    this.#audio.play({
      path: this.book.timeline.files[spot.fileIndex].path,
      offset: spot.offset,
      speed: this.speed,
    });
    this.state = 'playing';
  }

  #handleFileEnd({ ok }) {
    if (!this.book || this.state === 'idle') return;

    if (!ok) {
      // Do not roll on to the next file: a missing disk would otherwise
      // "finish" the whole book in a second and wipe the listener's place.
      const path = this.book.timeline.files[this.#fileIndex].path;
      this.save();
      this.#reset();
      this.#onError(`Could not play ${path}`);
      return;
    }

    const next = this.book.timeline.files[this.#fileIndex + 1];
    if (next) this.#playFrom(next.start);
    else this.#finish();
  }

  #finish() {
    const book = this.book;
    this.#db.saveProgress(this.#guildId, book.id, book.timeline.duration);
    this.#reset();
    this.#onFinished(book);
  }

  #reset() {
    this.#audio.stop();
    this.book = null;
    this.state = 'idle';
    this.#segmentStart = 0;
    this.#fileIndex = 0;
  }
}
