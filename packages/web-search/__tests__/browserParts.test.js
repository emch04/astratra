/* Les pièces du navigateur intégré, sans Chromium : robots.txt, recherche interne, signature, contrôle, relais, déploiement. */
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { parseRobots, robotsAllows, createRobotsCache } = require('../src/browser/robots');
const { openSearchUrl, formSearchUrl, isSearchEngine } = require('../src/browser/siteSearch');
const { createSigningKey, createRequestSigner, jwkThumbprint, signatureDirectory } = require('../src/browser/webBotAuth');
const { createRequestGuard } = require('../src/browser/guard');
const { startEgressProxy } = require('../src/browser/egressProxy');
const { checkIsolation } = require('../src/browser/isolation');
const { createBrowserSystemdUnit, createBrowserPm2App, createBrowserFirewall, createBrowserAppArmorProfile, browserSetupFiles } = require('../src/browser/deploy');
const { browserUserAgent, orderLinks } = require('../src/browser/engine');

describe('robots.txt', () => {
  const text = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: AstratraWebBrowser',
    'User-agent: autrebot',
    'Disallow: /private/',
    'Allow: /private/public',
    'Disallow: /*.pdf$',
    'Disallow: /search?',
    '# commentaire',
    'Disallow:'
  ].join('\n');
  const parsed = parseRobots(text);

  test('le groupe de l\'agent l\'emporte sur *', () => {
    expect(robotsAllows(parsed, 'https://a.example/page')).toBe(true);
    expect(robotsAllows(parsed, 'https://a.example/page', 'AutreAgent')).toBe(false);
  });

  test('règle la plus longue, Allow à égalité, * et $', () => {
    expect(robotsAllows(parsed, 'https://a.example/private/x')).toBe(false);
    expect(robotsAllows(parsed, 'https://a.example/private/public/x')).toBe(true);
    expect(robotsAllows(parsed, 'https://a.example/doc/a.pdf')).toBe(false);
    expect(robotsAllows(parsed, 'https://a.example/doc/a.pdf?x=1')).toBe(true);
    expect(robotsAllows(parsed, 'https://a.example/search?q=1')).toBe(false);
    expect(robotsAllows(parsed, 'https://a.example/search')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a'), 'https://a.example/a')).toBe(true);
  });

  test('la casse du jeton n\'importe pas ; /robots.txt toujours permis ; encodage comparé', () => {
    const p = parseRobots('USER-AGENT: astratrawebbrowser\nDisallow: /\n');
    expect(robotsAllows(p, 'https://a.example/x')).toBe(false);
    expect(robotsAllows(p, 'https://a.example/robots.txt')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /%7Ejoe/'), 'https://a.example/~joe/x')).toBe(false);
  });

  test('cache : 2xx lu, 4xx tout permis, 5xx et panne tout interdit, une lecture par origine', async () => {
    const answers = {
      'https://ok.example/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /non' },
      'https://absent.example/robots.txt': { status: 404, body: '' },
      'https://panne.example/robots.txt': { status: 503, body: '' },
      'https://trop.example/robots.txt': { status: 429, body: '' }
    };
    const calls = [];
    const cache = createRobotsCache({
      fetchRobots: async (url) => {
        calls.push(url);
        if (url.startsWith('https://reseau')) throw new Error('ECONNRESET');
        return answers[url];
      }
    });
    expect((await cache.check('https://ok.example/non')).allowed).toBe(false);
    expect((await cache.check('https://ok.example/oui')).allowed).toBe(true);
    expect((await cache.check('https://absent.example/x')).allowed).toBe(true);
    expect(await cache.check('https://panne.example/x')).toEqual({ allowed: false, unavailable: true });
    expect((await cache.check('https://trop.example/x')).allowed).toBe(false);
    expect(await cache.check('https://reseau.example/x')).toEqual({ allowed: false, unavailable: true });
    expect(calls.filter((url) => url.startsWith('https://ok.example')).length).toBe(1);
  });

  test('le cache expire', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createRobotsCache({ now: () => clock, ttlMs: 1000, fetchRobots: async () => { calls += 1; return { status: 200, body: '' }; } });
    await cache.check('https://a.example/');
    clock = 500;
    await cache.check('https://a.example/');
    clock = 1500;
    await cache.check('https://a.example/');
    expect(calls).toBe(2);
  });
});

