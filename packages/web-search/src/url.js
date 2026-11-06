/**
 * Les adresses : la page canonique d'un résultat, son site, et les filtres de sites.
 *
 * Deux moteurs rendent souvent la même page sous deux formes
 * (`https://www.example.com/a/?utm_source=x` et `https://example.com/a`) : la
 * forme canonique les réunit, pour que la page ne compte qu'une fois. Elle ne
 * réunit jamais deux pages différentes : le chemin et les paramètres utiles
 * restent, seuls l'hôte (casse, `www.`), le fragment, la barre finale et les
 * paramètres de suivi publicitaire disparaissent.
 */

const TRACKING = new Set([
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid',
  '_hsenc', '_hsmi', 'mkt_tok', 'srsltid'
]);

/** L'adresse https lue, ou null (autre protocole, illisible, identifiants dans l'adresse). */
function parseHttps(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch (_error) {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url;
}

/** Le site d'une adresse : son hôte en minuscules, sans `www.` ni point final. */
function domainOf(value) {
  const url = value instanceof URL ? value : parseHttps(value);
  if (!url) return null;
  return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * La forme canonique d'une page : https, hôte sans `www.`, port par défaut retiré,
 * sans fragment ni paramètres de suivi, paramètres restants triés, sans barre finale.
 * @returns {string|null}
 */
function canonicalUrl(value) {
  const url = parseHttps(value);
  if (!url) return null;
  const host = domainOf(url);
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING.has(key.toLowerCase()))
    .sort(([a, va], [b, vb]) => (a < b ? -1 : a > b ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  /* Seule la barre finale part (`/a/` et `/a`) : `//` au milieu d'un chemin peut être une autre page. */
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const port = url.port && url.port !== '443' ? `:${url.port}` : '';
  const query = kept.length ? `?${new globalThis.URLSearchParams(kept).toString()}` : '';
  return `https://${host}${port}${path === '/' ? '' : path}${query}`;
}

/** Un site écrit par l'appelant (`example.com`, `https://www.example.com/`, `*.example.com`), ramené à son domaine. */
function normalizeSite(site) {
  const raw = String(site ?? '').trim().toLowerCase().replace(/^\*\./, '');
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//.test(raw) ? raw.replace(/^http:/, 'https:') : `https://${raw}`;
  const domain = domainOf(withScheme);
  return domain && /^[a-z0-9.-]+$/.test(domain) && domain.includes('.') ? domain : null;
}

/** Vrai si le domaine est ce site ou l'un de ses sous-domaines (`docs.example.com` est dans `example.com`). */
function inSite(domain, site) {
  return Boolean(domain && site) && (domain === site || domain.endsWith(`.${site}`));
}

/** Vrai si deux adresses sont du même site (même domaine, ou l'une sous-domaine de l'autre). */
function sameSite(a, b) {
  const da = domainOf(a);
  const db = domainOf(b);
  return Boolean(da && db) && (inSite(da, db) || inSite(db, da));
}

module.exports = { parseHttps, domainOf, canonicalUrl, normalizeSite, inSite, sameSite, TRACKING_PARAMS: TRACKING };
