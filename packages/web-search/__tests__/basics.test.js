const {
  canonicalUrl, domainOf, normalizeSite, inSite, sameSite,
  parseDate, ageInDays,
  normalizeRequest, detectRecency, withOperators,
  isPublicAddress, isBlockedHostname,
  redact, providerFailure
} = require('../src');

const NOW = Date.parse('2026-11-06T12:00:00Z');

describe('canonical pages', () => {
  test('one page under two forms is one canonical page', () => {
    expect(canonicalUrl('https://WWW.Example.com/guide/?utm_source=x&b=2&a=1#part')).toBe('https://example.com/guide?a=1&b=2');
    expect(canonicalUrl('https://example.com/guide?b=2&a=1&gclid=z')).toBe('https://example.com/guide?a=1&b=2');
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com');
    expect(canonicalUrl('https://example.com:443/a/b/')).toBe('https://example.com/a/b');
  });

  test('two different pages stay two pages', () => {
    expect(canonicalUrl('https://example.com/a')).not.toBe(canonicalUrl('https://example.com/b'));
    expect(canonicalUrl('https://example.com/a?id=1')).not.toBe(canonicalUrl('https://example.com/a?id=2'));
    expect(canonicalUrl('https://docs.example.com/a')).not.toBe(canonicalUrl('https://example.com/a'));
    expect(canonicalUrl('https://example.com/a//b')).not.toBe(canonicalUrl('https://example.com/a/b'));
    expect(canonicalUrl('https://example.com/v?si=2')).not.toBe(canonicalUrl('https://example.com/v'));
  });

  test('only https, never credentials', () => {
    expect(canonicalUrl('http://example.com/a')).toBeNull();
    expect(canonicalUrl('https://user:pw@example.com/a')).toBeNull();
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
  });

  test('sites', () => {
    expect(domainOf('https://www.Example.org./x')).toBe('example.org');
    expect(normalizeSite('https://www.example.com/path')).toBe('example.com');
    expect(normalizeSite('*.example.com')).toBe('example.com');
    expect(normalizeSite('localhost')).toBeNull();
    expect(normalizeSite('exa mple.com')).toBeNull();
    expect(inSite('docs.example.com', 'example.com')).toBe(true);
    expect(inSite('badexample.com', 'example.com')).toBe(false);
    expect(sameSite('https://example.com/a', 'https://www.example.com/b')).toBe(true);
    expect(sameSite('https://a.example.net/', 'https://b.example.net/')).toBe(false);
    expect(sameSite('https://example.com/', 'https://example.org/')).toBe(false);
  });
});

describe('dates', () => {
  test('ISO, written and relative dates; null rather than a guess', () => {
    expect(parseDate('2026-11-02')).toBe('2026-11-02T00:00:00.000Z');
    expect(parseDate('2026-11-02T08:30:00+02:00')).toBe('2026-11-02T06:30:00.000Z');
    expect(parseDate('Sep 2, 2026')).toBe('2026-09-02T00:00:00.000Z');
    expect(parseDate('2 sept. 2026')).toBe('2026-09-02T00:00:00.000Z');
    expect(parseDate('1er mars 2026')).toBe('2026-03-01T00:00:00.000Z');
    expect(parseDate('3 days ago', { now: NOW })).toBe('2026-11-03T12:00:00.000Z');
    expect(parseDate('il y a 2 heures', { now: NOW })).toBe('2026-11-06T10:00:00.000Z');
    expect(parseDate('an hour ago', { now: NOW })).toBe('2026-11-06T11:00:00.000Z');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('31 février 2026')).toBeNull();
    expect(parseDate('bientôt')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(ageInDays('2026-11-05T12:00:00Z', NOW)).toBe(1);
    expect(ageInDays(null, NOW)).toBeNull();
  });
});

