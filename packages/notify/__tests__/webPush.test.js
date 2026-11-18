const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { standardVectors, assertVectors, assertFuzz, assertProperty, gen, assertSafeRegex, extractRegexLiterals } = require('@astratra/testkit/security');
const { generateVapidKeys, vapidAuthorization, encryptWebPush, decryptWebPush, buildWebPushRequest, sendWebPush, createWebPushTransport, createPushSender, WebPushError, KNOWN_PUSH_HOSTS } = require('../src');

// Web Push sans bibliothèque (src/webPush.js), à la place de web-push : vecteur de la RFC 8291, octets de http_ece,
// en-têtes et refus de web-push 3.6.7 enregistrés, un vrai service local en HTTPS, puis essais d'attaque.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/web-push-reference.json'), 'utf8'));
const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const newDevice = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: b64(ecdh.getPrivateKey()), p256dh: b64(ecdh.getPublicKey()), auth: b64(crypto.randomBytes(16)) };
};
const decodeJwt = (token) => {
  const [header, payload, signature] = token.split('.');
  return { header: JSON.parse(Buffer.from(header, 'base64url')), payload: JSON.parse(Buffer.from(payload, 'base64url')), signed: `${header}.${payload}`, signature: Buffer.from(signature, 'base64url') };
};
const verifyEs256 = (signed, signature, publicKey) => {
  const point = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) } });
  return crypto.verify('sha256', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' }, signature);
};
const parseAuthorization = (value) => {
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(value);
  return match && { jwt: decodeJwt(match[1]), k: match[2] };
};

describe('normes', () => {
  test('RFC 8291 : le chiffrement rend les octets de l’exemple, le déchiffrement rend le texte', async () => {
    await assertVectors(standardVectors.webPushRfc8291, (i) => {
      const body = encryptWebPush({ p256dh: i.uaPublic, auth: i.authSecret, payload: i.plaintext, deterministic: { salt: i.salt, privateKey: i.asPrivate } });
      const back = decryptWebPush({ body, privateKey: i.uaPrivate, p256dh: i.uaPublic, auth: i.authSecret });
      return back.equals(i.plaintext) ? b64(body) : 'texte différent';
    }, { source: 'RFC 8291', equal: (actual, expected) => actual === expected.body });
  });

  test('chaque message a son sel et sa clé éphémère : deux envois du même texte ne se ressemblent pas', () => {
    const device = newDevice();
    const bodies = Array.from({ length: 50 }, () => encryptWebPush({ ...device, payload: 'même texte' }));
    expect(new Set(bodies.map((b) => b.subarray(0, 16).toString('hex'))).size).toBe(50);
    expect(new Set(bodies.map((b) => b.subarray(21, 86).toString('hex'))).size).toBe(50);
  });

  test('aller-retour pour tout message de 0 à 3 993 octets (propriété)', async () => {
    const device = newDevice();
    await assertProperty(gen.bytes({ max: 3993 }), (bytes) => decryptWebPush({ body: encryptWebPush({ ...device, payload: bytes }), ...device }).equals(bytes), { runs: 300 });
  });
});

