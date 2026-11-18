/* global structuredClone */
const { validators: V, sanitizers: S } = require('./validators');

/*
 * La validation des requêtes Express par chaînes — body('email').trim().isEmail().withMessage('…') — sans
 * express-validator : mêmes chaînes, mêmes erreurs ({ type, value, msg, path, location }), mêmes nettoyages écrits dans
 * la requête, même validationResult et même matchedData qu'express-validator 7.3 (licence MIT, Copyright (c) 2010
 * Chris O'Hara ; voir THIRD-PARTY-NOTICES.md), vérifiés sur des réponses enregistrées.
 *
 * Différences voulues :
 *   - un chemin vers « __proto__ », « constructor » ou « prototype » n'est jamais lu ni écrit (pas de pollution de
 *     prototype par un nettoyage), et seules les propriétés propres sont lues (body('toString') ne lit pas une
 *     méthode héritée) ;
 *   - une valeur JSON qui ne se convertit pas en texte ({"toString":0}, [[{"toString":1}]]) est invalide au lieu de
 *     faire planter la requête ;
 *   - withMessage avant tout validateur lève une erreur claire au lieu d'une TypeError ;
 *   - oneOf, checkSchema, checkExact et les validateurs rares (isURL, isISO8601, isCreditCard…) ne sont pas repris :
 *     appeler une méthode absente échoue au démarrage, pas à la première requête.
 */

const CONTEXTS = Symbol.for('astratra.validation.contexts');
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

class ValidationHalt extends Error {}

/**
 * Le texte d'une valeur, comme express-validator le passe aux vérifications standard. Une valeur qui ne se convertit
 * pas ({"toString":0}, [[{"toString":1}]] dans un corps JSON) donne « [object Object] » ou « [object Array] » :
 * express-validator levait une TypeError (une erreur 500 pour n'importe quel corps de ce genre).
 */
function toText(value) {
  try {
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === 'object' && value.toString) {
      if (typeof value.toString !== 'function') return Object.getPrototypeOf(value).toString.call(value);
      return String(value.toString());
    }
    if (value == null || (Number.isNaN(Number(value)) && !value.length)) return '';
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** « a.b[0]["c.d"] » en segments (comme _.toPath de lodash, pour ces formes). */
function toPath(path) {
  const segments = [];
  let current = '';
  let i = 0;
  const flush = () => {
    if (current !== '') segments.push(current);
    current = '';
  };
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      flush();
      i++;
    } else if (c === '[') {
      flush();
      const quote = path[i + 1] === '"' || path[i + 1] === "'" ? path[i + 1] : null;
      if (quote) {
        const end = path.indexOf(`${quote}]`, i + 2);
        if (end < 0) {
          current = path.slice(i);
          break;
        }
        segments.push(path.slice(i + 2, end));
        i = end + 2;
      } else {
        const end = path.indexOf(']', i + 1);
        if (end < 0) {
          current = path.slice(i);
          break;
        }
        segments.push(path.slice(i + 1, end));
        i = end + 1;
      }
    } else {
      current += c;
      i++;
    }
  }
  flush();
  return segments;
}

/** Le chemin affiché d'une suite de segments : « a.b[0] », « ["c.d"] ». */
function reconstructFieldPath(segments) {
  return segments.reduce((prev, segment) => {
    const s = segment === '\\*' ? '*' : segment;
    if (s.includes('.')) return `${prev}["${s}"]`;
    if (/^\d+$/.test(s)) return `${prev}[${s}]`;
    return prev ? `${prev}.${s}` : s;
  }, '');
}

const isObjectLike = (value) => value !== null && typeof value === 'object';

