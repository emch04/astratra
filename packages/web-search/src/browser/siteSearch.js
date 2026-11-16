/**
 * La recherche interne d'un site, sans clic ni frappe : on calcule l'adresse
 * de la page de résultats, puis on l'ouvre comme n'importe quelle page.
 *
 * Deux sources, dans cet ordre :
 * 1. la description OpenSearch du site (`<link rel="search"
 *    type="application/opensearchdescription+xml">`), dont le modèle
 *    d'adresse porte `{searchTerms}` ;
 * 2. un formulaire `GET` qui n'a qu'un champ texte, marqué comme recherche
 *    (`type="search"`, ou formulaire dans un élément `role="search"`).
 *
 * L'adresse de résultats doit rester en https sur le même site que la page :
 * une description qui renverrait vers un moteur de recherche n'est pas
 * suivie. Les moteurs eux-mêmes sont refusés : la recherche web passe par
 * leurs API, jamais par leur page de recherche.
 */

const { parseHttps, domainOf, inSite, sameSite } = require('../url');
const { decodeEntities } = require('../text');

/* Les moteurs dont on ne remplit jamais la page de recherche. */
const SEARCH_ENGINES = Object.freeze([
  'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'yandex.com', 'yandex.ru', 'baidu.com', 'ecosia.org',
  'qwant.com', 'search.brave.com', 'startpage.com', 'ask.com', 'aol.com', 'naver.com', 'seznam.cz', 'mojeek.com',
  'you.com', 'perplexity.ai', 'kagi.com', 'sogou.com', 'so.com'
]);

const MAX_QUERY = 200;
const TEXT_TYPES = new Set(['', 'text', 'search']);

/** Vrai pour un moteur de recherche (google.fr, www.bing.com, search.brave.com…). */
function isSearchEngine(value) {
  const domain = typeof value === 'string' && !value.includes('/') ? value.toLowerCase().replace(/^www\./, '') : domainOf(value);
  if (!domain) return false;
  if (/(^|\.)google\.[a-z.]+$/.test(domain) || /(^|\.)yahoo\.[a-z.]+$/.test(domain) || /(^|\.)bing\.[a-z.]+$/.test(domain)) return true;
  return SEARCH_ENGINES.some((site) => inSite(domain, site));
}

/** La requête, nettoyée : une ligne, 200 caractères au plus. */
function cleanQuery(query) {
  // eslint-disable-next-line no-control-regex -- on retire justement les caractères de contrôle
  const text = String(query ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_QUERY);
}

function attributes(tag) {
  const out = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return out;
}

/* Les paramètres OpenSearch connus, remplis avec des valeurs neutres. */
function fillTemplate(template, query) {
  const known = {
    searchterms: encodeURIComponent(query),
    count: '10',
    startindex: '1',
    startpage: '1',
    language: '*',
    inputencoding: 'UTF-8',
    outputencoding: 'UTF-8'
  };
  let failed = false;
  const filled = template.replace(/\{([^}]+)\}/g, (whole, inner) => {
    const optional = inner.endsWith('?');
    const name = inner.replace(/\?$/, '');
    /* Un paramètre d'une extension (geo:box, time:start…) n'est rempli que s'il est facultatif : vide. */
    if (!name.includes(':') && known[name.toLowerCase()] !== undefined) return known[name.toLowerCase()];
    if (optional) return '';
    failed = true;
    return whole;
  });
  return failed ? null : filled;
}

/**
 * L'adresse de résultats tirée d'une description OpenSearch.
 * @param {string} xml
 * @param {{ query: string, pageUrl: string }} context
 * @returns {string|null}
 */
function openSearchUrl(xml, { query, pageUrl }) {
  const text = String(xml ?? '').slice(0, 100_000);
  const cleaned = cleanQuery(query);
  if (!cleaned) return null;
  const candidates = [];
  for (const match of text.matchAll(/<(?:[\w-]+:)?Url\b([^>]*)\/?>/gi)) {
    const attrs = attributes(match[1]);
    const type = String(attrs.type || '').toLowerCase().split(';')[0].trim();
    const method = String(attrs.method || 'get').toLowerCase();
    if (!['text/html', 'application/xhtml+xml'].includes(type) || method !== 'get') continue;
    if (!attrs.template || !/\{searchTerms\??\}/.test(attrs.template)) continue;
    candidates.push(attrs.template);
  }
  for (const template of candidates) {
    const filled = fillTemplate(template, cleaned);
    if (!filled) continue;
    let absolute;
    try {
      absolute = new URL(filled, pageUrl).href;
    } catch (_error) {
      continue;
    }
    if (parseHttps(absolute) && sameSite(absolute, pageUrl) && !isSearchEngine(absolute)) return absolute;
  }
  return null;
}

/**
 * L'adresse de résultats tirée d'un formulaire décrit par la page.
 * @param {{ action?: string, method?: string, searchRole?: boolean, fields: { name: string, type: string, value?: string, checked?: boolean }[] }} form
 * @param {{ query: string, pageUrl: string }} context
 * @returns {string|null}
 */
function formSearchUrl(form, { query, pageUrl }) {
  if (!form || !Array.isArray(form.fields)) return null;
  const cleaned = cleanQuery(query);
  if (!cleaned) return null;
  if (String(form.method || 'get').toLowerCase() !== 'get') return null;
  const texts = form.fields.filter((field) => TEXT_TYPES.has(String(field.type || '').toLowerCase()));
  if (texts.length !== 1 || !texts[0].name) return null;
  const textField = texts[0];
  if (String(textField.type).toLowerCase() !== 'search' && !form.searchRole) return null;
  /* Un formulaire qui demande autre chose qu'une recherche (mot de passe, fichier, adresse e-mail…) n'est pas une recherche. */
  const refused = form.fields.some((field) => ['password', 'file', 'email', 'tel', 'number', 'date', 'url', 'textarea'].includes(String(field.type || '').toLowerCase()));
  if (refused) return null;
  let action;
  try {
    action = new URL(form.action || pageUrl, pageUrl);
  } catch (_error) {
    return null;
  }
  if (!parseHttps(action.href) || !sameSite(action.href, pageUrl) || isSearchEngine(action.href)) return null;
  const params = new globalThis.URLSearchParams();
  for (const field of form.fields) {
    const type = String(field.type || '').toLowerCase();
    if (!field.name) continue;
    if (field === textField) params.append(field.name, cleaned);
    else if (type === 'hidden' || type === 'select') params.append(field.name, String(field.value ?? ''));
    else if ((type === 'checkbox' || type === 'radio') && field.checked) params.append(field.name, String(field.value ?? 'on'));
  }
  action.hash = '';
  action.search = params.toString();
  return action.href;
}

module.exports = { openSearchUrl, formSearchUrl, isSearchEngine, cleanSiteQuery: cleanQuery, SEARCH_ENGINES };