describe(`comparé à ${reference.source}`, () => {
  test(`mêmes octets que http_ece sur ${reference.eceCases.length} messages (sel et clé éphémère fixés)`, async () => {
    await assertVectors(reference.eceCases.map((c, i) => ({ id: `chiffrement ${i} (${Buffer.from(c.payload, 'base64url').length} octets)`, input: c, expected: c.body })), (c) => b64(encryptWebPush({ p256dh: c.uaPublic, auth: c.auth, payload: Buffer.from(c.payload, 'base64url'), deterministic: { salt: c.salt, privateKey: c.asPrivate } })));
  });

  test(`les ${reference.webPushCiphertexts.length} messages chiffrés par web-push se déchiffrent à l’identique`, async () => {
    await assertVectors(reference.webPushCiphertexts.map((c, i) => ({ id: `message ${i}`, input: c, expected: c.payload })), (c) => b64(decryptWebPush({ body: Buffer.from(c.body, 'base64url'), privateKey: c.uaPrivate, p256dh: c.uaPublic, auth: c.auth })));
  });

  test(`VAPID : mêmes en-têtes et revendications que web-push sur ${reference.vapidCases.length} cas, signatures vérifiées dans les deux sens`, async () => {
    await assertVectors(reference.vapidCases.map((c, i) => ({ id: `VAPID ${i} ${c.audience}`, input: c, expected: true })), (c) => {
      const theirs = parseAuthorization(c.authorization);
      const ours = parseAuthorization(vapidAuthorization({ audience: c.audience, vapid: { subject: c.subject, publicKey: c.publicKey, privateKey: c.privateKey }, expiration: c.expiration, now: () => reference.recordedAt * 1000 }).authorization);
      const same = ours.jwt.signed === theirs.jwt.signed && ours.k === theirs.k;
      return same && verifyEs256(theirs.jwt.signed, theirs.jwt.signature, c.publicKey) && verifyEs256(ours.jwt.signed, ours.jwt.signature, c.publicKey) ? true : { ours, theirs };
    });
  });

  test(`mêmes en-têtes que generateRequestDetails sur ${reference.requestCases.length} grilles d’options`, async () => {
    const vapid = { subject: 'mailto:contact@example.test', ...generateVapidKeys() };
    await assertVectors(reference.requestCases.map((c) => ({ id: c.id, input: c, expected: { headers: c.headers, bodyLength: c.bodyLength } })), (c) => {
      const payload = c.payload && c.payload.buffer ? Buffer.from(c.payload.buffer, 'base64url') : c.payload;
      const options = c.options && { ...c.options, ...(c.options.vapidDetails ? { vapidDetails: vapid } : {}) };
      const request = buildWebPushRequest(reference.requestSubscription, payload, options);
      return { headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, k === 'Authorization' ? 'present' : v])), bodyLength: request.body ? request.body.length : 0 };
    });
  });

  test('mêmes refus que web-push, sauf les écarts voulus (chacun nommé)', () => {
    // Ce que web-push laisse passer et qui est refusé ici, pour la raison donnée.
    const intended = {
      'TTL pas un nombre': 'web-push enverrait « TTL: NaN »',
      'TTL décimal': 'un TTL est un nombre entier de secondes',
      'encodage aesgcm': 'brouillon de 2016, remplacé par aes128gcm partout',
      'VAPID clés qui ne vont pas ensemble': 'le service répondrait 403 à chaque envoi',
      'adresse http://': 'un abonnement est toujours en https://',
      'adresse sur un hôte inconnu': 'sinon un abonné ferait appeler n’importe quelle adresse au serveur',
      'adresse avec identifiants': 'aucun service de notification n’en a',
      'message de 3 994 octets': 'au-delà de la limite de la RFC 8291',
      'clé GCM': 'GCM est fermé depuis 2019',
    };
    const offCurve = Buffer.alloc(65, 1);
    offCurve[0] = 4;
    const sub = reference.requestSubscription;
    const vapid = { subject: 'mailto:contact@example.test', ...generateVapidKeys() };
    const inputs = {
      'sans abonnement': [null, 'x', {}],
      'sans adresse': [{ keys: sub.keys }, 'x', {}],
      'adresse vide': [{ ...sub, endpoint: '' }, 'x', {}],
      'adresse nombre': [{ ...sub, endpoint: 42 }, 'x', {}],
      'message sans clés': [{ endpoint: sub.endpoint }, 'x', {}],
      'sans message ni clés': [{ endpoint: sub.endpoint }, undefined, {}],
      'p256dh de 64 octets': [{ ...sub, keys: { ...sub.keys, p256dh: b64(Buffer.alloc(64, 4)) } }, 'x', {}],
      'p256dh hors de la courbe': [{ ...sub, keys: { ...sub.keys, p256dh: b64(offCurve) } }, 'x', {}],
      'auth de 15 octets': [{ ...sub, keys: { ...sub.keys, auth: b64(Buffer.alloc(15)) } }, 'x', {}],
      'auth de 32 octets': [{ ...sub, keys: { ...sub.keys, auth: b64(Buffer.alloc(32, 7)) } }, 'x', {}],
      'message nombre': [sub, 42, {}],
      'option inconnue': [sub, 'x', { retry: 3 }],
      'TTL négatif': [sub, 'x', { TTL: -1 }],
      'TTL pas un nombre': [sub, 'x', { TTL: 'abc' }],
      'TTL décimal': [sub, 'x', { TTL: 1.5 }],
      'urgence inconnue': [sub, 'x', { urgency: 'urgent' }],
      'sujet avec +': [sub, 'x', { topic: 'a+b' }],
      'sujet de 33 caractères': [sub, 'x', { topic: 'a'.repeat(33) }],
      'encodage inconnu': [sub, 'x', { contentEncoding: 'gzip' }],
      'encodage aesgcm': [sub, 'x', { contentEncoding: 'aesgcm' }],
      'en-tête en double': [sub, 'x', { TTL: 5, headers: { TTL: 6 } }],
      'VAPID sujet http': [sub, 'x', { vapidDetails: { ...vapid, subject: 'http://example.test' } }],
      'VAPID sujet vide': [sub, 'x', { vapidDetails: { ...vapid, subject: '' } }],
      'VAPID clé publique de 64 octets': [sub, 'x', { vapidDetails: { ...vapid, publicKey: b64(Buffer.alloc(64, 4)) } }],
      'VAPID clé privée de 31 octets': [sub, 'x', { vapidDetails: { ...vapid, privateKey: b64(Buffer.alloc(31, 1)) } }],
      'VAPID clé avec =': [sub, 'x', { vapidDetails: { ...vapid, privateKey: `${vapid.privateKey}=` } }],
      'VAPID clés qui ne vont pas ensemble': [sub, 'x', { vapidDetails: { ...vapid, publicKey: generateVapidKeys().publicKey } }],
      'adresse http://': [{ ...sub, endpoint: 'http://fcm.googleapis.com/fcm/send/x' }, 'x', {}],
      'adresse sur un hôte inconnu': [{ ...sub, endpoint: 'https://169.254.169.254/latest/meta-data' }, 'x', {}],
      'adresse avec identifiants': [{ ...sub, endpoint: 'https://user:pass@fcm.googleapis.com/fcm/send/x' }, 'x', {}],
      'message de 3 994 octets': [sub, 'x'.repeat(3994), {}],
      'message de 3 993 octets': [sub, 'x'.repeat(3993), {}],
      'clé GCM': [sub, 'x', { gcmAPIKey: 'AAAA' }],
    };
    const differences = [];
    for (const { id, outcome } of reference.refusalCases) {
      let ours = 'accepted';
      try {
        buildWebPushRequest(...inputs[id]);
      } catch (error) {
        expect(error).toBeInstanceOf(WebPushError);
        expect(error.code).toBe('invalid_request');
        ours = 'refused';
      }
      const expected = intended[id] ? 'refused' : outcome;
      if (ours !== expected) differences.push({ id, webPush: outcome, ours });
      if (intended[id]) expect(outcome).toBe('accepted');
    }
    expect(differences).toEqual([]);
    expect(Object.keys(inputs).sort()).toEqual(reference.refusalCases.map((c) => c.id).sort());
  });

  test('les clés neuves ont le format de web-push, et vont ensemble', () => {
    for (let i = 0; i < 50; i++) {
      const keys = generateVapidKeys();
      expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
      expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
      expect(keys.privateKey).toMatch(/^[\w-]{43}$/);
      expect(() => vapidAuthorization({ audience: 'https://fcm.googleapis.com', vapid: { subject: 'mailto:a@example.test', ...keys } })).not.toThrow();
    }
  });
});

