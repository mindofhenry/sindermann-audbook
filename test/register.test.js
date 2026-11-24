import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCommands } from '../src/register.js';

const DEFS = [{ name: 'play' }, { name: 'pause' }];

function fakes({ failing = [] } = {}) {
  const calls = [];
  const application = { commands: { set: async (defs, guildId) => { calls.push(['app', guildId ?? 'global', defs.length]); } } };
  const guild = (id) => ({
    id,
    commands: { set: async (defs) => { if (failing.includes(id)) throw new Error('Missing Access'); calls.push(['guild', id, defs.length]); } },
  });
  return { calls, application, guild };
}

test('without a configured server, commands go to every server the bot is in', async () => {
  const { calls, application, guild } = fakes();
  await registerCommands({ application, guilds: [guild('g1'), guild('g2')], definitions: DEFS });
  assert.deepEqual(calls.filter((c) => c[0] === 'guild'), [['guild', 'g1', 2], ['guild', 'g2', 2]]);
});

test('without a configured server, global commands are cleared so nothing shows twice', async () => {
  const { calls, application, guild } = fakes();
  await registerCommands({ application, guilds: [guild('g1')], definitions: DEFS });
  assert.deepEqual(calls[0], ['app', 'global', 0]);
});

test('one server refusing does not stop the others, and is reported', async () => {
  const { calls, application, guild } = fakes({ failing: ['g1'] });
  const problems = [];
  const result = await registerCommands({
    application, guilds: [guild('g1'), guild('g2')], definitions: DEFS, onError: (id, err) => problems.push([id, err.message]),
  });
  assert.deepEqual(calls.filter((c) => c[0] === 'guild'), [['guild', 'g2', 2]]);
  assert.deepEqual(problems, [['g1', 'Missing Access']]);
  assert.deepEqual(result, { registered: 1, failed: 1 });
});

test('with a configured server, only that server is touched', async () => {
  const { calls, application, guild } = fakes();
  const result = await registerCommands({ application, guilds: [guild('g1'), guild('g2')], definitions: DEFS, guildId: 'g2' });
  assert.deepEqual(calls, [['app', 'g2', 2]]);
  assert.deepEqual(result, { registered: 1, failed: 0 });
});