describe('recherche interne d\'un site', () => {
  const pageUrl = 'https://docs.example.com/guide';

  test('OpenSearch : modèle rempli, paramètres facultatifs, même site seulement', () => {
    const xml = '<OpenSearchDescription><Url type="application/rss+xml" template="https://docs.example.com/rss?q={searchTerms}"/>'
      + '<Url type="text/html" method="GET" template="https://docs.example.com/search?q={searchTerms}&amp;n={count?}&amp;geo={geo:box?}"/></OpenSearchDescription>';
    expect(openSearchUrl(xml, { query: 'café noir', pageUrl })).toBe('https://docs.example.com/search?q=caf%C3%A9%20noir&n=10&geo=');
    expect(openSearchUrl('<Url type="text/html" template="https://evil.example/s?q={searchTerms}"/>', { query: 'x', pageUrl })).toBeNull();
    expect(openSearchUrl('<Url type="text/html" template="https://www.google.com/search?q={searchTerms}"/>', { query: 'x', pageUrl: 'https://www.google.com/' })).toBeNull();
    expect(openSearchUrl('<Url type="text/html" method="post" template="https://docs.example.com/s?q={searchTerms}"/>', { query: 'x', pageUrl })).toBeNull();
    expect(openSearchUrl('<Url type="text/html" template="https://docs.example.com/s?q={searchTerms}&amp;k={inconnu}"/>', { query: 'x', pageUrl })).toBeNull();
    expect(openSearchUrl('<Url type="text/html" template="http://docs.example.com/s?q={searchTerms}"/>', { query: 'x', pageUrl })).toBeNull();
  });

  test('formulaire GET à un champ texte de recherche', () => {
    const form = {
      action: 'https://docs.example.com/recherche?ancien=1#x',
      method: 'get',
      searchRole: false,
      fields: [{ name: 'lang', type: 'hidden', value: 'fr' }, { name: 'q', type: 'search' }, { name: 'tout', type: 'checkbox', value: 'oui', checked: true }, { name: 'non', type: 'checkbox', value: 'x', checked: false }]
    };
    expect(formSearchUrl(form, { query: 'a&b', pageUrl })).toBe('https://docs.example.com/recherche?lang=fr&q=a%26b&tout=oui');
  });

  test('formulaires refusés : POST, deux champs, mot de passe, champ non marqué, autre site, sans nom', () => {
    const base = { action: '/r', method: 'get', searchRole: true, fields: [{ name: 'q', type: 'text' }] };
    expect(formSearchUrl(base, { query: 'x', pageUrl })).toBe('https://docs.example.com/r?q=x');
    expect(formSearchUrl({ ...base, method: 'post' }, { query: 'x', pageUrl })).toBeNull();
    expect(formSearchUrl({ ...base, fields: [{ name: 'q', type: 'text' }, { name: 'r', type: 'text' }] }, { query: 'x', pageUrl })).toBeNull();
    expect(formSearchUrl({ ...base, fields: [{ name: 'q', type: 'search' }, { name: 'p', type: 'password' }] }, { query: 'x', pageUrl })).toBeNull();
    expect(formSearchUrl({ ...base, searchRole: false }, { query: 'x', pageUrl })).toBeNull();
    expect(formSearchUrl({ ...base, action: 'https://autre.example/r' }, { query: 'x', pageUrl })).toBeNull();
    expect(formSearchUrl({ ...base, fields: [{ name: '', type: 'search' }] }, { query: 'x', pageUrl })).toBeNull();
    expect(formSearchUrl(base, { query: '   ', pageUrl })).toBeNull();
  });

  test('la requête est nettoyée et bornée', () => {
    const url = formSearchUrl({ method: 'get', searchRole: true, fields: [{ name: 'q', type: 'search' }] }, { query: `a\nb${'x'.repeat(500)}`, pageUrl });
    expect(new URL(url).searchParams.get('q')).toHaveLength(200);
    expect(new URL(url).searchParams.get('q').startsWith('a b')).toBe(true);
  });

  test('moteurs de recherche reconnus', () => {
    for (const url of ['https://www.google.fr/', 'https://google.co.uk/x', 'https://www.bing.com/', 'https://duckduckgo.com/', 'https://search.brave.com/', 'https://fr.search.yahoo.com/']) {
      expect(isSearchEngine(url)).toBe(true);
    }
    expect(isSearchEngine('https://docs.example.com/')).toBe(false);
    expect(isSearchEngine('https://brave.com/')).toBe(false);
  });
});

