import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../cloudflare/discord-oidc/worker.js';

const CLIENT = '1111';
const REDIRECT = 'https://team.cloudflareaccess.com/cdn-cgi/access/callback';
const GUILD = '9000';
const USER = { id: '42', username: 'reader', global_name: 'A Reader', discriminator: '0', email: 'reader@example.com', verified: true, avatar: 'abc', locale: 'en-US', mfa_enabled: true };

function fakeKV() {
  const map = new Map();
  return { writes: 0, get: async (key, opts) => (map.has(key) ? (opts?.type === 'json' ? JSON.parse(map.get(key)) : map.get(key)) : null), async put(key, value) { this.writes += 1; map.set(key, value); } };
}

// A stand-in for Discord's API. Records every call the worker makes.
function setup({ env = {}, user = USER, guilds = [GUILD, '7777'], roles = ['r-shelf', 'r-other'], tokenStatus = 200 } = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    if (u.hostname !== 'discord.com') throw new Error(`unexpected host ${u.hostname}`);
    if (u.pathname === '/api/v10/oauth2/token') return tokenStatus === 200 ? json({ access_token: 'user-access', token_type: 'Bearer', expires_in: 604800, refresh_token: 'user-refresh' }) : json({ error: 'invalid_grant' }, tokenStatus);
    const asBot = init.headers?.authorization?.startsWith('Bot ');
    if (asBot && init.headers.authorization !== 'Bot bot-token') return json({ message: '401: Unauthorized' }, 401);
    if (asBot && u.pathname === '/api/v10/users/@me') return json({ id: 'bot', bot: true });
    if (u.pathname === '/api/v10/users/@me') return json(user);
    if (u.pathname === '/api/v10/users/@me/guilds') return json(guilds.map((id) => ({ id, name: `g${id}` })));
    if (u.pathname === `/api/v10/guilds/${GUILD}/members/${user.id}`) return json({ roles });
    if (asBot && u.pathname === `/api/v10/guilds/${GUILD}`) return json({ id: GUILD });
    if (asBot && u.pathname.startsWith('/api/v10/guilds/')) return json({ message: 'Unknown Guild', code: 10004 }, 404);
    return json({ message: 'not found' }, 404);
  };
  const worker = createWorker({ fetch });
  const fullEnv = { KV: fakeKV(), DISCORD_CLIENT_ID: CLIENT, REDIRECT_URL: REDIRECT, DISCORD_CLIENT_SECRET: 'app-secret', DISCORD_TOKEN: 'bot-token', GUILD_IDS: GUILD, ...env };
  const get = (path) => worker.fetch(new Request(`https://bridge.example${path}`, { redirect: 'manual' }), fullEnv);
  const token = (code = 'the-code') => worker.fetch(new Request('https://bridge.example/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT, client_secret: 'whatever-access-sends' }),
  }), fullEnv);
  return { calls, get, token, env: fullEnv };
}

