# Audiobook Bot

A self-hosted Discord bot that plays your own audiobooks in a voice channel and never loses your place.

Music bots treat a book like a playlist: stop it and you start over. This one is built around the three things an audiobook listener needs:

- **Resume.** Position is saved every 10 seconds and on every pause, stop, disconnect and restart. `/play` picks up 5 seconds before where you stopped.
- **Chapters.** `/next`, `/prev` and `/chapter 12` work the same for a folder of MP3s and for a single `.m4b` with embedded chapters.
- **Bookmarks.** Save a spot with a note, list them per book, jump back.

It also pauses itself when the voice channel empties, and resumes when someone comes back.

## Commands

| Command | What it does |
| --- | --- |
| `/library` | List books with length and progress |
| `/play book` | Play a book from the saved position (autocomplete on title) |
| `/pause` `/resume` `/stop` | Pause, continue, or save and leave. `/resume` with nothing loaded reopens the last book |
| `/nowplaying` | Book, chapter, position, progress bar |
| `/next` `/prev` | Next chapter. Start of this chapter, or the previous one if you are within 5 seconds of the start |
| `/chapters` `/chapter number` | List chapters, jump to one |
| `/back [seconds]` `/forward [seconds]` | Skip, 30 seconds by default |
| `/seek time` | Jump to `1:23:45`, `12:30`, `90m` or plain seconds |
| `/speed rate` | 0.75x to 2x, remembered per server |
| `/bookmark add [label]` `list` `goto` `remove` | Bookmarks for the current book |
| `/rescan` | Reload the library after adding books (Manage Server permission) |

## Install

Needs a Linux host with Docker. About 10 minutes, most of it the image build.

1. **Create the bot.** [Discord Developer Portal](https://discord.com/developers/applications) > New Application > Bot > Reset Token. Copy the token. No privileged intents are needed.
2. **Get the code and run the installer.** It asks for the token once and stores it in `.env` (owner-readable only).
   ```bash
   git clone https://github.com/mindofhenry/sindermann-audbook.git /opt/audiobook-bot
   cd /opt/audiobook-bot && ./install.sh
   ```
3. **Invite it.** The installer prints an invite link. Open it and pick your server.
4. **Add a book.** Put each book in its own folder under `books/`, then run `/rescan`.
   ```
   books/
     Pride and Prejudice/        folder of files: one chapter per file
       01 - Chapter 1.mp3
       02 - Chapter 2.mp3
     Dracula.m4b                 single file: embedded chapters are used
     Jane Austen/Emma/...        Author/Book nesting also works
   ```
   [LibriVox](https://librivox.org) has free public-domain books: download the "Whole book" zip and unzip it into `books/`. Supported: mp3, m4b, m4a, aac, ogg, opus, flac, wav. DRM-locked files (Audible `.aax`) will not play.

Optional settings live in `.env` (see `.env.example`). Slash commands register in every server the bot is in and appear straight away.

### Day to day

```bash
docker compose logs -f          # watch the log
git pull && ./install.sh        # update (keeps .env, data/ and books/)
docker compose down             # stop
cp data/audiobook.db backup.db  # back up positions and bookmarks
```

## Friends homepage

The same container serves a small web page on `127.0.0.1:8090`: search LibriVox audiobooks, press "Add to shelf", and the book downloads to the server and is playable in Discord straight away. Only public-domain items can be added. Project Gutenberg ebook search exists behind `PORTAL_EBOOKS=on`, but Gutenberg refused requests from the test server, so it is off by default. Audiobookshelf runs beside it on `127.0.0.1:13378` as the web player and ebook reader for the same folders.

Both ports listen on localhost only. Publish them through a tunnel that has a login in front (for example Cloudflare Tunnel with Cloudflare Access). The homepage has no login of its own.

## How it works

```
Discord ──slash command──> commands.js ──> Session (one per server)
                                             │  position, chapters, speed
                                             ▼
   SQLite  <── save every 10s ──   audio.js ──> ffmpeg ──Ogg Opus──> voice channel
 (data/audiobook.db)                            -ss seek, atempo speed
```

| File | Job |
| --- | --- |
| `src/timeline.js` | Turns a book's files into one clock and a flat chapter list |
| `src/library.js`, `src/probe.js` | Scan `books/`, read durations and chapters with ffprobe |
| `src/session.js` | Playback state machine: resume, seek, chapter skip, end of file, end of book |
| `src/audio.js`, `src/ffmpeg.js` | One ffmpeg process per segment, fed to the Discord voice player |
| `src/db.js` | Progress, bookmarks and speed in SQLite |
| `src/commands.js`, `src/views.js` | Slash commands and reply text |
| `src/presence.js` | Pause on empty channel, leave after a grace period |
| `src/register.js` | Registers slash commands per server |
| `src/portal/` | Friends homepage: catalog search, safe downloads, web page |
| `src/voice.js`, `src/index.js` | Discord wiring |

### Decisions worth knowing

- **ffmpeg does the seeking and encoding.** Each seek, chapter jump or speed change starts a new ffmpeg at the right offset and emits Ogg Opus, which Discord accepts as is. Node only forwards bytes, so the bot has no native audio modules to compile.
- **One clock per book.** A 40-file MP3 book and a single m4b become the same thing: a position in seconds plus a chapter list. Every feature is written once against that.
- **Built-in SQLite (`node:sqlite`).** No database server and no native module. State is one file you can copy.
- **Progress is per server, not per user.** A voice channel has one stream, so "our place in this book" is the unit that matches how it is used.
- **A file that fails to play stops the book instead of skipping ahead.** If the books disk disappears, the bot must not race through every file and mark the book finished.
- **Docker, nothing exposed.** The bot only makes outbound connections, and the homepage binds to localhost.

## Tests

```bash
npm install && npm test
```

191 tests, written first. They build a real library with ffmpeg (MP3 folder, nested folder, m4b with chapters), run the real ffmpeg pipeline and the real `@discordjs/voice` player, and drive every slash command through a fake interaction. Only the network connection to Discord is replaced.

## Limits

- One book at a time per server.
- Chapter titles come from file tags or file names. Badly tagged files give ugly chapter names.
- Voice needs outbound UDP to Discord. It works on a normal VPS; some VPNs and strict firewalls block it.

## Stack

Node 22, discord.js 14, @discordjs/voice 0.19 (with DAVE end-to-end encryption support), ffmpeg, SQLite. MIT licence.