describe('Web Bot Auth', () => {
  test('signature RFC 9421 vérifiable avec la clé publique de l\'annuaire', () => {
    const { privateKeyPem, publicJwk } = createSigningKey();
    const signer = createRequestSigner({ privateKey: privateKeyPem, signatureAgent: 'https://agent.example.com/', now: () => 1_700_000_000_000 });
    expect(signer.keyid).toBe(jwkThumbprint(publicJwk));
    const headers = signer.sign('https://Site.Example:8443/page?q=1');
    expect(headers['signature-agent']).toBe('"https://agent.example.com"');
    const input = headers['signature-input'];
    expect(input).toMatch(/^sig1=\("@authority" "signature-agent"\);created=1700000000;expires=1700000060;keyid="[A-Za-z0-9_-]{43}";alg="ed25519";nonce="[^"]+";tag="web-bot-auth"$/);
    const params = input.slice('sig1='.length);
    const base = `"@authority": site.example:8443\n"signature-agent": "https://agent.example.com"\n"@signature-params": ${params}`;
    const signature = Buffer.from(/^sig1=:(.+):$/.exec(headers.signature)[1], 'base64');
    const directory = signatureDirectory(publicJwk);
    const key = crypto.createPublicKey({ key: directory.keys[0], format: 'jwk' });
    expect(crypto.verify(null, Buffer.from(base), key, signature)).toBe(true);
    expect(crypto.verify(null, Buffer.from(base.replace('8443', '443')), key, signature)).toBe(false);
  });

  test('refus : clé non Ed25519, agent non https', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() => createRequestSigner({ privateKey: rsa, signatureAgent: 'https://a.example' })).toThrow(/Ed25519/);
    expect(() => createRequestSigner({ privateKey: createSigningKey().privateKeyPem, signatureAgent: 'http://a.example' })).toThrow(/https/);
  });
});

