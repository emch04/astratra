/*
 * Les vérifications et nettoyages de texte dont se servent les chaînes de validation (src/validation.js), portés de
 * validator.js 13.15 (licence MIT, Copyright (c) 2018 Chris O'Hara ; voir THIRD-PARTY-NOTICES.md) : mêmes réponses
 * sur des vecteurs enregistrés. Chaque fonction reçoit un texte.
 *
 * Différences voulues, toutes là où validator.js levait une exception au lieu de répondre :
 *   - la longueur en octets d'un texte qui contient un demi-caractère Unicode (une moitié de paire) est refusée
 *     (validator.js levait une URIError dans isByteLength et isEmail, qui faisait une erreur 500) ;
 *   - isIn et isUUID ne lisent que les propriétés propres de l'objet donné (« constructor » n'est pas une version).
 */

// eslint-disable-next-line no-control-regex
const splitNameAddress = /^([^\x00-\x1F\x7F-\x9F\cX]+)</i;
const emailUserPart = /^[a-z\d!#$%&'*+\-/=?^_`{|}~]+$/i;
const gmailUserPart = /^[a-z\d]+$/;
// eslint-disable-next-line no-control-regex
const quotedEmailUser = /^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e]|(\\[\x01-\x09\x0b\x0c\x0d-\x7f]))*$/i;
const emailUserUtf8Part = /^[a-z\d!#$%&'*+\-/=?^_`{|}~\u00A1-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+$/i;
// eslint-disable-next-line no-control-regex
const quotedEmailUserUtf8 = /^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]|(\\[\x01-\x09\x0b\x0c\x0d-\x7f\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]))*$/i;
const DEFAULT_MAX_EMAIL_LENGTH = 254;

const DECIMAL = {};
for (const [sep, locales] of Object.entries({
  '.': ['en-US', 'en-AU', 'en-GB', 'en-HK', 'en-IN', 'en-NZ', 'en-ZA', 'ar-EG', 'ar-LB', 'ar-LY', 'bn-BD', 'bn-IN'],
  '٫': ['ar', 'ar-AE', 'ar-BH', 'ar-DZ', 'ar-IQ', 'ar-JO', 'ar-KW', 'ar-MA', 'ar-QM', 'ar-QA', 'ar-SA', 'ar-SD', 'ar-SY', 'ar-TN', 'ar-YE', 'fa-IR', 'fa-AF'],
  ',': ['en-ZM', 'bg-BG', 'cs-CZ', 'da-DK', 'de-DE', 'el-GR', 'eo', 'es-ES', 'fr-CA', 'fr-FR', 'gu-IN', 'hi-IN', 'hu-HU', 'id-ID', 'it-IT', 'kk-KZ', 'kn-IN', 'ku-IQ', 'ml-IN', 'nb-NO', 'nl-NL', 'nn-NO', 'or-IN', 'pa-IN', 'pl-PL', 'pt-PT', 'ru-RU', 'si-LK', 'sl-SI', 'sr-RS', 'sr-RS@latin', 'sv-SE', 'ta-IN', 'te-IN', 'tr-TR', 'uk-UA', 'vi-VN', 'pt-BR', 'pl-Pl'],
})) for (const locale of locales) DECIMAL[locale] = sep;
const decimalOf = (locale) => (locale && Object.hasOwn(DECIMAL, locale) ? DECIMAL[locale] : undefined);

/** Les options données, complétées par les valeurs par défaut (comme merge de validator.js). */
function merge(options, defaults) {
  const out = typeof options === 'object' && options !== null ? { ...options } : {};
  for (const key of Object.keys(defaults)) if (typeof out[key] === 'undefined') out[key] = defaults[key];
  return out;
}

/** Le texte d'une option (toString de validator.js). */
function optionString(input) {
  if (typeof input === 'object' && input !== null) return typeof input.toString === 'function' ? String(input.toString()) : '[object Object]';
  if (input === null || typeof input === 'undefined' || (Number.isNaN(Number(input)) && !input.length)) return '';
  return String(input);
}

const isNullish = (value) => value === null || value === undefined;
const has = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key);

/** La longueur en octets UTF-8 ; null si le texte contient un demi-caractère (encodeURI levait). */
function byteLength(str) {
  if (!str.isWellFormed()) return null;
  return Buffer.byteLength(str, 'utf8');
}

