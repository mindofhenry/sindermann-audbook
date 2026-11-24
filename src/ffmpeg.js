// One ffmpeg process per playing segment. ffmpeg does the seek (-ss), the
// speed change (atempo) and the Opus encode, so Node only forwards bytes and
// needs no native audio libraries.
import { spawn } from 'node:child_process';

export function ffmpegArgs({ path, offset, speed }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (offset > 0) args.push('-ss', offset.toFixed(3)); // before -i: fast seek
  args.push('-i', path, '-vn', '-map', '0:a:0'); // -vn drops embedded cover art
  if (speed !== 1) args.push('-filter:a', `atempo=${speed}`);
  args.push('-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1');
  return args;
}

/**
 * @returns {{ stream: import('node:stream').Readable, done: Promise<{ok: boolean}>, kill: () => void }}
 *   `done` resolves when ffmpeg exits. ok=false means it failed on its own
 *   (missing or unreadable file); a deliberate kill() still counts as ok.
 */
export function openStream(request, { log = console.error } = {}) {
  const child = spawn('ffmpeg', ffmpegArgs(request), { stdio: ['ignore', 'pipe', 'pipe'] });
  let killed = false;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  // The reader going away mid-stream (seek, stop) is expected, not an error.
  child.stdout.on('error', () => {});

  const done = new Promise((resolve) => {
    child.on('error', () => resolve({ ok: false })); // ffmpeg not installed
    child.on('close', (code) => {
      const ok = killed || code === 0;
      if (!ok && stderr.trim()) log(`[ffmpeg] ${stderr.trim()}`);
      resolve({ ok });
    });
  });

  return {
    stream: child.stdout,
    done,
    kill: () => {
      killed = true;
      child.kill('SIGKILL');
    },
  };
}
