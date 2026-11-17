'use strict';
const { createLocalModelsClient, validPcmAudio } = require('./localModels');
const { createTokenFileReader, serviceRequest, endpoint, AiServiceError } = require('./serviceHttp');
const { plainText } = require('./answerText');

const WHISPER_STOCK_PHRASES = Object.freeze(['sous-titr', 'amara.org', "merci d'avoir regard", 'merci d’avoir regard', 'abonnez-vous', 'thank for watching', 'thanks for watching', 'subtitle by', 'subtitles by', 'please subscribe']);

function pcmToWav(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const bytes = Buffer.from(pcm);
  if (!bytes.length || bytes.length % (channels * 2) || !Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels < 1 || channels > 2) throw new AiServiceError('AI_AUDIO_INPUT');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + bytes.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

function readPcmWav(audio) {
  const bytes = Buffer.from(audio);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 > bytes.length) throw new AiServiceError('AI_AUDIO_RESPONSE');
  let format;
  let pcm;
  for (let at = 12; at + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > bytes.length) throw new AiServiceError('AI_AUDIO_RESPONSE');
    if (name === 'fmt ' && size >= 16) format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (name === 'data') pcm = bytes.subarray(start, start + size);
    at = start + size + size % 2;
  }
  if (!format || format.encoding !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || !format.sampleRate || !pcm?.length || pcm.length % (format.channels * 2)) throw new AiServiceError('AI_AUDIO_RESPONSE');
  return { pcm, sampleRate: format.sampleRate, channels: format.channels };
}

function speakableText(text, maxChars = 6000) {
  return plainText(String(text ?? '')).replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function doubtfulTranscription(text, { stockPhrases = WHISPER_STOCK_PHRASES } = {}) {
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/\p{L}+/gu) || [];
  if (stockPhrases.some((phrase) => lower.includes(phrase))) return true;
  if (words.length >= 6 && new Set(words).size <= 2) return true;
  return false;
}

async function readKeys(config = {}) {
  const source = typeof config.keys === 'function' ? await config.keys() : config.keys;
  return [...new Set((Array.isArray(source) ? source : [source]).filter((key) => typeof key === 'string' && key.trim()))];
}

const modelsOf = (config = {}) => (Array.isArray(config.models) ? config.models.filter((model) => typeof model === 'string' && model.trim()) : []);

/* No model, voice or service order is chosen here: everything comes from the
   caller's configuration. */
function rotatingPool(config = {}, now) {
  const rests = new Map();
  let next = 0;
  return {
    async candidates() {
      const keys = await readKeys(config);
      const start = keys.length ? next++ % keys.length : 0;
      const list = [];
      for (const model of modelsOf(config)) for (let offset = 0; offset < keys.length; offset += 1) {
        const slot = (start + offset) % keys.length;
        const id = `${model}:key-${slot + 1}`;
        if ((rests.get(id) || 0) <= now()) list.push({ model, key: keys[slot], id });
      }
      return list;
    },
    rest(id) { rests.set(id, now() + (config.cooldownMs ?? 120000)); }
  };
}

/* Each enabled service (address, key) that lacks a setting is reported once
   through onWarning and skipped; the others keep working. */
function createWarner(onWarning) {
  const said = new Set();
  return (problem) => {
    if (said.has(problem.message) || typeof onWarning !== 'function') return;
    said.add(problem.message);
    try { onWarning(problem.message, problem); } catch { /* A warning must not break a call. */ }
  };
}

function checkOrder(order, known, name) {
  if (order === undefined || order === null) return null;
  if (!Array.isArray(order) || order.some((service) => !known.includes(service))) throw new TypeError(`INVALID_AI_VOICE_${name}`);
  return order;
}

/* The chain is the caller's order, kept to the usable services. Without an
   order, a single usable service is used alone; several need an order. A
   result is a fallback when its service is not first in the caller's order. */