function isByteLength(str, options) {
  const min = (options && options.min) || 0;
  const max = options && options.max;
  const len = byteLength(str);
  if (len === null) return false;
  return len >= min && (typeof max === 'undefined' || len <= max);
}

function isFQDN(str, options) {
  const o = merge(options, { require_tld: true, allow_underscores: false, allow_trailing_dot: false, allow_numeric_tld: false, allow_wildcard: false, ignore_max_length: false });
  if (o.allow_trailing_dot && str[str.length - 1] === '.') str = str.substring(0, str.length - 1);
  if (o.allow_wildcard === true && str.indexOf('*.') === 0) str = str.substring(2);
  const parts = str.split('.');
  const tld = parts[parts.length - 1];
  if (o.require_tld) {
    if (parts.length < 2) return false;
    if (!o.allow_numeric_tld && !/^([a-z\u00A1-\u00A8\u00AA-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]{2,}|xn[a-z0-9-]{2,})$/i.test(tld)) return false;
    if (/\s/.test(tld)) return false;
  }
  if (!o.allow_numeric_tld && /^\d+$/.test(tld)) return false;
  return parts.every((part) => {
    if (part.length > 63 && !o.ignore_max_length) return false;
    if (!/^[a-z_\u00a1-\uffff0-9-]+$/i.test(part)) return false;
    if (/[\uff01-\uff5e]/.test(part)) return false;
    if (/^-|-$/.test(part)) return false;
    if (!o.allow_underscores && /_/.test(part)) return false;
    return true;
  });
}

const IPV4_SEGMENT = '(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])';
const IPV4_ADDRESS = `(${IPV4_SEGMENT}[.]){3}${IPV4_SEGMENT}`;
const IPV4 = new RegExp(`^${IPV4_ADDRESS}$`);
const S6 = '(?:[0-9a-fA-F]{1,4})';
const IPV6 = new RegExp(
  `^((?:${S6}:){7}(?:${S6}|:)|(?:${S6}:){6}(?:${IPV4_ADDRESS}|:${S6}|:)|(?:${S6}:){5}(?::${IPV4_ADDRESS}|(:${S6}){1,2}|:)|(?:${S6}:){4}(?:(:${S6}){0,1}:${IPV4_ADDRESS}|(:${S6}){1,3}|:)|(?:${S6}:){3}(?:(:${S6}){0,2}:${IPV4_ADDRESS}|(:${S6}){1,4}|:)|(?:${S6}:){2}(?:(:${S6}){0,3}:${IPV4_ADDRESS}|(:${S6}){1,5}|:)|(?:${S6}:){1}(?:(:${S6}){0,4}:${IPV4_ADDRESS}|(:${S6}){1,6}|:)|(?::((?::${S6}){0,5}:${IPV4_ADDRESS}|(?::${S6}){1,7}|:)))(%[0-9a-zA-Z.]{1,})?$`
);

function isIP(str, options) {
  const version = String((typeof options === 'object' && options !== null ? options.version : options) || '');
  if (!version) return IPV4.test(str) || IPV6.test(str);
  if (version === '4') return IPV4.test(str);
  if (version === '6') return IPV6.test(str);
  return false;
}

const checkHost = (host, list) => list.some((match) => host === match || (match instanceof RegExp && match.test(host)));

