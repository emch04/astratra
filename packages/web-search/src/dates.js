/**
 * Les dates de publication, telles que les moteurs les donnent : ISO
 * (`2026-11-02T08:00:00Z`), relatives (« 3 days ago », « il y a 2 heures »),
 * ou écrites (« Sep 2, 2026 », « 2 sept. 2026 »). Rendues en ISO (UTC), ou
 * null quand on ne sait pas : une date devinée serait pire que pas de date.
 */

const MONTHS = {
  jan: 0, january: 0, janv: 0, janvier: 0,
  feb: 1, february: 1, fev: 1, fevr: 1, fevrier: 1,
  mar: 2, march: 2, mars: 2,
  apr: 3, april: 3, avr: 3, avril: 3,
  may: 4, mai: 4,
  jun: 5, june: 5, juin: 5,
  jul: 6, july: 6, juil: 6, juillet: 6,
  aug: 7, august: 7, aout: 7,
  sep: 8, sept: 8, september: 8, septembre: 8,
  oct: 9, october: 9, octobre: 9,
  nov: 10, november: 10, novembre: 10,
  dec: 11, december: 11, decembre: 11
};

const UNITS = {
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  hour: 3_600_000, hours: 3_600_000, heure: 3_600_000, heures: 3_600_000, h: 3_600_000,
  day: 86_400_000, days: 86_400_000, jour: 86_400_000, jours: 86_400_000,
  week: 604_800_000, weeks: 604_800_000, semaine: 604_800_000, semaines: 604_800_000,
  month: 2_592_000_000, months: 2_592_000_000, mois: 2_592_000_000,
  year: 31_536_000_000, years: 31_536_000_000, an: 31_536_000_000, ans: 31_536_000_000, annee: 31_536_000_000, annees: 31_536_000_000
};

const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function valid(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

/**
 * @param {unknown} value
 * @param {{ now?: number }} [options] l'horloge, pour les dates relatives.
 * @returns {string|null} une date ISO 8601 en UTC
 */
function parseDate(value, { now = Date.now() } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const text = fold(String(value).trim());
  if (!text || text.length > 80) return null;

  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    const [year, month, day] = text.slice(0, 10).split('-').map(Number);
    if (!valid(year, month - 1, day)) return null;
    /* Une heure sans fuseau est lue en UTC (ce que les moteurs envoient), jamais à l'heure de la machine. */
    const stamp = text.length === 10 ? `${text}T00:00:00Z` : text.toUpperCase().replace(' ', 'T');
    const date = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? stamp : `${stamp}Z`);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  const relative = text.match(/^(?:il y a\s+)?(\d+|an?|une?)\s+([a-z]+)\.?(?:\s+ago)?$/);
  if (relative && (text.includes('ago') || text.startsWith('il y a'))) {
    const amount = /^\d+$/.test(relative[1]) ? Number(relative[1]) : 1;
    const unit = UNITS[relative[2]];
    if (unit && amount < 10_000) return new Date(now - amount * unit).toISOString();
    return null;
  }
  if (text === 'yesterday' || text === 'hier') return new Date(now - 86_400_000).toISOString();
  if (text === 'today' || text === "aujourd'hui") return new Date(now).toISOString();

  // « Sep 2, 2026 », « September 2 2026 »
  let match = text.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match && MONTHS[match[1]] !== undefined) {
    const date = valid(Number(match[3]), MONTHS[match[1]], Number(match[2]));
    return date ? date.toISOString() : null;
  }
  // « 2 sept. 2026 », « 2 September 2026 », « 1er mars 2026 »
  match = text.match(/^(\d{1,2})(?:er)?\s+([a-z]+)\.?\s+(\d{4})$/);
  if (match && MONTHS[match[2]] !== undefined) {
    const date = valid(Number(match[3]), MONTHS[match[2]], Number(match[1]));
    return date ? date.toISOString() : null;
  }
  return null;
}

/** L'âge en jours d'une date ISO, ou null. */
function ageInDays(iso, now = Date.now()) {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? Math.max(0, (now - time) / 86_400_000) : null;
}

module.exports = { parseDate, ageInDays };