/* Un service de notification local en HTTPS (certificat fait par openssl pour 127.0.0.1) : ce qui part vraiment. */
const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const describeLive = opensslAvailable ? describe : describe.skip;

describeLive('envoi à un service local', () => {
  let server;
  let agent;
  let base;
  let answer = () => ({ status: 201 });
  const received = [];
  const vapid = { subject: 'mailto:contact@example.test', ...generateVapidKeys() };
  const device = newDevice();
  const subscription = (pathName = '/push/abc') => ({ endpoint: `${base}${pathName}`, keys: { p256dh: device.p256dh, auth: device.auth } });
  const options = (extra = {}) => ({ vapid, agent, extraHosts: ['127.0.0.1'], ...extra });

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-push-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert }, (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        answer(req, res);
      });
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    base = `https://127.0.0.1:${server.address().port}`;
    agent = new https.Agent({ ca: cert, keepAlive: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterAll(async () => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  });
  beforeEach(() => {
    received.length = 0;
    answer = (req, res) => res.writeHead(201).end();
  });

  test('le service reçoit un message qu’il ne peut pas lire, que l’appareil déchiffre, signé VAPID pour son origine', async () => {
    const result = await sendWebPush(subscription(), JSON.stringify({ title: 'Bonjour', body: 'Élève ✓' }), options({ ttl: 3600, urgency: 'high', topic: 'maj' }));
    expect(result.statusCode).toBe(201);
    const [request] = received;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/push/abc');
    expect(request.headers).toEqual(expect.objectContaining({ ttl: '3600', urgency: 'high', topic: 'maj', 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream' }));
    expect(request.body.includes(Buffer.from('Bonjour'))).toBe(false);
    expect(JSON.parse(decryptWebPush({ body: request.body, ...device }).toString())).toEqual({ title: 'Bonjour', body: 'Élève ✓' });
    const { jwt, k } = parseAuthorization(request.headers.authorization);
    expect(k).toBe(vapid.publicKey);
    expect(jwt.payload).toEqual({ aud: base, exp: expect.any(Number), sub: vapid.subject });
    expect(verifyEs256(jwt.signed, jwt.signature, vapid.publicKey)).toBe(true);
  });

  test('sans message : une simple notification, sans corps', async () => {
    await sendWebPush(subscription(), undefined, options());
    expect(received[0].headers['content-length']).toBe('0');
    expect(received[0].headers['content-encoding']).toBeUndefined();
    expect(received[0].body).toHaveLength(0);
  });

  test('410 : WebPushError avec statusCode, et createPushSender rend l’abonnement mort pour qu’on l’efface', async () => {
    answer = (req, res) => res.writeHead(410, { 'content-type': 'text/plain' }).end('gone');
    const error = await sendWebPush(subscription(), 'x', options()).catch((e) => e);
    expect(error).toBeInstanceOf(WebPushError);
    expect(error).toEqual(expect.objectContaining({ statusCode: 410, body: 'gone', endpoint: subscription().endpoint }));
    const gone = [];
    const sender = createPushSender({ transport: createWebPushTransport(options()), onGone: async (s) => gone.push(s.endpoint) });
    const report = await sender.broadcast([subscription('/push/morte')], { title: 'x' });
    expect(gone).toEqual([`${base}/push/morte`]);
    expect(report).toEqual(expect.objectContaining({ gone: 1 }));
  });

  test('le transport envoie un objet en JSON et garde l’en-tête VAPID par service', async () => {
    const transport = createWebPushTransport(options());
    await transport(subscription(), { title: 'a' });
    await transport(subscription('/push/autre'), { title: 'b' });
    expect(received.map((r) => JSON.parse(decryptWebPush({ body: r.body, ...device })).title)).toEqual(['a', 'b']);
    expect(received[0].headers.authorization).toBe(received[1].headers.authorization);
    await expect(transport(subscription(), 'x', { vapid })).rejects.toThrow(/at creation/);
  });

  test('l’en-tête VAPID gardé est refait quand il lui reste moins d’une heure', async () => {
    let clock = 1_800_000_000_000;
    const transport = createWebPushTransport(options({ now: () => clock }));
    await transport(subscription(), 'a');
    clock += 10 * 3600 * 1000;
    await transport(subscription(), 'b');
    clock += 1.5 * 3600 * 1000;
    await transport(subscription(), 'c');
    const exps = received.map((r) => parseAuthorization(r.headers.authorization).jwt.payload.exp);
    expect(exps[0]).toBe(exps[1]);
    expect(exps[2]).toBe(Math.floor(clock / 1000) + 12 * 3600);
  });

  test('une réponse immense est coupée à 64 Kio, sans attendre la fin', async () => {
    answer = (req, res) => {
      res.writeHead(500);
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      const pump = () => {
        while (res.write(chunk)) if (res.destroyed) return;
        res.once('drain', pump);
      };
      pump();
    };
    const started = Date.now();
    const error = await sendWebPush(subscription(), 'x', options()).catch((e) => e);
    expect(error.statusCode).toBe(500);
    expect(error.body.length).toBe(64 * 1024);
    expect(error.message).toMatch(/truncated/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('un service qui ne répond pas : abandon au délai donné', async () => {
    answer = () => {};
    const started = Date.now();
    const error = await sendWebPush(subscription(), 'x', options({ timeoutMs: 300 })).catch((e) => e);
    expect(error).toEqual(expect.objectContaining({ code: 'timeout' }));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('une redirection n’est jamais suivie', async () => {
    answer = (req, res) => res.writeHead(307, { location: 'https://169.254.169.254/latest/meta-data' }).end();
    const error = await sendWebPush(subscription(), 'x', options()).catch((e) => e);
    expect(error.statusCode).toBe(307);
    expect(received).toHaveLength(1);
  });

  test('sans le certificat du service (agent par défaut), la connexion est refusée', async () => {
    const error = await sendWebPush(subscription(), 'x', { vapid, extraHosts: ['127.0.0.1'] }).catch((e) => e);
    expect(error.code).toMatch(/CERT|SELF_SIGNED|UNABLE/);
    expect(received).toHaveLength(0);
  });

  test('un hôte hors de la liste : refusé avant toute connexion', async () => {
    const error = await sendWebPush(subscription(), 'x', { vapid, agent }).catch((e) => e);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(/not a known push service/);
    expect(received).toHaveLength(0);
  });
});

describe('attaques', () => {
  const device = newDevice();
  const vapid = { subject: 'mailto:contact@example.test', ...generateVapidKeys() };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: device.p256dh, auth: device.auth } };
  const asStatus = (fn) => (input) => {
    try {
      return fn(input);
    } catch (error) {
      if (error instanceof WebPushError) throw Object.assign(error, { status: 400 });
      throw error;
    }
  };

  test('le fuzz : abonnement, message et options quelconques donnent une requête ou une WebPushError', async () => {
    await assertFuzz(asStatus((value) => buildWebPushRequest(value, 'x', { vapid })), { generator: gen.oneOf(gen.json(), gen.record({ endpoint: gen.hostileString(), keys: gen.record({ p256dh: gen.hostileString(), auth: gen.hostileString() }) })), runs: 500 });
    await assertFuzz(asStatus((value) => buildWebPushRequest(sub, value, { vapid })), { generator: gen.oneOf(gen.json(), gen.hostileString(), gen.bytes({ max: 5000 })), runs: 300 });
    await assertFuzz(asStatus((value) => buildWebPushRequest(sub, 'x', value)), { generator: gen.oneOf(gen.json(), gen.record({ TTL: gen.json(), urgency: gen.hostileString(), topic: gen.hostileString(), headers: gen.json() })), runs: 500 });
  });

  test('un corps modifié, tronqué ou étranger ne se déchiffre jamais', async () => {
    const body = encryptWebPush({ ...device, payload: 'secret' });
    for (let i = 0; i < body.length; i++) {
      // Octets 16 à 19 : la taille d'enregistrement, que la RFC 8188 ne protège pas (elle ne sert qu'à découper) ;
      // une taille plus petite que l'enregistrement est refusée plus bas.
      if (i >= 16 && i <= 19) continue;
      const flipped = Buffer.from(body);
      flipped[i] ^= 0x01;
      expect(() => decryptWebPush({ body: flipped, ...device })).toThrow(WebPushError);
    }
    expect(() => decryptWebPush({ body: body.subarray(0, body.length - 1), ...device })).toThrow(WebPushError);
    const small = Buffer.from(body);
    small.writeUInt32BE(body.length - 87, 16);
    expect(() => decryptWebPush({ body: small, ...device })).toThrow(/single record/);
    expect(() => decryptWebPush({ body, ...newDevice() })).toThrow(WebPushError);
    await assertFuzz(asStatus((bytes) => decryptWebPush({ body: bytes, ...device })), { generator: gen.bytes({ max: 400 }), runs: 500, check: () => 'a random body decrypted' });
  });

  test('un enregistrement authentique mais sans délimiteur final (ou seulement du remplissage) est refusé', () => {
    // Construit à la main avec la clé et le nonce de la RFC 8291 : le chiffrement est juste, la structure ne l'est pas.
    const [rfc] = standardVectors.webPushRfc8291;
    const header = Buffer.from(rfc.expected.body, 'base64url').subarray(0, 86);
    const device = { privateKey: rfc.input.uaPrivate, p256dh: rfc.input.uaPublic, auth: rfc.input.authSecret };
    const seal = (plain) => {
      const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(rfc.expected.cek, 'base64url'), Buffer.from(rfc.expected.nonce, 'base64url'));
      return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    };
    expect(decryptWebPush({ body: seal(Buffer.from('ok\u0002\u0000\u0000')), ...device }).toString()).toBe('ok');
    for (const plain of [Buffer.from('ok'), Buffer.from('ok\u0001'), Buffer.alloc(5)]) expect(() => decryptWebPush({ body: seal(plain), ...device })).toThrow(/delimiter/);
    expect(() => encryptWebPush({ ...device, payload: Buffer.alloc(3994) })).toThrow(/3993/);
  });

  test('injection d’en-tête : sujet, en-têtes en plus et noms piégés sont refusés', () => {
    for (const topic of ['a\r\nX: y', 'a b', 'é', 'a/b']) expect(() => buildWebPushRequest(sub, 'x', { topic })).toThrow(/topic/);
    for (const headers of [{ 'X-A': 'v\r\nInjected: 1' }, { 'X A': 'v' }, { 'X-A\n': 'v' }, { authorization: 'Bearer x' }, { 'content-encoding': 'gzip' }, { Host: 'evil.test' }]) {
      expect(() => buildWebPushRequest(sub, 'x', { headers })).toThrow(WebPushError);
    }
  });

  test('adresses d’abonnement piégées : refusées', () => {
    for (const endpoint of ['https://fcm.googleapis.com.evil.test/x', 'https://evilfcm.googleapis.com.test/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'file:///etc/passwd', 'javascript:alert(1)', 'https://localhost/x', `https://fcm.googleapis.com/${'a'.repeat(3000)}`]) {
      expect(() => buildWebPushRequest({ ...sub, endpoint }, 'x')).toThrow(WebPushError);
    }
    for (const host of KNOWN_PUSH_HOSTS) expect(() => buildWebPushRequest({ ...sub, endpoint: `https://sub.${host}/x` }, 'x')).not.toThrow();
    expect(() => buildWebPushRequest({ ...sub, endpoint: 'https://push.example.test/x' }, 'x', { allowAnyHost: true })).not.toThrow();
  });

  test('clés VAPID : échéance passée ou à plus de 24 h refusée, clé privée nulle refusée', () => {
    const now = () => 1_800_000_000_000;
    expect(() => vapidAuthorization({ audience: 'https://fcm.googleapis.com', vapid, expiration: 1_800_000_000 - 1, now })).toThrow(/future/);
    expect(() => vapidAuthorization({ audience: 'https://fcm.googleapis.com', vapid, expiration: 1_800_000_000 + 24 * 3600 + 1, now })).toThrow(/24 hours/);
    expect(vapidAuthorization({ audience: 'https://fcm.googleapis.com', vapid, expiration: 1_800_000_000 + 24 * 3600, now }).expiration).toBe(1_800_086_400);
    expect(() => vapidAuthorization({ audience: 'https://fcm.googleapis.com/chemin', vapid })).toThrow(/origin/);
    expect(() => createWebPushTransport({ vapid: { ...vapid, privateKey: b64(Buffer.alloc(32)) } })).toThrow(WebPushError);
  });

  test('aucune expression régulière du module ne s’emballe', async () => {
    for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src/webPush.js'), 'utf8'))) await assertSafeRegex(regex);
  });
});
