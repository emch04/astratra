'use strict';

// Only reads the supplied environment object. Never opens an .env file.
function readAiConfigFromEnv({ env = process.env, prefix = 'IA_' } = {}) {
  const read = (name) => env[prefix + name];
  const json = (name, fallback) => {
    if (!read(name)) return fallback;
    try { return JSON.parse(read(name)); }
    catch { throw new TypeError(`INVALID_AI_CONFIG_${name}`); }
  };
  const number = (name, fallback) => {
    if (read(name) == null || read(name) === '') return fallback;
    const value = Number(read(name));
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`INVALID_AI_CONFIG_${name}`);
    return value;
  };
  const boolean = (name, fallback) => {
    if (!read(name)) return fallback;
    if (!['true', 'false', '1', '0'].includes(read(name))) throw new TypeError(`INVALID_AI_CONFIG_${name}`);
    return ['true', '1'].includes(read(name));
  };
  const list = (name) => {
    const value = json(name, []);
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new TypeError(`INVALID_AI_CONFIG_${name}`);
    return value;
  };
  const order = (name, known) => {
    const value = json(name, undefined);
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.length || value.some((entry) => !known.includes(entry))) throw new TypeError(`INVALID_AI_CONFIG_${name}`);
    return value;
  };
  const providers = json('PROVIDERS', []);
  if (!Array.isArray(providers)) throw new TypeError('INVALID_AI_CONFIG_PROVIDERS');
  const usages = {};
  for (const usage of ['quick', 'chat', 'tools', 'pilot', 'json', 'vision']) {
    const list = json(`MODELS_${usage.toUpperCase()}`, undefined);
    if (list !== undefined) {
      if (!Array.isArray(list) || list.some((entry) => !entry?.provider || !entry.model)) throw new TypeError(`INVALID_AI_CONFIG_MODELS_${usage.toUpperCase()}`);
      usages[usage] = list;
    }
  }
  const config = {
    providers: providers.map((provider) => {
      const stem = provider.envName || provider.id?.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      if (!stem) throw new TypeError('INVALID_AI_CONFIG_PROVIDER_ID');
      // Re-read keys at every request: settings screens can replace them live.
      const keys = (ctx = {}) => readEnvironmentKeys(ctx.env || env, `${prefix}${stem}_KEY`);
      return { ...provider, url: read(`${stem}_URL`) || provider.url, local: boolean(`${stem}_LOCAL`, provider.local), keys };
    }),
    usages,
    intentRouting: json('INTENT_ROUTING', {}),
    statePrefix: read('STATE_PREFIX') || 'routing:',
    quotaMargin: json('QUOTA_MARGIN', { rpm: 0.75, rpd: 0.9, tpd: 0.85 }),
    tokenBuffer: number('TOKEN_BUFFER', 1.2),
    waitedTimeoutMs: number('WAITED_TIMEOUT_MS', 12000),
    backgroundTimeoutMs: number('BACKGROUND_TIMEOUT_MS', 45000),
    cooldownMs: number('COOLDOWN_MS', 120000),
    cooldownJitterMs: number('COOLDOWN_JITTER_MS', 0),
    degradedMs: number('DEGRADED_MS', 300000),
    maxFailures: number('MAX_FAILURES', 3),
    whenAllCooling: read('WHEN_ALL_COOLING') || 'skip',
    reserveVision: boolean('RESERVE_VISION', false),
    localModels: { baseUrl: read('MODELS_URL'), tokenFile: read('MODELS_TOKEN_FILE') },
    language: { baseUrl: read('LANGUAGE_URL'), timeoutMs: number('LANGUAGE_TIMEOUT_MS', 800) },
    // No model, voice or service order is chosen for the person: each comes
    // from the configuration. Official service addresses are only addresses.
    voice: {
      piper: { baseUrl: read('TTS_URL'), tokenFile: read('TTS_TOKEN_FILE') },
      groq: { url: read('GROQ_WHISPER_URL') || 'https://api.groq.com/openai/v1/audio/transcriptions', keys: () => readEnvironmentKeys(env, prefix + 'GROQ_KEY'), models: list('GROQ_WHISPER_MODELS') },
      cloudflare: { url: read('CLOUDFLARE_WHISPER_URL') || cloudflareRunUrl(read('CLOUDFLARE_ACCOUNT_ID')), keys: () => readEnvironmentKeys(env, prefix + 'CLOUDFLARE_KEY'), models: list('CLOUDFLARE_WHISPER_MODELS') },
      gemini: { endpoint: read('GEMINI_TTS_ENDPOINT'), keys: () => readEnvironmentKeys(env, prefix + 'GEMINI_KEY'), models: list('GEMINI_TTS_MODELS'), voice: read('GEMINI_TTS_VOICE') || undefined },
      transcriptionOrder: order('TRANSCRIPTION_ORDER', ['local', 'groq', 'cloudflare']),
      speechOrder: order('SPEECH_ORDER', ['gemini', 'piper'])
    }
  };
  config.warnings = voiceWarnings(config.voice, env, prefix);
  if (!['skip', 'try'].includes(config.whenAllCooling)) throw new TypeError('INVALID_AI_CONFIG_WHEN_ALL_COOLING');
  return config;
}

// The Workers AI run address of the account; the model is the person's.
function cloudflareRunUrl(accountId) {
  if (!accountId) return undefined;
  return (model) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

// A key without the settings it needs: said at startup, the service is skipped.
function voiceWarnings(voice, env, prefix) {
  const warnings = [];
  const hasKey = (name) => readEnvironmentKeys(env, prefix + name).length > 0;
  if (hasKey('GROQ_KEY') && !voice.groq.models.length) warnings.push(`${prefix}GROQ_KEY is set but ${prefix}GROQ_WHISPER_MODELS is empty: Groq transcription is skipped.`);
  if (hasKey('CLOUDFLARE_KEY') && voice.cloudflare.url && !voice.cloudflare.models.length) warnings.push(`${prefix}CLOUDFLARE_KEY is set but ${prefix}CLOUDFLARE_WHISPER_MODELS is empty: Cloudflare transcription is skipped.`);
  if (hasKey('GEMINI_KEY') && !voice.gemini.models.length) warnings.push(`${prefix}GEMINI_KEY is set but ${prefix}GEMINI_TTS_MODELS is empty: Gemini speech is skipped.`);
  if (hasKey('GEMINI_KEY') && !voice.gemini.voice) warnings.push(`${prefix}GEMINI_KEY is set but ${prefix}GEMINI_TTS_VOICE is empty: Gemini speech is skipped.`);
  return warnings;
}

function readEnvironmentKeys(env, name) {
  // Sparse suffixes work as well; a missing _2 must not hide _3.
  const names = Object.keys(env).filter((key) => key === name || (key.startsWith(name + '_') && /^\d+$/.test(key.slice(name.length + 1))))
    .sort((a, b) => (a === name ? 0 : Number(a.slice(name.length + 1))) - (b === name ? 0 : Number(b.slice(name.length + 1))));
  return [...new Set(names.map((key) => env[key]).filter((key) => typeof key === 'string' && key.trim()))];
}
module.exports = { readAiConfigFromEnv, readEnvironmentKeys };
