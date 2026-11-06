const https = require('https');
const { safeFetch, safeLookup } = require('../src');
const { fakeNetwork } = require('./helpers');

const PUBLIC = '93.184.216.34';
const html = (text) => `<html><body><article><p>${text}</p></article></body></html>`;

describe('reading a page without SSRF', () => {
  test('a public https page is read, gzip decoded, charset respected', async () => {
    const network = fakeNetwork({
      'example.com': { addresses: [PUBLIC], pages: { '/a': { body: html('Bonjour'), gzip: true } } },
      'example.org': { addresses: [PUBLIC], pages: { '/latin': { body: Buffer.from('<p>Caf\xe9</p>', 'latin1'), headers: { 'content-type': 'text/html; charset=iso-8859-1' } } } }
    });
    const page = await safeFetch('https://example.com/a', network);
    expect(page).toMatchObject({ status: 200, finalUrl: 'https://example.com/a', redirects: [], truncated: false });
    expect(page.body).toContain('Bonjour');
    expect((await safeFetch('https://example.org/latin', network)).body).toBe('<p>Café</p>');
  });

  test.each([
    ['http://example.com/', 'WEB_READ_BLOCKED_URL'],
    ['https://user:pw@example.com/', 'WEB_READ_BLOCKED_URL'],
    ['https://example.com:8443/', 'WEB_READ_BLOCKED_URL'],
    ['file:///etc/passwd', 'WEB_READ_BLOCKED_URL'],
    ['https://localhost/', 'WEB_READ_BLOCKED_ADDRESS'],
    ['https://127.0.0.1/', 'WEB_READ_BLOCKED_ADDRESS'],
    ['https://169.254.169.254/latest/meta-data/', 'WEB_READ_BLOCKED_ADDRESS'],
    ['https://[::1]/', 'WEB_READ_BLOCKED_ADDRESS'],
    ['https://[::ffff:127.0.0.1]/', 'WEB_READ_BLOCKED_ADDRESS'],
    ['https://metadata.google.internal/', 'WEB_READ_BLOCKED_ADDRESS']
  ])('%s is refused before any connection', async (url, code) => {
    const network = fakeNetwork({});
    await expect(safeFetch(url, network)).rejects.toMatchObject({ code });
    expect(network.log).toEqual([]);
  });

  test('a name that resolves to an internal address is refused, even when one address of the list is public', async () => {
    const network = fakeNetwork({
      'evil.example': { addresses: ['10.0.0.5'], pages: { '/': { body: 'secret' } } },
      'mixed.example': { addresses: [PUBLIC, '127.0.0.1'], pages: { '/': { body: 'secret' } } }
    });
    await expect(safeFetch('https://evil.example/', network)).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED_ADDRESS' });
    await expect(safeFetch('https://mixed.example/', network)).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED_ADDRESS' });
    expect(network.log).toEqual([]);
  });

  test('DNS rebinding: each connection resolves again and is checked again', async () => {
    let calls = 0;
    const network = fakeNetwork({
      'rebind.example': {
        addresses: () => ((calls += 1) === 1 ? [PUBLIC] : ['127.0.0.1']),
        pages: { '/': { status: 302, headers: { location: '/admin' } }, '/admin': { body: 'secret' } }
      }
    });
    await expect(safeFetch('https://rebind.example/', network)).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED_ADDRESS' });
    expect(network.log.filter((line) => !line.startsWith('closed'))).toEqual(['rebind.example/']);
  });

  test('redirects are followed by hand and checked one by one', async () => {
    const network = fakeNetwork({
      'example.com': { addresses: [PUBLIC], pages: {
        '/old': { status: 301, headers: { location: 'https://www.example.com/new' } },
        '/to-internal': { status: 302, headers: { location: 'https://127.0.0.1/admin' } },
        '/to-http': { status: 302, headers: { location: 'http://example.com/' } },
        '/loop': { status: 302, headers: { location: '/loop' } }
      } },
      'www.example.com': { addresses: [PUBLIC], pages: { '/new': { body: html('Nouvelle page') } } }
    });
    const page = await safeFetch('https://example.com/old', network);
    expect(page).toMatchObject({ finalUrl: 'https://www.example.com/new', redirects: ['https://www.example.com/new'] });
    await expect(safeFetch('https://example.com/to-internal', network)).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED_ADDRESS' });
    await expect(safeFetch('https://example.com/to-http', network)).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED_URL' });
    await expect(safeFetch('https://example.com/loop', network)).rejects.toMatchObject({ code: 'WEB_READ_TOO_MANY_REDIRECTS' });
  });

  test('size is counted after decompression; the page is cut, not the memory', async () => {
    const network = fakeNetwork({ 'example.com': { addresses: [PUBLIC], pages: { '/big': { body: 'a'.repeat(5_000_000), gzip: true } } } });
    const page = await safeFetch('https://example.com/big', { ...network, maxBytes: 10_000 });
    expect(page).toMatchObject({ truncated: true, bytes: 10_000 });
  });

  test('only HTML or text; an error status is an error; a page that never answers times out', async () => {
    const network = fakeNetwork({ 'example.com': { addresses: [PUBLIC], pages: {
      '/pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF' },
      '/gone': { status: 404, body: 'no' },
      '/slow': { hang: true }
    } } });
    await expect(safeFetch('https://example.com/pdf', network)).rejects.toMatchObject({ code: 'WEB_READ_UNSUPPORTED_TYPE' });
    await expect(safeFetch('https://example.com/gone', network)).rejects.toMatchObject({ code: 'WEB_READ_BAD_STATUS', status: 404 });
    await expect(safeFetch('https://example.com/slow', { ...network, timeoutMs: 50 })).rejects.toMatchObject({ code: 'WEB_READ_TIMEOUT' });
  });

  test('a body cut in the middle fails at once, compressed or not; a refused answer closes its connection', async () => {
    const network = fakeNetwork({ 'example.com': { addresses: [PUBLIC], pages: {
      '/cut-gzip': { body: 'x'.repeat(200_000), gzip: true, cut: true },
      '/cut': { body: 'x'.repeat(200_000), cut: true },
      '/endless-404': { status: 404, endless: true },
      '/endless-pdf': { headers: { 'content-type': 'application/pdf' }, endless: true }
    } } });
    const started = Date.now();
    await expect(safeFetch('https://example.com/cut-gzip', { ...network, timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'WEB_READ_FAILED' });
    await expect(safeFetch('https://example.com/cut', { ...network, timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'WEB_READ_FAILED' });
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(safeFetch('https://example.com/endless-404', network)).rejects.toMatchObject({ code: 'WEB_READ_BAD_STATUS' });
    await expect(safeFetch('https://example.com/endless-pdf', network)).rejects.toMatchObject({ code: 'WEB_READ_UNSUPPORTED_TYPE' });
    expect(network.log).toEqual(expect.arrayContaining(['closed example.com/endless-404', 'closed example.com/endless-pdf']));
  });

  test('an endless page stops at maxBytes and its connection is closed', async () => {
    const network = fakeNetwork({ 'example.com': { addresses: [PUBLIC], pages: { '/endless': { endless: true } } } });
    const page = await safeFetch('https://example.com/endless', { ...network, maxBytes: 300_000 });
    expect(page).toMatchObject({ truncated: true, bytes: 300_000 });
    expect(network.log).toContain('closed example.com/endless');
  });

  test('with the real https.request, an internal address never gets a connection', async () => {
    const resolve = (_host, _options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await expect(safeFetch('https://example.com/', { request: https.request, resolve, timeoutMs: 2_000 })).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED_ADDRESS' });
  });

  test('safeLookup answers in both forms Node uses', (done) => {
    const lookup = safeLookup((_host, _options, cb) => cb(null, [{ address: PUBLIC, family: 4 }]));
    lookup('example.com', {}, (error, address, family) => {
      expect([error, address, family]).toEqual([null, PUBLIC, 4]);
      lookup('example.com', { all: true }, (again, list) => {
        expect(again).toBeNull();
        expect(list).toEqual([{ address: PUBLIC, family: 4 }]);
        done();
      });
    });
  });
});