function chainOf(order, usable, code, setting) {
  if (order) return order.filter((service) => usable.includes(service));
  if (usable.length <= 1) return usable;
  const error = new AiServiceError(code);
  error.missing = [setting];
  error.services = usable;
  throw error;
}

function unavailable(code, problems) {
  const error = new AiServiceError(code);
  error.missing = [...new Set(problems.flatMap((problem) => problem.missing))];
  return error;
}

function createTranscriptionService(options = {}) {
  const local = options.local || createLocalModelsClient({ fetch: options.fetch, ...(options.localModels || {}) });
  const now = options.now || Date.now;
  const groq = options.groq || {};
  const cloudflare = options.cloudflare || {};
  const groqPool = rotatingPool(groq, now);
  const cloudPool = rotatingPool(cloudflare, now);
  const fetchImpl = options.fetch || globalThis.fetch;
  const order = checkOrder(options.transcriptionOrder, ['local', 'groq', 'cloudflare'], 'TRANSCRIPTION_ORDER');
  const warn = createWarner(options.onWarning);
  const localEnabled = Boolean(options.local || options.localModels?.baseUrl);
  async function services(allowRemote) {
    const usable = localEnabled ? ['local'] : [];
    const problems = [];
    if (allowRemote) {
      for (const [name, config, label, setting] of [['groq', groq, 'Groq', 'IA_GROQ_WHISPER_MODELS'], ['cloudflare', cloudflare, 'Cloudflare', 'IA_CLOUDFLARE_WHISPER_MODELS']]) {
        if (!config.url || !(await readKeys(config)).length) continue;
        if (modelsOf(config).length) { usable.push(name); continue; }
        problems.push({ service: name, missing: [setting], message: `${label} transcription has a key but no model: set ${name}.models (${setting}). ${label} is skipped.` });
      }
    }
    problems.forEach(warn);
    return { usable, problems };
  }
  async function transcribe({ audio, format = 'pcm16', language = 'fr', vocabulary = '', filename = 'audio.wav', mimeType = 'audio/wav', signal, allowRemote = true } = {}) {
    const bytes = typeof audio === 'string' ? Buffer.from(audio, 'base64') : Buffer.from(audio || []);
    if (!bytes.length || bytes.length > (options.maxAudioBytes ?? 25000000)) throw new AiServiceError('AI_AUDIO_INPUT');
    let pcm;
    let file = bytes;
    if (format === 'pcm16') {
      if (!validPcmAudio(bytes.toString('base64'))) throw new AiServiceError('AI_AUDIO_INPUT');
      pcm = bytes;
      file = pcmToWav(pcm);
      filename = 'audio.wav'; mimeType = 'audio/wav';
    } else if (format === 'wav') {
      const wave = readPcmWav(bytes);
      if (wave.sampleRate === 16000 && wave.channels === 1 && validPcmAudio(wave.pcm.toString('base64'))) pcm = wave.pcm;
    } else if (format !== 'file') throw new AiServiceError('AI_AUDIO_INPUT');
    if (signal?.aborted) throw signal.reason;
    const { usable, problems } = await services(allowRemote);
    const chain = chainOf(order, usable, 'AI_TRANSCRIPTION_ORDER_REQUIRED', 'transcriptionOrder (IA_TRANSCRIPTION_ORDER)');
    for (const [rank, service] of chain.entries()) {
      if (signal?.aborted) throw signal.reason;
      const result = service === 'local' ? await viaLocal(pcm, language, vocabulary, signal)
        : service === 'groq' ? await viaGroq(file, filename, mimeType, language, vocabulary, signal)
          : await viaCloudflare(file, signal);
      if (result) return { ...result, fallback: (order ? order.indexOf(service) : rank) > 0 };
    }
    throw unavailable('AI_TRANSCRIPTION_UNAVAILABLE', problems);
  }
  async function viaLocal(pcm, language, vocabulary, signal) {
    if (!pcm) return null;
    const result = await local.transcrire(pcm.toString('base64'), { langue: language, vocabulaire: vocabulary, timeoutMs: options.localTimeoutMs ?? 15000, signal });
    if (!result) return null;
    // Genuine silence is an answer, not an outage to send to another model.
    const silence = result.sansParole > (options.noSpeechThreshold ?? 0.6);
    const doubtful = result.logprob < (options.logprobThreshold ?? -1) || doubtfulTranscription(result.texte, options);
    if (silence || !doubtful) return { text: silence ? '' : result.texte, language: result.langue, provider: 'local', model: result.modele ?? null, confidence: Math.exp(Math.min(0, result.logprob)), noSpeech: silence };
    return null;
  }
  async function viaGroq(file, filename, mimeType, language, vocabulary, signal) {
    for (const candidate of await groqPool.candidates()) {
      try {
        const form = new globalThis.FormData();
        form.set('file', new globalThis.Blob([file], { type: mimeType }), filename);
        form.set('model', candidate.model); form.set('response_format', 'verbose_json');
        if (language) form.set('language', language);
        if (vocabulary) form.set('prompt', vocabulary);
        const data = await serviceRequest(groq.url, { fetch: fetchImpl, timeoutMs: groq.timeoutMs ?? 30000, signal, rawBody: form, headers: { Authorization: `Bearer ${candidate.key}` } });
        if (typeof data?.text !== 'string' || doubtfulTranscription(data.text, options)) throw new AiServiceError('AI_SERVICE_RESPONSE');
        return { text: data.text, language: data.language || null, provider: 'groq', model: candidate.model };
      } catch (_error) { if (signal?.aborted) throw signal.reason; groqPool.rest(candidate.id); }
    }
    return null;
  }
  async function viaCloudflare(file, signal) {
    for (const candidate of await cloudPool.candidates()) {
      try {
        const data = await serviceRequest(typeof cloudflare.url === 'function' ? cloudflare.url(candidate.model) : cloudflare.url, { fetch: fetchImpl, timeoutMs: cloudflare.timeoutMs ?? 30000, signal, body: { audio: file.toString('base64') }, headers: { Authorization: `Bearer ${candidate.key}` } });
        if (data?.success === false || typeof data?.result?.text !== 'string' || doubtfulTranscription(data.result.text, options)) throw new AiServiceError('AI_SERVICE_RESPONSE');
        return { text: data.result.text, language: data.result.language || null, provider: 'cloudflare', model: candidate.model };
      } catch (_error) { if (signal?.aborted) throw signal.reason; cloudPool.rest(candidate.id); }
    }
    return null;
  }
  return { transcribe };
}

