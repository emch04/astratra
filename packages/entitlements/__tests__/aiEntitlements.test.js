const { createPlanCatalog, createAIEntitlements } = require('../src');

const catalog = createPlanCatalog({ plans: { free: ['chat'], pro: ['chat', 'vision'] } });
const modelPlans = {
  free: { groups: { small: ['tiny'], premium: ['large'] }, allowedGroups: ['small'], aliases: { default: 'tiny' }, quotas: { requestsPerMinute: 5, requestsPerDay: 20 }, budgets: { daily: 0, monthly: 0 } },
  pro: { groups: { small: ['tiny'], premium: ['large'] }, allowedGroups: ['small', 'premium'], aliases: { default: 'large' }, quotas: { requestsPerMinute: 10, tokensPerMinute: 40_000, requestsPerDay: 100 }, budgets: { daily: 10, monthly: 100 } }
};
function setup() {
  let timestamp = Date.UTC(2026, 0, 31, 23, 59);
  let plan = 'free';
  const service = createAIEntitlements({ catalog, plans: modelPlans, now: () => timestamp, resolveAccount: async () => ({ plan }) });
  return { service, setPlan: (value) => { plan = value; }, advance: (ms) => { timestamp += ms; } };
}

describe('droits IA', () => {
  test('retourne une seule fois une clé dont le store ne contient que l’empreinte', async () => {
    const { service } = setup(); const issued = await service.issueKey('compte');
    expect(issued.token).toMatch(/^ak_[0-9a-f]+_/);
    const row = await service.resolve(issued.token);
    expect(row.plan).toBe('free');
    expect(row.token).toBeUndefined();
  });
  test('les droits de la même clé suivent immédiatement la montée et la baisse de plan', async () => {
    const { service, setPlan } = setup(); const { token } = await service.issueKey('compte');
    expect((await service.resolve(token)).groups).toEqual(['small']);
    setPlan('pro'); expect((await service.resolve(token)).groups).toEqual(['small', 'premium']);
    setPlan('free'); expect((await service.resolve(token)).groups).toEqual(['small']);
  });
  test('une clé restreinte ne peut élargir groupes, alias, quotas, budgets ou fonctionnalités', async () => {
    const { service, setPlan } = setup(); setPlan('pro');
    const { token } = await service.issueKey('compte', { groups: ['small'], aliases: {}, features: ['chat'], quotas: { requestsPerMinute: 1 }, budgets: { monthly: 2 } });
    expect(await service.decide(token, 'large')).toMatchObject({ allowed: false, reason: 'model_not_allowed' });
    expect(await service.resolve(token)).toMatchObject({ groups: ['small'], aliases: {}, quotas: { requestsPerMinute: 1 }, budgets: { monthly: 2 }, features: ['chat'] });
  });
  test('refuse une clé révoquée et un secret inconnu', async () => {
    const { service } = setup(); const { id, token } = await service.issueKey('compte');
    expect((await service.resolve('secret-inconnu'))).toBeNull();
    expect(await service.revoke(id)).toBe(true);
    expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: false, reason: 'invalid_key' });
  });
  test('explique les refus de modèle, quota et budget', async () => {
    const { service } = setup(); const { token } = await service.issueKey('compte');
    expect(await service.decide(token, 'large')).toMatchObject({ allowed: false, reason: 'model_not_allowed' });
    expect(await service.decide(token, 'tiny', 1)).toMatchObject({ allowed: false, reason: 'budget' });
  });
  test('refuse le repli gratuit vers un modèle payant sans budget', async () => {
    const { service } = setup(); const { token } = await service.issueKey('compte'); const calls = [];
    const result = await service.execute(token, 'tiny', (model) => model === 'tiny' ? 0 : 1, ['large'], async (model) => { calls.push(model); if (model === 'tiny') throw new Error('indisponible'); return { cost: 1 }; });
    expect(result.allowed).toBe(false);
    expect(calls).toEqual(['tiny']);
  });
  test('revérifie les budgets à chaque cible et n’appelle jamais une cible payante hors budget', async () => {
    const { service, setPlan } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte'); const calls = [];
    const result = await service.execute(token, 'tiny', 11, ['large'], async (model) => { calls.push(model); return { cost: 1 }; });
    expect(result.allowed).toBe(false); expect(calls).toEqual([]);
  });
  test('réserve le coût estimé puis impute le coût réel au fournisseur retourné', async () => {
    const { service, setPlan } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte');
    const result = await service.execute(token, 'tiny', 5, ['large'], async () => ({ cost: 2, tokens: 12, provider: 'fournisseur-reel' }));
    expect(result).toMatchObject({ allowed: true, model: 'tiny', cost: 2, provider: 'fournisseur-reel' });
    expect(await service.decide(token, 'tiny', 8)).toMatchObject({ allowed: true });
  });
  test('les quotas par minute et par jour se remettent à zéro aux bornes UTC', async () => {
    const { service, advance } = setup(); const { token } = await service.issueKey('compte');
    for (let i = 0; i < 5; i++) await service.execute(token, 'tiny', 0, [], async () => ({ cost: 0 }));
    expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: false, reason: 'quota' });
    advance(60_000); expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: true });
    advance(60_000); advance(86_400_000); expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: true });
  });
  test('le plafond de jetons par minute prend en compte l’estimation du nouvel appel', async () => {
    const { service, setPlan } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte');
    await service.execute(token, 'tiny', 0, [], async () => ({ cost: 0, tokens: 39_999 }));
    expect(await service.decide(token, 'tiny', 0, 2)).toMatchObject({ allowed: false, reason: 'quota', quota: 'tokensPerMinute' });
  });
  test('fenêtres de budget jour et mois distinctes', async () => {
    const { service, setPlan, advance } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte');
    await service.execute(token, 'tiny', 9, [], async () => ({ cost: 9 }));
    expect(await service.decide(token, 'tiny', 2)).toMatchObject({ allowed: false, reason: 'budget' });
    advance(120_000);
    expect(await service.decide(token, 'tiny', 2)).toMatchObject({ allowed: true });
  });
});