const b64 = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
async function verified(idToken, jwks) {
  const [h, p, s] = idToken.split('.');
  const key = await crypto.subtle.importKey('jwk', jwks.keys[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`));
  return { ok, header: b64(h), claims: b64(p) };
}

test('authorize sends the browser to Discord with the app, callback, state and scopes', async () => {
  const { get } = setup();
  const res = await get(`/authorize?client_id=${CLIENT}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&response_type=code`);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(to.searchParams.get('client_id'), CLIENT);
  assert.equal(to.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(to.searchParams.get('state'), 'xyz');
  assert.equal(to.searchParams.get('response_type'), 'code');
  assert.equal(to.searchParams.get('scope'), 'identify email guilds');
});

test('authorize refuses another app id or another callback address', async () => {
  const { get } = setup();
  assert.equal((await get(`/authorize?client_id=2222&redirect_uri=${encodeURIComponent(REDIRECT)}&state=x`)).status, 400);
  assert.equal((await get(`/authorize?client_id=${CLIENT}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&state=x`)).status, 400);
});

test('token returns an id_token signed by the key that /jwks.json publishes', async () => {
  const { get, token } = setup();
  const res = await token();
  assert.equal(res.status, 200);
  const body = await res.json();
  const jwks = await (await get('/jwks.json')).json();
  const { ok, header, claims } = await verified(body.id_token, jwks);
  assert.equal(ok, true);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.kid, jwks.keys[0].kid);
  assert.equal(claims.aud, CLIENT);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 3601);
});

test('the id_token says who the person is, which servers they are in, and their roles', async () => {
  const { token } = setup();
  const claims = b64((await (await token()).json()).id_token.split('.')[1]);
  assert.equal(claims.sub, '42');
  assert.equal(claims.id, '42');
  assert.equal(claims.email, 'reader@example.com');
  assert.equal(claims.name, 'A Reader');
  assert.equal(claims.preferred_username, 'reader');
  assert.deepEqual(claims.guilds, [GUILD, '7777']);
  assert.deepEqual(claims[`roles:${GUILD}`], ['r-shelf', 'r-other']);
});

test('nothing else from the Discord profile is passed on', async () => {
  const { token } = setup();
  const claims = b64((await (await token()).json()).id_token.split('.')[1]);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'email', 'exp', 'guilds', 'iat', 'id', 'iss', 'name', 'preferred_username', `roles:${GUILD}`, 'sub'].sort());
});

test('the code is exchanged with the app secret from the environment and the fixed callback', async () => {
  const { calls, token } = setup();
  await token('abc123');
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url.pathname, '/api/v10/oauth2/token');
  assert.equal(sent.get('code'), 'abc123');
  assert.equal(sent.get('client_id'), CLIENT);
  assert.equal(sent.get('client_secret'), 'app-secret');
  assert.equal(sent.get('redirect_uri'), REDIRECT);
  assert.equal(sent.get('grant_type'), 'authorization_code');
});

test('Discord tokens are not handed back to the caller', async () => {
  const { token } = setup();
  const text = await (await token()).text();
  assert.doesNotMatch(text, /user-access|user-refresh|app-secret|bot-token/);
});

test('a code Discord rejects is a 400 with no id_token', async () => {
  const { calls, token } = setup({ tokenStatus: 400 });
  const res = await token();
  assert.equal(res.status, 400);
  assert.doesNotMatch(await res.text(), /id_token/);
  assert.equal(calls.length, 1); // stops before asking who the user is
});

test('a missing code is a 400 without calling Discord', async () => {
  const { calls, token } = setup();
  assert.equal((await token('')).status, 400);
  assert.equal(calls.length, 0);
});

test('an account with an unverified email is refused', async () => {
  const { token } = setup({ user: { ...USER, verified: false } });
  assert.equal((await token()).status, 400);
});

test('roles are only looked up for servers the person is in', async () => {
  const { calls, token } = setup({ guilds: ['7777'] });
  const claims = b64((await (await token()).json()).id_token.split('.')[1]);
  assert.equal(`roles:${GUILD}` in claims, false);
  assert.equal(calls.some((c) => c.url.pathname.includes('/members/')), false);
});

test('roles are looked up with the bot token', async () => {
  const { calls, token } = setup();
  await token();
  const lookup = calls.find((c) => c.url.pathname.includes('/members/'));
  assert.equal(lookup.init.headers.authorization, 'Bot bot-token');
});

test('without a bot token there are no role claims, but servers are still listed', async () => {
  const { token } = setup({ env: { DISCORD_TOKEN: undefined } });
  const claims = b64((await (await token()).json()).id_token.split('.')[1]);
  assert.equal(`roles:${GUILD}` in claims, false);
  assert.deepEqual(claims.guilds, [GUILD, '7777']);
});

test('without the app secret every login fails with a message that names the setting', async () => {
  const { calls, token } = setup({ env: { DISCORD_CLIENT_SECRET: undefined } });
  const res = await token();
  assert.equal(res.status, 500);
  assert.match(await res.text(), /DISCORD_CLIENT_SECRET/);
  assert.equal(calls.length, 0);
});

test('the signing key is created once and reused', async () => {
  const { get, token, env } = setup();
  const first = await (await get('/jwks.json')).json();
  await token();
  const second = await (await get('/jwks.json')).json();
  assert.deepEqual(first, second);
  assert.equal(env.KV.writes, 1);
});

test('the private half of the key is never published', async () => {
  const { get } = setup();
  const key = (await (await get('/jwks.json')).json()).keys[0];
  for (const secretPart of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(secretPart in key, false);
});

test('anything else is a 404', async () => {
  const { get } = setup();
  assert.equal((await get('/')).status, 404);
  assert.equal((await get('/token')).status, 404); // GET, not POST
});

// --- /health: says what is wrong without revealing any secret ---

test('health reports a working setup', async () => {
  const { get } = setup();
  const res = await get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { client_secret: 'set', bot_token: 'ok', servers: { [GUILD]: 'ok' } });
});

test('health says when the bot token is rejected by Discord', async () => {
  const { get } = setup({ env: { DISCORD_TOKEN: 'DISCORD_TOKEN=bot-token' } });
  const body = await (await get('/health')).json();
  assert.equal(body.bot_token, 'rejected by Discord (401)');
});

test('health says when the bot is not in a server it should report roles for', async () => {
  const { get } = setup({ env: { GUILD_IDS: `${GUILD}, 5555` } });
  const body = await (await get('/health')).json();
  assert.deepEqual(body.servers, { [GUILD]: 'ok', 5555: 'bot cannot see this server (404)' });
});

test('health says when secrets are missing', async () => {
  const { get, calls } = setup({ env: { DISCORD_TOKEN: undefined, DISCORD_CLIENT_SECRET: undefined } });
  assert.deepEqual(await (await get('/health')).json(), { client_secret: 'missing', bot_token: 'missing', servers: {} });
  assert.equal(calls.length, 0);
});

test('health never contains a secret', async () => {
  const { get } = setup();
  assert.doesNotMatch(await (await get('/health')).text(), /bot-token|app-secret/);
});

test('stray spaces or a newline pasted around a secret are ignored', async () => {
  const { calls, token } = setup({ env: { DISCORD_TOKEN: '  bot-token\r\n', DISCORD_CLIENT_SECRET: ' app-secret\n' } });
  const claims = b64((await (await token()).json()).id_token.split('.')[1]);
  assert.deepEqual(claims[`roles:${GUILD}`], ['r-shelf', 'r-other']);
  assert.equal(new URLSearchParams(calls[0].init.body).get('client_secret'), 'app-secret');
});
