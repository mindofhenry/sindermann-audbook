// A book is one or more audio files played back to back. The timeline turns
// that into a single clock ("book position" in seconds) plus a flat chapter
// list, so resume, seek and chapter skip never care how the files are split.

/**
 * @param {{path:string,title:string,duration:number,chapters:{title:string,start:number,end:number}[]}[]} tracks
 */
export function buildTimeline(tracks) {
  const files = [];
  const chapters = [];
  let cursor = 0;

  for (const track of tracks) {
    files.push({ path: track.path, start: cursor, duration: track.duration });

    if (track.chapters.length > 0) {
      for (const ch of track.chapters) {
        chapters.push({ title: ch.title, start: cursor + ch.start, end: cursor + ch.end });
      }
    } else {
      chapters.push({ title: track.title, start: cursor, end: cursor + track.duration });
    }
    cursor += track.duration;
  }

  return { duration: cursor, files, chapters };
}

/** Book position -> which file, and how far into it. Null once the book is over. */
export function locate(timeline, position) {
  const pos = Math.max(0, position);
  if (pos >= timeline.duration) return null;
  for (let i = timeline.files.length - 1; i >= 0; i--) {
    const file = timeline.files[i];
    if (pos >= file.start) return { fileIndex: i, offset: pos - file.start };
  }
  return null;
}

export function chapterIndexAt(timeline, position) {
  const pos = Math.max(0, position);
  for (let i = timeline.chapters.length - 1; i >= 0; i--) {
    if (pos >= timeline.chapters[i].start) return i;
  }
  return 0;
}

/** Start of the following chapter, or null when already in the last one. */
export function nextChapterStart(timeline, position) {
  const next = timeline.chapters[chapterIndexAt(timeline, position) + 1];
  return next ? next.start : null;
}

/**
 * Like the back button on a music player: restart the current chapter, unless
 * we are within `threshold` seconds of its start, then go to the one before.
 */
export function prevChapterStart(timeline, position, threshold = 5) {
  const index = chapterIndexAt(timeline, position);
  const current = timeline.chapters[index];
  if (position - current.start > threshold || index === 0) return current.start;
  return timeline.chapters[index - 1].start;
}
