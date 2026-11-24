// Entry point: wires config, database, library, voice and commands to Discord.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { createCommands, definitions } from './commands.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { scanLibrary } from './library.js';
import { createPresenceWatcher } from './presence.js';
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
const commands = createCommands({ db, sessions, library });

client.once(Events.ClientReady, async (ready) => {
  console.log(`[bot] logged in as ${ready.user.tag}`);
  // Permissions: View Channel, Send Messages, Connect, Speak.
  console.log(`[bot] Invite: https://discord.com/oauth2/authorize?client_id=${ready.application.id}&scope=bot+applications.commands&permissions=3148800`);
  await library.rescan();
  await ready.application.commands.set(definitions, ...(config.guildId ? [config.guildId] : []));
  console.log(`[bot] ${definitions.length} commands registered ${config.guildId ? `to guild ${config.guildId}` : 'globally (can take up to an hour to appear)'}`);
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
    await interaction.deferReply();
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

const saver = setInterval(() => sessions.saveAll(), SAVE_EVERY_MS);

function shutdown(signal) {
  console.log(`[bot] ${signal} received, saving positions`);
  clearInterval(saver);
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