function getPath(object, path) {
  if (path === '') return object;
  let current = object;
  for (const segment of toPath(path)) {
    if (FORBIDDEN.has(segment) || (!isObjectLike(current) && typeof current !== 'function') || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Écrit une valeur à un chemin, en créant les objets et tableaux manquants (comme _.set) ; jamais sur un prototype. */
function setPath(object, path, value) {
  const parsed = toPath(path);
  const segments = parsed.length ? parsed : [''];
  if (!isObjectLike(object) || segments.some((s) => FORBIDDEN.has(s))) return;
  let current = object;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!isObjectLike(current[segment]) || !Object.hasOwn(current, segment)) current[segment] = /^\d+$/.test(segments[i + 1]) ? [] : {};
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

function expandPath(object, path, currPath, currValues = []) {
  const segments = typeof path === 'string' ? toPath(path) : path;
  if (!segments.length) return [{ path: reconstructFieldPath(currPath), values: currValues }];
  const [key, ...rest] = segments;
  if (object != null && !isObjectLike(object)) {
    if (key === '**') return rest.length ? [] : [{ path: reconstructFieldPath(currPath), values: currValues }];
    if (key === '*') return [];
    return [{ path: reconstructFieldPath([...currPath, ...segments]), values: currValues }];
  }
  const obj = object || {};
  const ownKeys = Object.keys(obj).filter((k) => !FORBIDDEN.has(k));
  if (key === '*') return ownKeys.flatMap((k) => expandPath(obj[k], rest, currPath.concat(k), currValues.concat(k)));
  if (key === '**') {
    return ownKeys.flatMap((k) => {
      const nextPath = currPath.concat(k);
      const selected = expandPath(obj[k], segments, nextPath, [k]).concat(rest[0] === k ? expandPath(obj[k], rest.slice(1), nextPath, []) : []);
      const seen = new Set();
      return selected
        .filter(({ path: p }) => !seen.has(p) && seen.add(p))
        .map(({ path: p, values }) => ({ path: p, values: values.length ? [...currValues, values.flat()] : currValues }));
    });
  }
  return expandPath(FORBIDDEN.has(key) || !Object.hasOwn(obj, key) ? undefined : obj[key], rest, currPath.concat(key), currValues);
}

function selectFields(req, fields, locations) {
  const out = [];
  const seen = new Set();
  for (const field of fields) {
    for (const location of locations) {
      const pathToExpand = location === 'headers' ? field.toLowerCase() : field;
      for (const { path, values } of expandPath(req[location], pathToExpand, [])) {
        const id = `${location}:${path}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ location, path, originalPath: field, pathValues: values, value: path === '' ? req[location] : getPath(req[location], path) });
      }
    }
  }
  return out;
}

class Context {
  constructor({ fields, locations, stack, optional, bail, visibility, message }) {
    Object.assign(this, { fields, locations, stack, optional, bail, visibility, message });
    this.errors = [];
    this.dataMap = new Map();
  }

  getData({ requiredOnly = false } = {}) {
    const { optional } = this;
    const checks = requiredOnly && optional ? [(v) => v !== undefined, (v) => (optional === 'null' ? v != null : true), (v) => (optional === 'falsy' ? v : true)] : [];
    const groups = new Map();
    for (const instance of this.dataMap.values()) {
      if (!groups.has(instance.originalPath)) groups.set(instance.originalPath, []);
      groups.get(instance.originalPath).push(instance);
    }
    const out = [];
    for (const [group, instances] of groups) {
      const locationCount = new Set(instances.map((i) => i.location)).size;
      if (instances.length > 1 && locationCount > 1 && !group.includes('*')) {
        const withValue = instances.filter((i) => i.value !== undefined);
        out.push(...(withValue.length ? withValue : [instances[0]]));
      } else out.push(...instances);
    }
    return out.filter((instance) => checks.every((check) => check(instance.value)));
  }

  addFieldInstances(instances) {
    for (const instance of instances) this.dataMap.set(`${instance.location}:${instance.path}`, { ...instance });
  }

  setData(path, value, location) {
    const instance = this.dataMap.get(`${location}:${path}`);
    if (!instance) throw new Error('Attempt to write data that did not pre-exist in context');
    instance.value = value;
  }

  addError({ message, value, meta }) {
    const msg = message || this.message || 'Invalid value';
    let error = { type: 'field', value, msg: typeof msg === 'function' ? msg(value, meta) : msg, path: meta?.path, location: meta?.location };
    if (this.visibility.type === 'hidden') {
      error = { ...error };
      delete error.value;
    } else if (this.visibility.type === 'redacted') error = { ...error, value: this.visibility.value };
    this.errors.push(error);
  }
}

/* Les éléments d'une chaîne, comme dans express-validator. */
const standardValidation = (validator, negated, options) => ({
  kind: 'validator',
  async run(context, value, meta) {
    for (const item of Array.isArray(value) ? value : [value]) {
      const result = validator(toText(item), ...options);
      if (negated ? result : !result) context.addError({ message: this.message, value: item, meta });
    }
  },
});

const customValidation = (validator, negated) => ({
  kind: 'validator',
  async run(context, value, meta) {
    try {
      const result = validator(value, meta);
      const actual = await result;
      const isPromise = result?.then;
      const failed = negated ? actual : !actual;
      if ((!isPromise && failed) || (isPromise && negated)) context.addError({ message: this.message, value, meta });
    } catch (err) {
      if (negated) return;
      context.addError({ message: this.message || (err instanceof Error ? err.message : err), value, meta });
    }
  },
});

const sanitization = (sanitizer, custom, options = []) => ({
  async run(context, value, meta) {
    const { path, location } = meta;
    if (custom) {
      context.setData(path, await Promise.resolve(sanitizer(value, meta)), location);
      return;
    }
    const values = Array.isArray(value) ? value : [value];
    const next = values.map((v) => sanitizer(toText(v), ...options));
    context.setData(path, values !== value ? next[0] : next, location);
  },
});

const bailItem = () => ({
  async run(context) {
    if (context.errors.length > 0) throw new ValidationHalt();
  },
});

const customCondition = (condition) => ({
  async run(_context, value, meta) {
    try {
      const result = condition(value, meta);
      await result;
      if (!result) throw new Error();
    } catch {
      throw new ValidationHalt();
    }
  },
});

const chainCondition = (chain) => ({
  async run(_context, _value, meta) {
    const result = await chain.run(meta.req, { dryRun: true });
    if (!result.isEmpty()) throw new ValidationHalt();
  },
});

class Result {
  constructor(formatter, errors) {
    this.formatter = formatter;
    this.errors = errors;
  }

  array(options) {
    return options?.onlyFirstError ? Object.values(this.mapped()) : this.errors.map(this.formatter);
  }

  mapped() {
    return this.errors.reduce((mapping, error) => {
      const key = error.type === 'field' ? error.path : `_${error.type}`;
      if (!Object.hasOwn(mapping, key)) mapping[key] = this.formatter(error);
      return mapping;
    }, {});
  }

  formatWith(formatter) {
    return new Result(formatter, this.errors);
  }

  isEmpty() {
    return this.errors.length === 0;
  }

  throw() {
    if (!this.isEmpty()) {
      const error = new Error();
      for (const key of ['array', 'mapped', 'formatWith', 'isEmpty', 'throw']) error[key] = this[key].bind(this);
      Object.assign(error, { formatter: this.formatter, errors: this.errors });
      throw error;
    }
  }
}

/** Lance une chaîne sur une requête : nettoie la requête (sauf dryRun) et rend ses erreurs. */
async function runChain(builder, req, options = {}) {
  const context = new Context(builder.build());
  if (req[CONTEXTS]?.some((c) => c.bail && c.errors.length > 0)) return Object.assign(new Result((e) => e, context.errors), { context });
  context.addFieldInstances(selectFields(req, context.fields, context.locations));
  const halted = new Set();
  for (const item of context.stack) {
    await Promise.all(context.getData({ requiredOnly: true }).map(async (instance) => {
      const { location, path } = instance;
      const id = `${location}:${path}`;
      if (halted.has(id)) return;
      try {
        await item.run(context, instance.value, { req, location, path, pathValues: instance.pathValues });
        const current = path !== '' ? getPath(req[location], path) : req[location];
        if (!options.dryRun && current !== instance.value) {
          if (path !== '') setPath(req[location], path, instance.value);
          else req[location] = instance.value;
        }
      } catch (error) {
        if (error instanceof ValidationHalt) {
          halted.add(id);
          return;
        }
        throw error;
      }
    }));
  }
  if (!options.dryRun) {
    Object.defineProperty(req, CONTEXTS, { value: (req[CONTEXTS] || []).concat(context), configurable: true, writable: true, enumerable: false });
  }
  return Object.assign(new Result((e) => e, context.errors), { context });
}

const STANDARD = {
  contains: V.contains,
  equals: V.equals,
  isByteLength: V.isByteLength,
  isEmail: V.isEmail,
  isEmpty: V.isEmpty,
  isFQDN: V.isFQDN,
  isFloat: V.isFloat,
  isHexadecimal: V.isHexadecimal,
  isIP: V.isIP,
  isIn: V.isIn,
  isInt: V.isInt,
  isLength: V.isLength,
  isMongoId: V.isMongoId,
  isNumeric: V.isNumeric,
  isUUID: V.isUUID,
  matches: V.matches,
};
const STANDARD_SANITIZERS = ['blacklist', 'escape', 'unescape', 'ltrim', 'rtrim', 'trim', 'normalizeEmail', 'stripLow', 'toBoolean', 'toDate', 'toFloat', 'toInt', 'whitelist'];

/** Une chaîne : un middleware Express, avec ses méthodes de validation et de nettoyage. */
function createChain(fields, locations, message) {
  const builder = { stack: [], fields, locations, optional: false, bail: false, visibility: { type: 'visible' }, message };
  builder.build = () => ({ fields: builder.fields, locations: builder.locations, stack: builder.stack, optional: builder.optional, bail: builder.bail, visibility: builder.visibility, message: builder.message });
  let negateNext = false;
  let lastValidator = null;

  const chain = async (req, _res, next) => {
    try {
      await chain.run(req);
      next();
    } catch (error) {
      next(error);
    }
  };
  const addValidator = (item) => {
    builder.stack.push(item);
    lastValidator = item;
    negateNext = false;
    return chain;
  };
  const addSanitizer = (item) => {
    builder.stack.push(item);
    return chain;
  };
  const custom = (validator) => {
    if (typeof validator !== 'function') throw new TypeError('custom() needs a function');
    return addValidator(customValidation(validator, negateNext));
  };

  Object.assign(chain, {
    builder,
    run: (req, options) => runChain(builder, req, options),
    not() {
      negateNext = true;
      return chain;
    },
    withMessage(msg) {
      if (!lastValidator) throw new Error('withMessage() must follow a validator (or pass the message to body(field, message))');
      lastValidator.message = msg;
      return chain;
    },
    custom,
    exists(options = {}) {
      if (options.checkFalsy || options.values === 'falsy') return custom((v) => !!v);
      if (options.checkNull || options.values === 'null') return custom((v) => v != null);
      return custom((v) => v !== undefined);
    },
    isArray(options = {}) {
      return custom((v) => Array.isArray(v) && (typeof options.min === 'undefined' || v.length >= options.min) && (typeof options.max === 'undefined' || v.length <= options.max));
    },
    isObject(options = { strict: true }) {
      return custom((v) => typeof v === 'object' && (options.strict == null || options.strict ? v !== null && !Array.isArray(v) : true));
    },
    isString() {
      return custom((v) => typeof v === 'string');
    },
    isBoolean(options) {
      if (options?.strict) return custom((v) => v === true || v === false);
      return addValidator(standardValidation(V.isBoolean, negateNext, options === undefined ? [] : [options]));
    },
    notEmpty(options) {
      negateNext = true;
      return chain.isEmpty(options);
    },
    bail(options) {
      if (options?.level === 'request') builder.bail = true;
      builder.stack.push(bailItem());
      return chain;
    },
    if(condition) {
      if (condition && typeof condition.run === 'function') builder.stack.push(chainCondition(condition));
      else if (typeof condition === 'function') builder.stack.push(customCondition(condition));
      else throw new Error('condition is not a validation chain nor a function');
      return chain;
    },
    optional(options = true) {
      if (typeof options === 'boolean') builder.optional = options ? 'undefined' : false;
      else builder.optional = options.values ? options.values : options.checkFalsy ? 'falsy' : options.nullable ? 'null' : 'undefined';
      return chain;
    },
    hide(hiddenValue) {
      builder.visibility = hiddenValue !== undefined ? { type: 'redacted', value: hiddenValue } : { type: 'hidden' };
      return chain;
    },
    customSanitizer(sanitizer) {
      if (typeof sanitizer !== 'function') throw new TypeError('customSanitizer() needs a function');
      return addSanitizer(sanitization(sanitizer, true));
    },
    default(defaultValue) {
      return chain.customSanitizer((v) => ([undefined, null, ''].includes(v) || Number.isNaN(v) ? structuredClone(defaultValue) : v));
    },
    replace(valuesToReplace, newValue) {
      const list = Array.isArray(valuesToReplace) ? valuesToReplace : [valuesToReplace];
      return chain.customSanitizer((v) => (list.includes(v) ? structuredClone(newValue) : v));
    },
    toArray() {
      return chain.customSanitizer((v) => (v !== undefined && ((Array.isArray(v) && v) || [v])) || []);
    },
    toLowerCase() {
      return chain.customSanitizer((v) => (typeof v === 'string' ? v.toLowerCase() : v));
    },
    toUpperCase() {
      return chain.customSanitizer((v) => (typeof v === 'string' ? v.toUpperCase() : v));
    },
  });
  for (const [name, fn] of Object.entries(STANDARD)) {
    chain[name] = (...options) => addValidator(standardValidation(fn, negateNext, options));
  }
  for (const name of STANDARD_SANITIZERS) {
    chain[name] = (...options) => addSanitizer(sanitization(S[name], false, options));
  }
  return chain;
}

const fieldsOf = (fields) => (fields === undefined ? [''] : Array.isArray(fields) ? fields : [fields]).map((f) => {
  if (typeof f !== 'string') throw new TypeError('a field must be a string');
  return f;
});
const forLocations = (locations) => (fields, message) => createChain(fieldsOf(fields), locations, message);

const body = forLocations(['body']);
const cookie = forLocations(['cookies']);
const header = forLocations(['headers']);
const param = forLocations(['params']);
const query = forLocations(['query']);
const check = forLocations(['body', 'cookies', 'headers', 'params', 'query']);

function withDefaults(options = {}) {
  const formatter = options.formatter || ((error) => error);
  return (req) => new Result(formatter, (req[CONTEXTS] || []).flatMap((context) => context.errors));
}
/** Les erreurs de toutes les chaînes déjà lancées sur cette requête. */
const validationResult = Object.assign(withDefaults(), { withDefaults });

/** Les données validées (ou nettoyées) de la requête, en un objet. */
function matchedData(req, options = {}) {
  const removeOptionals = options.includeOptionals !== true;
  const onlyValid = options.onlyValidData !== false;
  const locations = options.locations || [];
  const out = {};
  for (const context of req[CONTEXTS] || []) {
    for (const instance of context.getData({ requiredOnly: removeOptionals })) {
      if (onlyValid && context.errors.some((e) => e.type === 'field' && e.location === instance.location && e.path === instance.path)) continue;
      if (locations.length && !locations.includes(instance.location)) continue;
      setPath(out, instance.path, instance.value);
    }
  }
  return out;
}

module.exports = { body, cookie, header, param, query, check, validationResult, matchedData, Result };