describe('droits IA : ce qui est refusé', () => {
  test('un jeton vide, absent ou qui n’est pas du texte ne résout rien', async () => {
    const { service } = setup(); await service.issueKey('compte');
    for (const token of [undefined, null, '', 42, {}]) {
      expect(await service.resolve(token)).toBeNull();
      expect(await service.decide(token, 'tiny')).toEqual({ allowed: false, reason: 'invalid_key' });
      expect(await service.execute(token, 'tiny', 0)).toEqual({ allowed: false, reason: 'invalid_key' });
    }
  });

  test('la clé d’un compte disparu ne donne aucun droit', async () => {
    let exists = true;
    const service = createAIEntitlements({ catalog, plans: modelPlans, resolveAccount: async () => (exists ? { plan: 'pro' } : null) });
    const { token } = await service.issueKey('compte');
    exists = false;
    expect(await service.resolve(token)).toBeNull();
    expect(await service.decide(token, 'tiny')).toEqual({ allowed: false, reason: 'account_not_found' });
    const invoke = jest.fn();
    expect(await service.execute(token, 'tiny', 0, [], invoke)).toEqual({ allowed: false, reason: 'account_not_found' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('un modèle hors de tout groupe est refusé, même pour le plan le plus large', async () => {
    const { service, setPlan } = setup(); setPlan('pro');
    const { token } = await service.issueKey('compte');
    expect(await service.decide(token, 'modele-inconnu')).toMatchObject({ allowed: false, reason: 'model_not_allowed' });
  });

  test('un coût ou un nombre de jetons estimé négatif ou illisible est une erreur, pas une autorisation', async () => {
    const { service } = setup(); const { token } = await service.issueKey('compte');
    for (const cost of [-1, NaN, Infinity]) await expect(service.decide(token, 'tiny', cost)).rejects.toThrow(/coût estimé/);
    for (const tokens of [-1, NaN]) await expect(service.decide(token, 'tiny', 0, tokens)).rejects.toThrow(/jetons estimé/);
  });

  test('pas de clé sans compte, et une clé révoquée ne se révoque pas deux fois', async () => {
    const { service } = setup();
    await expect(service.issueKey(undefined)).rejects.toThrow(/compte est requis/);
    await expect(service.issueKey(null)).rejects.toThrow(/compte est requis/);
    const { id } = await service.issueKey('compte');
    expect(await service.revoke(id)).toBe(true);
    expect(await service.revoke(id)).toBe(false);
    expect(await service.revoke('inconnue')).toBe(false);
  });

  test('un appel qui échoue, sans modèle de secours, est refusé comme un échec d’appel et ne coûte rien', async () => {
    const { service, setPlan } = setup(); setPlan('pro');
    const { token } = await service.issueKey('compte');
    const error = new Error('fournisseur en panne');
    const result = await service.execute(token, 'large', 1, [], async () => { throw error; });
    expect(result).toEqual({ allowed: false, reason: 'call_failed', error });
    /* La réservation a été rendue : le budget du jour est intact. */
    expect(await service.decide(token, 'large', 10)).toMatchObject({ allowed: true });
  });

  test('un coût réel illisible renvoyé par l’appel est refusé', async () => {
    const { service, setPlan } = setup(); setPlan('pro');
    const { token } = await service.issueKey('compte');
    for (const cost of [undefined, -1, NaN]) {
      const result = await service.execute(token, 'large', 1, [], async (model) => ({ model, cost }));
      expect(result).toMatchObject({ allowed: false, reason: 'call_failed' });
    }
  });

  test('le service n’est pas construit sans catalogue de plans ni moyen de trouver le compte', () => {
    expect(() => createAIEntitlements({ resolveAccount: async () => null })).toThrow(/catalogue de plans/);
    expect(() => createAIEntitlements({ catalog })).toThrow(/resolveAccount/);
  });
});

describe('magasin mémoire des droits IA : ce qui est refusé', () => {
  const { createMemoryAIEntitlementsStore } = require('../src');
  test('deux clés de même identifiant ou de même empreinte, une réservation rejouée ou réglée deux fois', async () => {
    const store = createMemoryAIEntitlementsStore();
    await store.createKey({ id: 'k1', fingerprint: 'f1' });
    await expect(store.createKey({ id: 'k1', fingerprint: 'f2' })).rejects.toThrow(/déjà existante/);
    await expect(store.createKey({ id: 'k2', fingerprint: 'f1' })).rejects.toThrow(/déjà existante/);
    await store.reserve({ id: 'r1', keyId: 'k1', windows: ['day:2026-01-01'], amount: 1 });
    await expect(store.reserve({ id: 'r1', keyId: 'k1', windows: ['day:2026-01-01'], amount: 1 })).rejects.toThrow(/déjà existante/);
    await store.settle('r1', 1);
    await expect(store.settle('r1', 1)).rejects.toThrow(/déjà réglée/);
    await expect(store.settle('inconnue', 1)).rejects.toThrow(/inconnue/);
  });
});

describe('droits IA : la réservation tranche en dernier', () => {
  const { createMemoryAIEntitlementsStore } = require('../src');
  test('quand le magasin refuse la réservation (un autre appel a pris le budget entre-temps), rien n’est appelé', async () => {
    for (const [code, expected] of [['AI_BUDGET', { reason: 'budget' }], ['AI_QUOTA', { reason: 'quota', quota: 'requestsPerMinute' }]]) {
      const store = createMemoryAIEntitlementsStore();
      store.reserve = async () => { const error = new Error('pris'); error.code = code; if (code === 'AI_QUOTA') error.quota = 'requestsPerMinute'; throw error; };
      const service = createAIEntitlements({ catalog, plans: modelPlans, store, resolveAccount: async () => ({ plan: 'pro' }) });
      const { token } = await service.issueKey('compte');
      const invoke = jest.fn();
      expect(await service.execute(token, 'large', 1, [], invoke)).toEqual({ allowed: false, ...expected });
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  test('une autre panne du magasin pendant la réservation remonte telle quelle, sans appeler le modèle', async () => {
    const store = createMemoryAIEntitlementsStore();
    store.reserve = async () => { throw new Error('base indisponible'); };
    const service = createAIEntitlements({ catalog, plans: modelPlans, store, resolveAccount: async () => ({ plan: 'pro' }) });
    const { token } = await service.issueKey('compte');
    const invoke = jest.fn();
    await expect(service.execute(token, 'large', 1, [], invoke)).rejects.toThrow('base indisponible');
    expect(invoke).not.toHaveBeenCalled();
  });
});