function validateDisplayName(displayName) {
  const withoutQuotes = displayName.replace(/^"(.+)"$/, '$1');
  if (!withoutQuotes.trim()) return false;
  if (/[.";<>]/.test(withoutQuotes)) {
    if (withoutQuotes === displayName) return false;
    if (withoutQuotes.split('"').length !== withoutQuotes.split('\\"').length) return false;
  }
  return true;
}

function isEmail(str, options) {
  const o = merge(options, { allow_display_name: false, allow_underscores: false, require_display_name: false, allow_utf8_local_part: true, require_tld: true, blacklisted_chars: '', ignore_max_length: false, host_blacklist: [], host_whitelist: [] });
  if (o.require_display_name || o.allow_display_name) {
    const display = str.match(splitNameAddress);
    if (display) {
      let displayName = display[1];
      str = str.replace(displayName, '').replace(/(^<|>$)/g, '');
      if (displayName.endsWith(' ')) displayName = displayName.slice(0, -1);
      if (!validateDisplayName(displayName)) return false;
    } else if (o.require_display_name) return false;
  }
  if (!o.ignore_max_length && str.length > DEFAULT_MAX_EMAIL_LENGTH) return false;
  const parts = str.split('@');
  const domain = parts.pop();
  const lowerDomain = domain.toLowerCase();
  if (o.host_blacklist.length > 0 && checkHost(lowerDomain, o.host_blacklist)) return false;
  if (o.host_whitelist.length > 0 && !checkHost(lowerDomain, o.host_whitelist)) return false;
  let user = parts.join('@');
  if (o.domain_specific_validation && (lowerDomain === 'gmail.com' || lowerDomain === 'googlemail.com')) {
    user = user.toLowerCase();
    const username = user.split('+')[0];
    if (!isByteLength(username.replace(/\./g, ''), { min: 6, max: 30 })) return false;
    if (!username.split('.').every((part) => gmailUserPart.test(part))) return false;
  }
  if (o.ignore_max_length === false && (!isByteLength(user, { max: 64 }) || !isByteLength(domain, { max: 254 }))) return false;
  if (!isFQDN(domain, { require_tld: o.require_tld, ignore_max_length: o.ignore_max_length, allow_underscores: o.allow_underscores })) {
    if (!o.allow_ip_domain) return false;
    if (!isIP(domain)) {
      if (!domain.startsWith('[') || !domain.endsWith(']')) return false;
      const bare = domain.slice(1, -1);
      if (bare.length === 0 || !isIP(bare)) return false;
    }
  }
  if (o.blacklisted_chars && user.search(new RegExp(`[${o.blacklisted_chars}]+`, 'g')) !== -1) return false;
  if (user[0] === '"' && user[user.length - 1] === '"') {
    user = user.slice(1, user.length - 1);
    return o.allow_utf8_local_part ? quotedEmailUserUtf8.test(user) : quotedEmailUser.test(user);
  }
  const pattern = o.allow_utf8_local_part ? emailUserUtf8Part : emailUserPart;
  return user.split('.').every((part) => pattern.test(part));
}

function isEmpty(str, options) {
  const o = merge(options, { ignore_whitespace: false });
  return (o.ignore_whitespace ? str.trim().length : str.length) === 0;
}

function isLength(str, options) {
  const min = (options && typeof options === 'object' && options.min) || 0;
  const max = options && typeof options === 'object' ? options.max : undefined;
  const presentation = str.match(/[^\uFE0F\uFE0E][\uFE0F\uFE0E]/g) || [];
  const surrogates = str.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || [];
  const len = str.length - presentation.length - surrogates.length;
  const inside = len >= min && (typeof max === 'undefined' || len <= max);
  if (inside && options && Array.isArray(options.discreteLengths)) return options.discreteLengths.some((d) => d === len);
  return inside;
}

const isHexadecimal = (str) => /^(0x|0h)?[0-9A-F]+$/i.test(str);
const isMongoId = (str) => isHexadecimal(str) && str.length === 24;

function isIn(str, options) {
  if (Array.isArray(options)) return options.map(optionString).indexOf(str) >= 0;
  if (typeof options === 'object' && options !== null) return Object.hasOwn(options, str);
  if (options && typeof options.indexOf === 'function') return options.indexOf(str) >= 0;
  return false;
}

function isNumeric(str, options) {
  if (options && options.no_symbols) return /^[0-9]+$/.test(str);
  const sep = (options || {}).locale ? decimalOf(options.locale) : '.';
  return new RegExp(`^[+-]?([0-9]*[${sep}])?[0-9]+$`).test(str);
}

function isInt(str, options) {
  const o = options || {};
  const regex = o.allow_leading_zeroes === false ? /^(?:[-+]?(?:0|[1-9][0-9]*))$/ : /^[-+]?[0-9]+$/;
  const ok = (key, test) => !has(o, key) || isNullish(o[key]) || test(o[key]);
  return regex.test(str) && ok('min', (v) => str >= v) && ok('max', (v) => str <= v) && ok('lt', (v) => str < v) && ok('gt', (v) => str > v);
}

function isFloat(str, options) {
  const o = options || {};
  const sep = o.locale ? decimalOf(o.locale) : '.';
  const float = new RegExp(`^(?:[-+])?(?:[0-9]+)?(?:\\${sep}[0-9]*)?(?:[eE][\\+\\-]?(?:[0-9]+))?$`);
  if (str === '' || str === '.' || str === ',' || str === '-' || str === '+') return false;
  const value = parseFloat(str.replace(',', '.'));
  const ok = (key, test) => !has(o, key) || isNullish(o[key]) || test(o[key]);
  return float.test(str) && ok('min', (v) => value >= v) && ok('max', (v) => value <= v) && ok('lt', (v) => value < v) && ok('gt', (v) => value > v);
}

function isBoolean(str, options = { loose: false }) {
  if (options && options.loose) return ['true', 'false', '1', '0', 'yes', 'no'].includes(str.toLowerCase());
  return ['true', 'false', '1', '0'].includes(str);
}

function matches(str, pattern, modifiers) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, modifiers);
  return !!str.match(regex);
}

