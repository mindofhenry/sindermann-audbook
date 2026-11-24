// Puts the slash commands where users will see them.
//
// Server-scoped commands appear instantly, global ones can lag, so by default
// the bot registers in every server it is in and keeps the global list empty.

export async function registerCommands({ application, guilds, definitions, guildId = null, onError = () => {} }) {
  if (guildId) {
    await application.commands.set(definitions, guildId);
    return { registered: 1, failed: 0 };
  }

  await application.commands.set([]); // a global copy would show every command twice
  let registered = 0;
  let failed = 0;
  for (const guild of guilds) {
    try {
      await guild.commands.set(definitions);
      registered += 1;
    } catch (err) {
      failed += 1;
      onError(guild.id, err);
    }
  }
  return { registered, failed };
}
