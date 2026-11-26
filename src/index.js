// Entry point: wires config, database, library, voice and commands to Discord.
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { createCommands, definitions } from './commands.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { scanLibrary } from './library.js';
import { createCatalog } from './portal/catalog.js';
import { createPortal } from './portal/server.js';
import { createProwlarr } from './portal/prowlarr.js';
import { createSeerr } from './portal/seerr.js';
import { addToShelf } from './portal/shelf.js';
import { createUploads } from './portal/upload.js';
import { createPresenceWatcher } from './presence.js';
import { registerCommands } from './register.js';
import { SessionManager } from './voice.js';

const SAVE_EVERY_MS = 10_000;

// Startup problems are configuration problems: say what to fix, no stack trace.
function fatal(message) {
  console.error(`[bot] ${message}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  fatal(err.message);
}
const db = openDb(config.dbFile);

const library = {
  books: [],
  async rescan() {
    const warnings = [];
    this.books = await scanLibrary(config.booksDir, { onWarning: (w) => warnings.push(w) });
    for (const warning of warnings) console.warn(`[library] ${warning}`);
    console.log(`[library] ${this.books.length} books in ${config.booksDir}`);
    return { count: this.books.length, warnings };
  },
};

const client = new Client({
  // Guilds: slash commands. GuildVoiceStates: join voice and see who is listening.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Where to post "Finished ..." notices: the channel of the last command.
const lastChannel = new Map();
const notify = (guildId, text) => {
  const channel = client.channels.cache.get(lastChannel.get(guildId));
  channel?.send?.({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
};

let presence;
const sessions = new SessionManager({ db, notify, onLeave: (guildId) => presence.forget(guildId) });
presence = createPresenceWatcher({ sessions, leaveAfterMs: config.emptyLeaveMs });
const commands = createCommands({ db, sessions, library, shelfUrl: config.shelfUrl });

client.once(Events.ClientReady, async (ready) => {
  console.log(`[bot] logged in as ${ready.user.tag}`);
  // Permissions: View Channel, Send Messages, Connect, Speak.
  console.log(`[bot] Invite: https://discord.com/oauth2/authorize?client_id=${ready.application.id}&scope=bot+applications.commands&permissions=3148800`);
  console.log(`[bot] in ${ready.guilds.cache.size} server(s): ${ready.guilds.cache.map((g) => g.name).join(', ') || 'none yet, use the invite link'}`);
  await library.rescan();
  const result = await registerCommands({
    application: ready.application,
    guilds: [...ready.guilds.cache.values()],
    definitions,
    guildId: config.guildId,
    onError: (guildId, err) => console.error(`[bot] could not register commands in server ${guildId}: ${err.message}`),
  });
  console.log(`[bot] ${definitions.length} commands registered in ${result.registered} server(s)${result.failed ? `, ${result.failed} failed` : ''}`);
});

// Invited to a new server while running: give it the commands right away.
client.on(Events.GuildCreate, (guild) => {
  if (config.guildId) return;
  guild.commands.set(definitions).catch((err) => console.error(`[bot] could not register commands in server ${guild.id}: ${err.message}`));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      await interaction.respond(commands.autocomplete(interaction));
    } catch (err) {
      console.error(`[bot] autocomplete failed: ${err.message}`);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  try {
    // Joining voice can take longer than Discord's 3 second reply window.
    await interaction.deferReply(commands.isPrivate(interaction.commandName) ? { flags: MessageFlags.Ephemeral } : undefined);
    if (interaction.guildId) lastChannel.set(interaction.guildId, interaction.channelId);
    const content = await commands.execute(interaction);
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`[bot] /${interaction.commandName} failed:`, err);
    await interaction.editReply({ content: `That did not work: ${err.message}` }).catch(() => {});
  }
});

// Pause when the bot is left alone in its channel, resume when someone returns.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = newState.guild;
  const botChannelId = guild.members.me?.voice?.channelId;
  if (!botChannelId || !sessions.get(guild.id)) return;
  const listeners = guild.voiceStates.cache.filter(
    (state) => state.channelId === botChannelId && state.id !== client.user.id && !state.member?.user.bot,
  ).size;
  presence.update(guild.id, listeners);
});

// Friends homepage: search the public-domain catalogs and add books.
let portal = null;
if (config.portalPort) {
  const shelves = {
    audiobook: { root: config.booksDir, allowedHosts: ['archive.org'] },
    ebook: { root: config.ebooksDir, allowedHosts: ['gutenberg.org'] },
  };
  const uploads = config.upload ? createUploads({ root: config.booksDir, maxBytes: config.upload.maxBytes }) : null;
  await uploads?.sweep();
  portal = createPortal({
    catalog: createCatalog({ types: config.portalTypes }),
    uploads,
    uploaders: config.upload?.emails ?? [],
    library,
    listenUrl: config.listenUrl,
    prowlarr: config.prowlarr ? createProwlarr(config.prowlarr) : null,
    seerr: config.jellyseerr ? createSeerr(config.jellyseerr) : null,
    log: console.log,
    addBook: (type, plan, onProgress) => addToShelf(plan, shelves[type].root, { allowedHosts: shelves[type].allowedHosts, onProgress }),
  });
  portal.server.listen(config.portalPort, () => console.log(`[portal] homepage listening on port ${config.portalPort}`));
  if (config.prowlarr) console.log(`[portal] Prowlarr search on (${new URL(config.prowlarr.url).host})`);
  if (config.jellyseerr) console.log(`[portal] movies and TV on (${new URL(config.jellyseerr.url).host})`);
  if (config.upload) console.log(`[portal] uploads on for ${config.upload.emails.includes('*') ? 'everybody' : `${config.upload.emails.length} ${config.upload.emails.length === 1 ? 'person' : 'people'}`}, up to ${(config.upload.maxBytes / 1024 ** 3).toFixed(1)} GB a book`);
}

const saver = setInterval(() => sessions.saveAll(), SAVE_EVERY_MS);

function shutdown(signal) {
  console.log(`[bot] ${signal} received, saving positions`);
  clearInterval(saver);
  portal?.server.close();
  sessions.leaveAll(); // each leave saves the current position
  db.close();
  client.destroy().finally(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(generateDependencyReport());
try {
  await client.login(config.token);
} catch (err) {
  fatal(err.code === 'TokenInvalid'
    ? 'Discord rejected DISCORD_TOKEN. Copy the token again from the Developer Portal (Bot > Reset Token).'
    : `Could not log in to Discord: ${err.message}`);
}