describe('contrôle des requêtes de la page', () => {
  const resolve = (host, _o, cb) => {
    const table = { 'public.example': ['93.184.216.34'], 'mixte.example': ['93.184.216.34', '10.1.2.3'], 'v6.example': ['::ffff:127.0.0.1'], 'meta.example': ['169.254.169.254'] };
    if (!table[host]) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    return cb(null, table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  const guard = createRequestGuard({ resolve });

  test.each([
    ['https://public.example/a', true, undefined],
    ['wss://public.example/socket', true, undefined],
    ['http://public.example/a', false, 'protocol'],
    ['ws://public.example/a', false, 'protocol'],
    ['file:///etc/passwd', false, 'protocol'],
    ['chrome://settings', false, 'protocol'],
    ['https://public.example:8443/', false, 'port'],
    ['https://user:pw@public.example/', false, 'credentials'],
    ['https://localhost/', false, 'address'],
    ['https://127.0.0.1/', false, 'address'],
    ['https://[::1]/', false, 'address'],
    ['https://169.254.169.254/latest/meta-data', false, 'address'],
    ['https://service.internal/', false, 'address'],
    ['https://mixte.example/', false, 'address'],
    ['https://v6.example/', false, 'address'],
    ['https://meta.example/', false, 'address'],
    ['https://inconnu.example/', false, 'dns'],
    ['https://93.184.216.34/', true, undefined]
  ])('%s', async (url, ok, reason) => {
    const verdict = await guard.check(url);
    expect(verdict.ok).toBe(ok);
    if (!ok) expect(verdict.reason).toBe(reason);
  });

  test('http permis pour les sous-ressources seulement, avec allowHttp', async () => {
    const lax = createRequestGuard({ resolve, allowHttp: true });
    expect((await lax.check('http://public.example/img.png')).ok).toBe(true);
    expect((await lax.check('http://public.example/', { document: true })).reason).toBe('protocol');
    expect((await lax.check('http://127.0.0.1/')).reason).toBe('address');
  });
});

describe('relais de sortie', () => {
  let target;
  let proxy;
  const seen = [];
  beforeAll(async () => {
    target = net.createServer((socket) => {
      seen.push('connexion');
      socket.end('bonjour');
    });
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    const resolve = (host, _o, cb) => {
      if (host === 'public.example') return cb(null, [{ address: '93.184.216.34', family: 4 }]);
      if (host === 'interne.example') return cb(null, [{ address: '192.168.1.10', family: 4 }]);
      return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    };
    proxy = await startEgressProxy({
      resolve,
      ports: [443],
      /* La connexion « publique » arrive au serveur local de test, après le contrôle. */
      connect: ({ address }) => {
        seen.push(`vers ${address}`);
        return net.connect({ host: '127.0.0.1', port: target.address().port });
      }
    });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise((resolve) => target.close(resolve));
  });

  const tunnel = (host, { auth = true } = {}) => new Promise((resolve) => {
    const headers = auth ? { 'proxy-authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` } : {};
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: host, headers });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode, body: '' });
        return;
      }
      /* Ce qui suit la réponse dans le même paquet arrive dans head. */
      let body = head ? head.toString() : '';
      socket.on('data', (chunk) => { body += chunk; });
      socket.on('end', () => resolve({ status: res.statusCode, body }));
      socket.on('error', () => resolve({ status: res.statusCode, body }));
    });
    req.on('response', (res) => resolve({ status: res.statusCode, body: '' }));
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });

  test('un nom public passe, vers l\'adresse vérifiée', async () => {
    seen.length = 0;
    const answer = await tunnel('public.example:443');
    expect(answer).toEqual({ status: 200, body: 'bonjour' });
    expect(seen).toEqual(['vers 93.184.216.34', 'connexion']);
  });

  test.each([
    ['127.0.0.1:443'],
    ['[::1]:443'],
    ['169.254.169.254:443'],
    ['interne.example:443'],
    ['localhost:443'],
    ['public.example:22'],
    ['inconnu.example:443']
  ])('refusé : %s', async (host) => {
    seen.length = 0;
    const answer = await tunnel(host);
    expect(answer.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test('sans identifiant : 407', async () => {
    seen.length = 0;
    expect((await tunnel('public.example:443', { auth: false })).status).toBe(407);
    expect(seen).toEqual([]);
  });

  test('http ordinaire refusé sans allowHttp', async () => {
    const status = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.port, path: 'http://public.example/', headers: { 'proxy-authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` }
      }, (res) => resolve(res.statusCode));
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('contrôle d\'isolement au démarrage', () => {
  const fakeConnect = (outcomes) => ({ host }) => {
    const socket = new (require('events').EventEmitter)();
    socket.destroy = () => {};
    setImmediate(() => {
      const outcome = outcomes[host];
      if (outcome === 'connect') socket.emit('connect');
      else if (outcome) socket.emit('error', Object.assign(new Error(outcome), { code: outcome }));
    });
    return socket;
  };
  const targets = [
    { name: 'loopback', host: '127.0.0.1', port: 5008 },
    { name: 'private', host: '10.0.0.1', port: 22 },
    { name: 'metadata', host: '169.254.169.254', port: 80 }
  ];

  test('pare-feu en place : tout est refusé à la sortie', async () => {
    const result = await checkIsolation({ targets, connect: fakeConnect({ '127.0.0.1': 'EPERM', '10.0.0.1': 'EPERM', '169.254.169.254': 'EPERM' }) });
    expect(result.ok).toBe(true);
    expect(result.probes.map((probe) => probe.outcome)).toEqual(['blocked', 'blocked', 'blocked']);
  });

  test('sans pare-feu : la boucle locale répond, échec', async () => {
    const result = await checkIsolation({ targets, connect: fakeConnect({ '127.0.0.1': 'connect', '10.0.0.1': 'EHOSTUNREACH' }), timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.probes.map((probe) => probe.outcome)).toEqual(['reached', 'unreachable', 'timeout']);
  });

  test('un refus de port de l\'hôte joint compte comme atteint', async () => {
    const result = await checkIsolation({ targets, connect: fakeConnect({ '127.0.0.1': 'EPERM', '10.0.0.1': 'ECONNREFUSED', '169.254.169.254': 'EPERM' }) });
    expect(result.ok).toBe(false);
  });

  test('pour de vrai, sur cette machine sans pare-feu : la boucle locale est joignable', async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const result = await checkIsolation({ servicePort: server.address().port, timeoutMs: 300 });
    server.close();
    expect(result.ok).toBe(false);
    expect(result.probes[0]).toMatchObject({ name: 'loopback', outcome: 'reached' });
  });
});

describe('déploiement', () => {
  test('unité systemd : utilisateur à part, secrets par LoadCredential, durcissement compatible avec Chromium', () => {
    const unit = createBrowserSystemdUnit({
      node: '/usr/bin/node', user: 'navigateur', tokenFile: '/etc/astratra/browser-token',
      signingKeyFile: '/etc/astratra/browser-key.pem', signatureAgent: 'https://agent.example.com', infoUrl: 'https://agent.example.com/agent',
      browsersPath: '/opt/ms-playwright', proxyPort: 5009, port: 5008, maxContexts: 2
    });
    expect(unit).toContain('User=navigateur');
    expect(unit).toMatch(/ExecStart=\/usr\/bin\/node \S+cli\.js serve/);
    expect(unit).toContain('LoadCredential=browser-token:/etc/astratra/browser-token');
    expect(unit).toContain('Environment="WEB_BROWSER_TOKEN_FILE=%d/browser-token"');
    expect(unit).toContain('LoadCredential=browser-signing-key:/etc/astratra/browser-key.pem');
    expect(unit).toContain('RestrictNamespaces=user pid net');
    expect(unit).toContain('NoNewPrivileges=yes');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('MemoryMax=2G');
    expect(unit).toContain('CPUQuota=200%');
    expect(unit).not.toMatch(/MemoryDenyWriteExecute=yes|no-sandbox|UNSAFE/);
    expect(unit).toContain('Environment="PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright"');
  });

  test('refus : root, sans jeton, secret en variable, chemin relatif, injection de directive', () => {
    const base = { node: '/usr/bin/node', user: 'navigateur', tokenFile: '/etc/t' };
    expect(() => createBrowserSystemdUnit({ ...base, user: 'root' })).toThrow(/not root/);
    expect(() => createBrowserSystemdUnit({ ...base, tokenFile: undefined })).toThrow(/token/);
    expect(() => createBrowserSystemdUnit({ ...base, env: { WEB_BROWSER_TOKEN: 'x' } })).toThrow(/git/);
    expect(() => createBrowserSystemdUnit({ ...base, env: { WEB_BROWSER_UNSAFE_NO_FIREWALL: '1' } })).toThrow(/never/);
    expect(() => createBrowserSystemdUnit({ ...base, node: 'node' })).toThrow(/absolute/);
    expect(() => createBrowserSystemdUnit({ ...base, description: 'a\nExecStartPre=/bin/sh' })).toThrow(/control/);
    expect(() => createBrowserSystemdUnit({ ...base, signingKeyFile: '/etc/k' })).toThrow(/together/);
    expect(() => createBrowserSystemdUnit({ ...base, infoUrl: 'http://a.example' })).toThrow(/https/);
  });

  test('entrée pm2', () => {
    const app = createBrowserPm2App({ tokenFile: '/etc/astratra/browser-token', node: '/usr/bin/node' });
    expect(app).toMatchObject({ name: 'astratra-web-browser', args: 'serve', instances: 1, exec_mode: 'fork', interpreter: '/usr/bin/node' });
    expect(app.env).toMatchObject({ NODE_ENV: 'production', WEB_BROWSER_TOKEN_FILE: '/etc/astratra/browser-token' });
  });

  test('pare-feu nftables : mêmes plages que isPublicAddress, DNS et relais permis', () => {
    const rules = createBrowserFirewall({ user: 'navigateur', proxyPort: 5009, dnsServers: ['127.0.0.53', '2606:4700:4700::1111'] });
    expect(rules).toContain('meta skuid != "navigateur" return');
    expect(rules).toContain('ip daddr 127.0.0.1 tcp dport 5009 accept');
    expect(rules).toContain('ip daddr 127.0.0.53 udp dport 53 accept');
    expect(rules).toContain('ip6 daddr 2606:4700:4700::1111 tcp dport 53 accept');
    for (const range of ['10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']) expect(rules).toContain(range);
    expect(rules).toContain('ip6 daddr != 2000::/3 drop');
    expect(rules.indexOf('dport 5009 accept')).toBeLessThan(rules.indexOf('127.0.0.0/8'));
    expect(() => createBrowserFirewall({ dnsServers: ['resolver.example'] })).toThrow(/IP/);
    expect(() => createBrowserFirewall({ user: 'root' })).toThrow(/root/);
  });

  test('profil AppArmor et fichiers de préparation', () => {
    expect(createBrowserAppArmorProfile({ chromiumPath: '/opt/pw/chrome-headless-shell' })).toContain('profile astratra-chromium /opt/pw/chrome-headless-shell flags=(unconfined) {\n  userns,');
    expect(() => createBrowserAppArmorProfile({ chromiumPath: '/opt/a b' })).toThrow(/spaces/);
    const files = browserSetupFiles({ node: '/usr/bin/node', tokenFile: '/etc/astratra/browser-token', chromiumPath: '/opt/pw/chrome-headless-shell' });
    expect(Object.keys(files).sort()).toEqual(['INSTALL.fr.md', 'INSTALL.md', 'astratra-chromium.apparmor', 'astratra-web-browser-firewall.service', 'astratra-web-browser.nft', 'astratra-web-browser.service']);
    expect(files['astratra-web-browser.service']).toContain('Requires=astratra-web-browser-firewall.service');
    expect(files['astratra-web-browser-firewall.service']).toContain('ExecStart=/usr/sbin/nft -f /etc/astratra/astratra-web-browser.nft');
    expect(files['astratra-web-browser-firewall.service']).toContain('Before=network-pre.target astratra-web-browser.service');
    expect(files['INSTALL.md']).toContain('Do not enable nftables.service');
    expect(files['INSTALL.md']).toContain('groupadd --system astratra-browser');
    expect(files['INSTALL.md']).toContain('token --out /etc/astratra/browser-token --group astratra-browser');
    expect(files['INSTALL.fr.md']).toContain('usermod -aG astratra-browser');
    expect(() => browserSetupFiles({ node: '/usr/bin/node', tokenFile: '/etc/t', clientsGroup: 'a b' })).toThrow(/clientsGroup/);
    expect(files['INSTALL.md']).toContain('useradd --system');
    expect(JSON.stringify(files)).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});

describe('moteur, sans Chromium', () => {
  test('User-Agent honnête', () => {
    expect(browserUserAgent({ version: '1.2.0', infoUrl: 'https://agent.example.com/a' })).toBe('Mozilla/5.0 (compatible; AstratraWebBrowser/1.2.0; +https://agent.example.com/a)');
  });

  test('liens : https publics, même site d\'abord, 50 au plus, numérotés', () => {
    const links = [
      { url: 'https://autre.example/a', text: 'A' },
      { url: 'https://www.site.example/b', text: 'B' },
      { url: 'http://site.example/c', text: 'C' },
      { url: 'https://localhost/d', text: 'D' },
      { url: 'https://10.0.0.1/e', text: 'E' },
      ...Array.from({ length: 60 }, (_, i) => ({ url: `https://site.example/p${i}`, text: `P${i}` }))
    ];
    const ordered = orderLinks(links, 'https://site.example/', 50);
    expect(ordered).toHaveLength(50);
    expect(ordered[0]).toEqual({ n: 1, url: 'https://www.site.example/b', text: 'B', sameSite: true });
    expect(ordered.every((link) => link.sameSite)).toBe(true);
    expect(ordered.map((link) => link.url)).not.toContain('https://localhost/d');
  });
});

describe('commande astratra-web-browser', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { inspectBrowserHost, resolversOf, setup, token } = require('../src/browser/cli');
  const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'astratra-cli-'));
  const quiet = () => jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

  test('résolveurs lus dans resolv.conf', () => {
    expect(resolversOf('# x\nnameserver 127.0.0.53\nnameserver fe80::1%eth0\nnameserver pasuneip\noptions edns0')).toEqual(['127.0.0.53', 'fe80::1']);
  });

  test('vérification de la machine : tout présent', () => {
    const checks = inspectBrowserHost({
      platform: 'linux', exists: (file) => file === '/run/systemd/system', hasCommand: (name) => name === 'nft',
      read: () => '1\n', nodeVersion: '22.22.0', chromiumPath: '/opt/pw/chrome-headless-shell', resolvers: ['127.0.0.53']
    });
    expect(checks.map((check) => [check.name, check.ok])).toEqual([['linux', true], ['systemd', true], ['nftables', true], ['apparmor', true], ['node', true], ['chromium', true], ['dns', true]]);
  });

  test('vérification de la machine : ce qui manque, avec la marche à suivre', () => {
    const checks = inspectBrowserHost({ platform: 'linux', exists: () => false, hasCommand: () => false, read: () => '1', nodeVersion: '20.11.0', resolvers: [] });
    const missing = checks.filter((check) => !check.ok);
    expect(missing.map((check) => check.name)).toEqual(['systemd', 'nftables', 'apparmor', 'node', 'chromium', 'dns']);
    expect(missing.every((check) => typeof check.fix === 'string' && check.fix.length > 10)).toBe(true);
    const mac = inspectBrowserHost({ platform: 'darwin' });
    expect(mac).toHaveLength(1);
    expect(mac[0]).toMatchObject({ name: 'linux', ok: false });
    expect(mac[0].fix).toContain('createLocalBrowser');
  });

  test('setup écrit les fichiers et rend la vérification', () => {
    const out = tmp();
    const spy = quiet();
    try {
      const result = setup({ out, node: '/usr/bin/node', 'token-file': '/etc/astratra/browser-token', dns: '127.0.0.53', chromium: '/opt/pw/chrome-headless-shell' });
      expect(result.files).toContain('INSTALL.fr.md');
      expect(fs.readFileSync(path.join(out, 'astratra-web-browser.nft'), 'utf8')).toContain('ip daddr 127.0.0.53 udp dport 53 accept');
      expect(result.checks[0].name).toBe('linux');
      expect(() => setup({ out, node: '/usr/bin/node' })).toThrow(/token-file/);
    } finally {
      spy.mockRestore();
    }
  });

  test('jeton : 600 sans groupe, 640 avec groupe, jamais écrasé, groupe inconnu refusé', () => {
    const dir = tmp();
    const spy = quiet();
    try {
      token({ out: path.join(dir, 'seul') });
      expect(fs.statSync(path.join(dir, 'seul')).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(dir, 'seul'), 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(() => token({ out: path.join(dir, 'seul') })).toThrow(/EEXIST/);
      token({ out: path.join(dir, 'groupe'), group: String(process.getgid()) });
      const stat = fs.statSync(path.join(dir, 'groupe'));
      expect(stat.mode & 0o777).toBe(0o640);
      expect(stat.gid).toBe(process.getgid());
      expect(() => token({ out: path.join(dir, 'x'), group: 'groupe-qui-nexiste-pas-astratra' })).toThrow(/no group named/);
      expect(fs.existsSync(path.join(dir, 'x'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
