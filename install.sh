#!/usr/bin/env bash
# Installs or updates the audiobook bot on a Linux host that has Docker.
# Safe to run again: it keeps .env, data/ and books/ and rebuilds the image.
#
#   ./install.sh                      interactive (asks for the bot token once)
#   DISCORD_TOKEN=... ./install.sh    non-interactive
set -euo pipefail

cd "$(dirname "$0")"

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. Docker must already be here (it is on the Linode: n8n runs in it) ---
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing. Install the docker-compose-plugin package."
docker info >/dev/null 2>&1 || fail "Cannot talk to Docker. Run this as root or as a user in the docker group."

# --- 2. Settings: write .env once, never overwrite it ---
if [ ! -f .env ]; then
  token="${DISCORD_TOKEN:-}"
  guild="${GUILD_ID:-}"
  if [ -z "$token" ]; then
    [ -t 0 ] || fail "No .env yet and no terminal to ask for the token. Run: DISCORD_TOKEN=... ./install.sh"
    say "Paste the bot token (Developer Portal > your app > Bot > Reset Token). Input is hidden."
    read -r -s -p "DISCORD_TOKEN: " token; echo
    read -r -p "Limit commands to one server ID (optional, Enter for all servers): " guild
  fi
  [ -n "$token" ] || fail "The token was empty."
  umask 077   # .env holds a secret: readable by the owner only
  {
    echo "DISCORD_TOKEN=$token"
    echo "GUILD_ID=$guild"
    echo "BOOKS_PATH=${BOOKS_PATH:-./books}"
    echo "EMPTY_LEAVE_MINUTES=5"
    echo "LISTEN_URL=${LISTEN_URL:-}"
  } > .env
  umask 022
  say "Wrote .env"
else
  say "Keeping the existing .env"
fi

# --- 3. Folders: books are read-only to the bot, data/ holds the SQLite file ---
books_path="$(grep -E '^BOOKS_PATH=' .env | tail -1 | cut -d= -f2-)"
books_path="${books_path:-./books}"
mkdir -p data ebooks abs/config abs/metadata "$books_path"

# The bot runs as the unprivileged "node" user (uid 1000). It writes the
# database, and the homepage adds books, so these folders must be its own.
own() {
  [ "$(stat -c %u "$1")" = "1000" ] && return 0
  if [ "$(id -u)" = "0" ]; then chown -R 1000:1000 "$1"; else sudo chown -R 1000:1000 "$1" || fail "Run: sudo chown -R 1000:1000 $1"; fi
}
own data
own ebooks
if [ "$books_path" = "./books" ]; then
  own "$books_path"
elif [ "$(stat -c %u "$books_path")" != "1000" ]; then
  echo "Note: $books_path is not owned by uid 1000, so the homepage cannot add audiobooks to it."
fi

# --- 4. Build and start ---
say "Building the image and starting the bot (first build takes a few minutes)"
docker compose up -d --build

# --- 5. Confirm it actually logged in ---
say "Waiting for the bot to log in"
for _ in $(seq 1 30); do
  logs="$(docker compose logs --no-color --tail 200 2>&1 || true)"
  if grep -q "logged in as" <<<"$logs"; then
    grep -E "logged in as|books in|commands registered|could not register|homepage listening|Invite:" <<<"$logs" | sed 's/^[^|]*| //' || true
    say "Done. Add books to: $(cd "$books_path" && pwd)   then run /rescan in Discord."
    exit 0
  fi
  if grep -qE "Discord rejected DISCORD_TOKEN|DISCORD_TOKEN is not set" <<<"$logs"; then
    docker compose stop >/dev/null 2>&1 || true
    fail "Discord rejected the token. Fix DISCORD_TOKEN in .env, then run ./install.sh again."
  fi
  sleep 2
done

docker compose logs --no-color --tail 30 || true
fail "The bot did not log in within 60 seconds. The log above shows why."