function createSpeechService(options = {}) {
  const piper = options.piper || {};
  const gemini = options.gemini || {};
  const now = options.now || Date.now;
  const token = createTokenFileReader({ tokenFile: piper.tokenFile, read: piper.readTokenFile, now });
  const pool = rotatingPool(gemini, now);
  const fetchImpl = options.fetch || globalThis.fetch;
  const piperRests = new Map();
  /* No order is chosen here: `speechOrder` (or `order`) is the caller's. */
  const order = checkOrder(options.speechOrder ?? options.order, ['gemini', 'piper'], 'SPEECH_ORDER');
  const warn = createWarner(options.onWarning);
  async function services(allowRemote) {
    const usable = piper.baseUrl ? ['piper'] : [];
    const problems = [];
    if (allowRemote && (await readKeys(gemini)).length) {
      const missing = [];
      if (!modelsOf(gemini).length) missing.push(['gemini.models', 'IA_GEMINI_TTS_MODELS']);
      if (!(typeof gemini.voice === 'string' && gemini.voice.trim())) missing.push(['gemini.voice', 'IA_GEMINI_TTS_VOICE']);
      if (missing.length) {
        problems.push({ service: 'gemini', missing: missing.map(([, env]) => env), message: `Gemini speech has a key but no ${missing.map(([option, env]) => `${option.split('.')[1]} (${option}, ${env})`).join(' and no ')}. Gemini is skipped.` });
      } else usable.unshift('gemini');
    }
    problems.forEach(warn);
    return { usable, problems };
  }
  async function viaPiper(clean, language, signal) {
    if (!piper.baseUrl || (piperRests.get(language) || 0) > now()) return null;
    try {
      const key = await token();
      const audio = await serviceRequest(endpoint(piper.baseUrl, '/tts'), { fetch: fetchImpl, body: { text: clean, lang: language }, signal, timeoutMs: piper.timeoutMs ?? 30000, read: 'bytes', headers: key ? { Authorization: `Bearer ${key}` } : {} });
      const wave = readPcmWav(audio);
      return { audio, format: 'wav', mimeType: 'audio/wav', sampleRate: wave.sampleRate, channels: wave.channels, provider: 'piper', model: null };
    } catch (_error) { if (signal?.aborted) throw signal.reason; piperRests.set(language, now() + (piper.cooldownMs ?? 60000)); return null; }
  }
  async function viaGemini(clean, signal) {
    for (const candidate of await pool.candidates()) {
      try {
        const data = await serviceRequest(endpoint(gemini.endpoint || 'https://generativelanguage.googleapis.com/v1beta/models', `/${candidate.model}:generateContent`), {
          fetch: fetchImpl, signal, timeoutMs: gemini.timeoutMs ?? 45000, headers: { 'x-goog-api-key': candidate.key },
          body: { contents: [{ role: 'user', parts: [{ text: clean }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: gemini.voice } } } } }
        });
        const part = data?.candidates?.[0]?.content?.parts?.find((one) => one.inlineData || one.inline_data);
        const inline = part?.inlineData || part?.inline_data;
        if (typeof inline?.data !== 'string' || !inline.data || inline.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(inline.data)) throw new AiServiceError('AI_AUDIO_RESPONSE');
        const mime = inline.mimeType || inline.mime_type || '';
        const pcm = Buffer.from(inline.data, 'base64');
        if (!/^audio\/(?:L16|pcm)(?:;|$)/i.test(mime) || !pcm.length || pcm.length % 2) throw new AiServiceError('AI_AUDIO_RESPONSE');
        const sampleRate = Number(/rate=(\d+)/.exec(mime)?.[1] || 24000);
        return { audio: pcmToWav(pcm, { sampleRate }), format: 'wav', mimeType: 'audio/wav', sampleRate, channels: 1, provider: 'gemini', model: candidate.model };
      } catch (_error) { if (signal?.aborted) throw signal.reason; pool.rest(candidate.id); }
    }
    return null;
  }
  async function synthesize({ text, language = 'fr', signal, allowRemote = true } = {}) {
    const clean = (options.prepareText || speakableText)(text);
    if (!clean) throw new AiServiceError('AI_SPEECH_INPUT');
    if (signal?.aborted) throw signal.reason;
    const { usable, problems } = await services(allowRemote);
    const chain = chainOf(order, usable, 'AI_SPEECH_ORDER_REQUIRED', 'speechOrder (IA_SPEECH_ORDER)');
    for (const [rank, service] of chain.entries()) {
      if (signal?.aborted) throw signal.reason;
      const result = service === 'piper' ? await viaPiper(clean, language, signal) : await viaGemini(clean, signal);
      if (result) return { ...result, fallback: (order ? order.indexOf(service) : rank) > 0 };
    }
    throw unavailable('AI_SPEECH_UNAVAILABLE', problems);
  }
  return { synthesize };
}

module.exports = { createTranscriptionService, createSpeechService, pcmToWav, readPcmWav, speakableText, doubtfulTranscription, WHISPER_STOCK_PHRASES };
