// Lets Cloudflare Access offer "Log in with Discord".
//
// Access speaks OpenID Connect; Discord speaks plain OAuth2. This Worker sits
// between them: it sends the browser to Discord, swaps the returned code for
// the person's profile, and hands Access a signed id_token saying who they
// are, which servers they are in and (optionally) their roles there.
//
// Same idea as github.com/Erisa/discord-oidc-worker (MIT), rewritten without
// dependencies and with the app secret kept in a Worker secret, not in code.
//
// Settings (wrangler.toml / dashboard):
//   DISCORD_CLIENT_ID      var     Discord application ID
//   REDIRECT_URL           var     https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
//   GUILD_IDS              var     optional, comma separated: servers to report roles for
//   DISCORD_CLIENT_SECRET  secret  Discord application OAuth2 secret
//   DISCORD_TOKEN          secret  optional bot token, only needed for role claims
//   KV                     KV namespace that stores the signing key

const DISCORD = 'https://discord.com';
const API = `${DISCORD}/api/v10`;
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const KID = 'jwtRS256';

export function createWorker({ fetch = globalThis.fetch } = {}) {
  const getJson = async (url, authorization) => {
    const res = await fetch(url, { headers: { authorization } });
    return res.ok ? res.json() : null;
  };

  function authorize(url, env) {
    const ask = url.searchParams;
    if (ask.get('client_id') !== env.DISCORD_CLIENT_ID || ask.get('redirect_uri') !== env.REDIRECT_URL) {
      return text('Bad request.', 400);
    }
    const to = new URL(`${DISCORD}/oauth2/authorize`);
    to.search = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      redirect_uri: env.REDIRECT_URL,
      response_type: 'code',
      scope: 'identify email guilds',
      state: ask.get('state') ?? '',
      prompt: 'none',
    });
    return new Response(null, { status: 302, headers: { location: to.href } });
  }

  async function token(request, env) {
    if (!env.DISCORD_CLIENT_SECRET) return text('Not set up: add the DISCORD_CLIENT_SECRET secret to this Worker.', 500);
    const code = new URLSearchParams(await request.text()).get('code');
    if (!code) return text('Bad request.', 400);

    const exchange = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        redirect_uri: env.REDIRECT_URL,
        grant_type: 'authorization_code',
        code,
      }).toString(),
    });
    const grant = exchange.ok ? await exchange.json() : null;
    if (!grant?.access_token) return text('Bad request.', 400);
    const bearer = `Bearer ${grant.access_token}`;

    const user = await getJson(`${API}/users/@me`, bearer);
    if (!user?.id || !user.verified || !user.email) return text('Bad request.', 400);

    const guilds = ((await getJson(`${API}/users/@me/guilds`, bearer)) ?? []).map((guild) => guild.id);

    // Roles need the bot, and only make sense for servers the person is in.
    const roles = {};
    if (env.DISCORD_TOKEN) {
      const wanted = String(env.GUILD_IDS ?? '').split(',').map((id) => id.trim()).filter((id) => guilds.includes(id));
      await Promise.all(wanted.map(async (guildId) => {
        const member = await getJson(`${API}/guilds/${guildId}/members/${user.id}`, `Bot ${env.DISCORD_TOKEN}`);
        if (member?.roles) roles[`roles:${guildId}`] = member.roles;
      }));
    }

    const now = Math.floor(Date.now() / 1000);
    const hasTag = user.discriminator && user.discriminator !== '0';
    const idToken = await sign({
      iss: 'https://cloudflare.com',
      aud: env.DISCORD_CLIENT_ID,
      sub: user.id,
      iat: now,
      exp: now + 3600,
      id: user.id,
      email: user.email,
      name: user.global_name ?? user.username,
      preferred_username: hasTag ? `${user.username}#${user.discriminator}` : user.username,
      guilds,
      ...roles,
    }, (await keyPair(env.KV)).privateKey);

    // Discord's own tokens stay here; Access only needs the id_token.
    return json({ token_type: 'Bearer', expires_in: 3600, scope: 'identify email guilds', id_token: idToken });
  }

  async function jwks(env) {
    const { kty, n, e } = await crypto.subtle.exportKey('jwk', (await keyPair(env.KV)).publicKey);
    return json({ keys: [{ kty, n, e, alg: 'RS256', use: 'sig', kid: KID }] });
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === 'GET' && (url.pathname === '/authorize' || url.pathname === '/authorize/guilds')) return authorize(url, env);
      if (request.method === 'POST' && url.pathname === '/token') return token(request, env);
      if (request.method === 'GET' && url.pathname === '/jwks.json') return jwks(env);
      return text('Not found.', 404);
    },
  };
}

// The signing key is made on first use and kept in KV.
async function keyPair(KV) {
  const saved = await KV.get('keys', { type: 'json' });
  if (saved) {
    return {
      publicKey: await crypto.subtle.importKey('jwk', saved.publicKey, RSA, true, ['verify']),
      privateKey: await crypto.subtle.importKey('jwk', saved.privateKey, RSA, true, ['sign']),
    };
  }
  const made = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify'],
  );
  await KV.put('keys', JSON.stringify({
    publicKey: await crypto.subtle.exportKey('jwk', made.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', made.privateKey),
  }));
  return made;
}

async function sign(claims, privateKey) {
  const part = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const signed = `${part({ alg: 'RS256', typ: 'JWT', kid: KID })}.${part(claims)}`;
  const signature = await crypto.subtle.sign(RSA.name, privateKey, new TextEncoder().encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const text = (body, status) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default createWorker();