describe('the request', () => {
  test('site operators written in the query become filters', () => {
    const request = normalizeRequest({ query: 'arrosage  site:example.org -site:spam.example.net tomates', lang: 'FR' }, { now: NOW });
    expect(request).toMatchObject({ query: 'arrosage tomates', lang: 'fr', sites: ['example.org'], excludeSites: ['spam.example.net'], limit: 8, freshness: null });
    expect(withOperators(request)).toBe('arrosage tomates site:example.org -site:spam.example.net');
    expect(withOperators({ ...request, sites: ['a.example', 'b.example'] })).toBe('arrosage tomates (site:a.example OR site:b.example) -site:spam.example.net');
  });

  test('freshness: a filter when asked, a preference when the question wants recent facts', () => {
    expect(normalizeRequest({ query: 'x', freshness: 'week' }, { now: NOW })).toMatchObject({ freshness: 'week', recency: { wanted: true, window: 'week', reason: 'asked' } });
    expect(normalizeRequest({ query: "les nouvelles d'aujourd'hui" }, { now: NOW })).toMatchObject({ freshness: null, recency: { wanted: true, window: 'day' } });
    expect(normalizeRequest({ query: 'latest release notes' }, { now: NOW }).recency.wanted).toBe(true);
    expect(normalizeRequest({ query: 'calendrier 2026' }, { now: NOW }).recency).toMatchObject({ wanted: true, window: 'year' });
    expect(normalizeRequest({ query: 'histoire de 1905' }, { now: NOW }).recency.wanted).toBe(false);
    expect(normalizeRequest({ query: 'latest', freshness: 'any' }, { now: NOW }).recency.wanted).toBe(false);
    expect(detectRecency('Quel est le prix actuel ?').wanted).toBe(true);
  });

  test('a bad request is refused before anything is asked', () => {
    expect(() => normalizeRequest({ query: '   ' })).toThrow('query is empty');
    expect(() => normalizeRequest({ query: 'x', freshness: 'decade' })).toThrow('freshness');
    expect(() => normalizeRequest({ query: 'x', lang: 'french' })).toThrow('two-letter');
    expect(() => normalizeRequest({ query: 'x', sites: ['not a site'] })).toThrow('invalid site');
    expect(() => normalizeRequest({ query: 'x'.repeat(401) })).toThrow('longer');
    expect(normalizeRequest({ query: 'x', limit: 500 }).limit).toBe(20);
  });
});

describe('public addresses only', () => {
  test.each([
    ['93.184.216.34', true], ['8.8.8.8', true], ['2606:4700::1111', true],
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.20.0.1', false], ['192.168.1.1', false],
    ['169.254.169.254', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false],
    ['::1', false], ['::', false], ['fe80::1', false], ['fd00::1', false], ['ff02::1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:7f00:1', false], ['::ffff:8.8.8.8', true], ['::127.0.0.1', false],
    ['64:ff9b::a9fe:a9fe', false], ['2002:7f00:1::', false], ['2001:db8::1', false], ['not-an-ip', false]
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  test('host names refused without a lookup', () => {
    for (const host of ['localhost', 'api.localhost', 'printer.local', 'metadata.google.internal', 'intranet', '127.0.0.1', '[::1]', '1.0.0.127.in-addr.arpa']) {
      expect(isBlockedHostname(host)).toBe(true);
    }
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('93.184.216.34')).toBe(false);
  });
});

describe('errors never carry a key', () => {
  test('redaction and classification', () => {
    const key = ['sk', 'test', 'abcdef123456'].join('_');
    expect(redact(`bad key ${key}!`, [key])).toBe('bad key [redacted]!');
    const network = providerFailure('brave', { cause: { message: `connect failed with ${key}` }, secrets: [key] });
    expect(network.message).not.toContain(key);
    expect(network).toMatchObject({ retryable: true, quota: false });
    expect(providerFailure('brave', { status: 429 })).toMatchObject({ retryable: true, quota: true, status: 429 });
    expect(providerFailure('brave', { status: 402 })).toMatchObject({ retryable: false, quota: true });
    expect(providerFailure('brave', { status: 400 })).toMatchObject({ retryable: false, quota: false });
    expect(providerFailure('brave', { status: 503 })).toMatchObject({ retryable: true, quota: false });
  });
});