const equals = (str, comparison) => str === comparison;

function contains(str, elem, options) {
  const o = merge(options, { ignoreCase: false, minOccurrences: 1 });
  if (o.ignoreCase) return str.toLowerCase().split(optionString(elem).toLowerCase()).length > o.minOccurrences;
  return str.split(optionString(elem)).length > o.minOccurrences;
}

const UUID = {
  1: /^[0-9A-F]{8}-[0-9A-F]{4}-1[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  2: /^[0-9A-F]{8}-[0-9A-F]{4}-2[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  3: /^[0-9A-F]{8}-[0-9A-F]{4}-3[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  4: /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  5: /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  6: /^[0-9A-F]{8}-[0-9A-F]{4}-6[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  7: /^[0-9A-F]{8}-[0-9A-F]{4}-7[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  8: /^[0-9A-F]{8}-[0-9A-F]{4}-8[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  nil: /^00000000-0000-0000-0000-000000000000$/i,
  max: /^ffffffff-ffff-ffff-ffff-ffffffffffff$/i,
  loose: /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
  all: /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i,
};
function isUUID(str, version) {
  const v = version === undefined || version === null ? 'all' : version;
  return Object.hasOwn(UUID, v) ? UUID[v].test(str) : false;
}

// Les nettoyages.
const escapeClass = (chars) => chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ltrim = (str, chars) => str.replace(chars ? new RegExp(`^[${escapeClass(chars)}]+`, 'g') : /^\s+/g, '');
function rtrim(str, chars) {
  if (chars) return str.replace(new RegExp(`[${escapeClass(chars)}]+$`, 'g'), '');
  let end = str.length - 1;
  while (/\s/.test(str.charAt(end))) end -= 1;
  return str.slice(0, end + 1);
}
const trim = (str, chars) => rtrim(ltrim(str, chars), chars);
const escape = (str) => str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\//g, '&#x2F;').replace(/\\/g, '&#x5C;').replace(/`/g, '&#96;');
const unescape = (str) => str.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/').replace(/&#x5C;/g, '\\').replace(/&#96;/g, '`').replace(/&amp;/g, '&');
const blacklist = (str, chars) => str.replace(new RegExp(`[${chars}]+`, 'g'), '');
const whitelist = (str, chars) => str.replace(new RegExp(`[^${chars}]+`, 'g'), '');
const stripLow = (str, keepNewLines) => blacklist(str, keepNewLines ? '\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F' : '\\x00-\\x1F\\x7F');
const toInt = (str, radix) => parseInt(str, radix || 10);
const toFloat = (str) => (isFloat(str) ? parseFloat(str) : NaN);
function toBoolean(str, strict) {
  if (strict) return str === '1' || /^true$/i.test(str);
  return str !== '0' && !/^false$/i.test(str) && str !== '';
}
function toDate(str) {
  const time = Date.parse(str);
  return Number.isNaN(time) ? null : new Date(time);
}

const ICLOUD = ['icloud.com', 'me.com'];
const OUTLOOK = ['hotmail.at', 'hotmail.be', 'hotmail.ca', 'hotmail.cl', 'hotmail.co.il', 'hotmail.co.nz', 'hotmail.co.th', 'hotmail.co.uk', 'hotmail.com', 'hotmail.com.ar', 'hotmail.com.au', 'hotmail.com.br', 'hotmail.com.gr', 'hotmail.com.mx', 'hotmail.com.pe', 'hotmail.com.tr', 'hotmail.com.vn', 'hotmail.cz', 'hotmail.de', 'hotmail.dk', 'hotmail.es', 'hotmail.fr', 'hotmail.hu', 'hotmail.id', 'hotmail.ie', 'hotmail.in', 'hotmail.it', 'hotmail.jp', 'hotmail.kr', 'hotmail.lv', 'hotmail.my', 'hotmail.ph', 'hotmail.pt', 'hotmail.sa', 'hotmail.sg', 'hotmail.sk', 'live.be', 'live.co.uk', 'live.com', 'live.com.ar', 'live.com.mx', 'live.de', 'live.es', 'live.eu', 'live.fr', 'live.it', 'live.nl', 'msn.com', 'outlook.at', 'outlook.be', 'outlook.cl', 'outlook.co.il', 'outlook.co.nz', 'outlook.co.th', 'outlook.com', 'outlook.com.ar', 'outlook.com.au', 'outlook.com.br', 'outlook.com.gr', 'outlook.com.pe', 'outlook.com.tr', 'outlook.com.vn', 'outlook.cz', 'outlook.de', 'outlook.dk', 'outlook.es', 'outlook.fr', 'outlook.hu', 'outlook.id', 'outlook.ie', 'outlook.in', 'outlook.it', 'outlook.jp', 'outlook.kr', 'outlook.lv', 'outlook.my', 'outlook.ph', 'outlook.pt', 'outlook.sa', 'outlook.sg', 'outlook.sk', 'passport.com'];
const YAHOO = ['rocketmail.com', 'yahoo.ca', 'yahoo.co.uk', 'yahoo.com', 'yahoo.de', 'yahoo.fr', 'yahoo.in', 'yahoo.it', 'ymail.com'];
const YANDEX = ['yandex.ru', 'yandex.ua', 'yandex.kz', 'yandex.com', 'yandex.by', 'ya.ru'];

/** L'adresse ramenée à sa forme canonique (minuscules ; points et « +sous-adresse » retirés chez Gmail…). */
function normalizeEmail(email, options) {
  const o = merge(options, { all_lowercase: true, gmail_lowercase: true, gmail_remove_dots: true, gmail_remove_subaddress: true, gmail_convert_googlemaildotcom: true, outlookdotcom_lowercase: true, outlookdotcom_remove_subaddress: true, yahoo_lowercase: true, yahoo_remove_subaddress: true, yandex_lowercase: true, yandex_convert_yandexru: true, icloud_lowercase: true, icloud_remove_subaddress: true });
  const raw = email.split('@');
  const parts = [null, raw.pop().toLowerCase()];
  parts[0] = raw.join('@');
  const lower = (flag) => {
    if (o.all_lowercase || flag) parts[0] = parts[0].toLowerCase();
  };
  if (parts[1] === 'gmail.com' || parts[1] === 'googlemail.com') {
    if (o.gmail_remove_subaddress) parts[0] = parts[0].split('+')[0];
    if (o.gmail_remove_dots) parts[0] = parts[0].replace(/\.+/g, (m) => (m.length > 1 ? m : ''));
    if (!parts[0].length) return false;
    lower(o.gmail_lowercase);
    parts[1] = o.gmail_convert_googlemaildotcom ? 'gmail.com' : parts[1];
  } else if (ICLOUD.includes(parts[1])) {
    if (o.icloud_remove_subaddress) parts[0] = parts[0].split('+')[0];
    if (!parts[0].length) return false;
    lower(o.icloud_lowercase);
  } else if (OUTLOOK.includes(parts[1])) {
    if (o.outlookdotcom_remove_subaddress) parts[0] = parts[0].split('+')[0];
    if (!parts[0].length) return false;
    lower(o.outlookdotcom_lowercase);
  } else if (YAHOO.includes(parts[1])) {
    if (o.yahoo_remove_subaddress) {
      const components = parts[0].split('-');
      parts[0] = components.length > 1 ? components.slice(0, -1).join('-') : components[0];
    }
    if (!parts[0].length) return false;
    lower(o.yahoo_lowercase);
  } else if (YANDEX.includes(parts[1])) {
    lower(o.yandex_lowercase);
    parts[1] = o.yandex_convert_yandexru ? 'yandex.ru' : parts[1];
  } else if (o.all_lowercase) {
    parts[0] = parts[0].toLowerCase();
  }
  return parts.join('@');
}

module.exports = {
  validators: { contains, equals, isBoolean, isByteLength, isEmail, isEmpty, isFQDN, isFloat, isHexadecimal, isIP, isIn, isInt, isLength, isMongoId, isNumeric, isUUID, matches },
  sanitizers: { blacklist, escape, ltrim, normalizeEmail, rtrim, stripLow, toBoolean, toDate, toFloat, toInt, trim, unescape, whitelist },
};
