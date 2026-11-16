/* Ce que les magasins et les gardes de privacy refusent : les cas qu'aucun autre test n'exerçait. */
const {
  createMemoryDeletionStore, createMemoryErasureStore, createMemoryConsentStore,
  createConsent, createErasureWorkflow
} = require('../src');

describe('magasin des suppressions : toute écriture est conditionnelle', () => {
  const at = new Date('2026-11-16T10:00:00.000Z');

  test('mettre à jour ou supprimer un sujet inconnu ne fait rien', async () => {
    const store = createMemoryDeletionStore();
    expect(await store.update('inconnu', {}, { state: 'scheduled' })).toBe(false);
    expect(await store.remove('inconnu', {})).toBe(false);
  });

  test('une attente qui ne tient plus (course avec une connexion ou un autre balayage) n’écrit et n’efface rien', async () => {
    const store = createMemoryDeletionStore();
    await store.create({ subject: 'u1', state: 'scheduled', eraseAt: at, reminderFor: null });
    expect(await store.update('u1', { state: 'cancelled' }, { state: 'erased' })).toBe(false);
    expect(await store.update('u1', { eraseAt: new Date(at.getTime() + 1) }, { state: 'erased' })).toBe(false);
    expect(await store.remove('u1', { state: 'cancelled' })).toBe(false);
    expect((await store.get('u1')).state).toBe('scheduled');
  });

  test('une date attendue ne correspond pas à un champ vide, et un second dossier pour le même sujet est refusé', async () => {
    const store = createMemoryDeletionStore();
    expect(await store.create({ subject: 'u1', state: 'scheduled', reminderFor: null })).toBe(true);
    expect(await store.create({ subject: 'u1', state: 'scheduled' })).toBe(false);
    expect(await store.update('u1', { reminderFor: at }, { state: 'reminded' })).toBe(false);
    expect(await store.update('u1', { reminderFor: null }, { state: 'reminded' })).toBe(true);
  });

  test('un filtre de date ne retient ni un champ absent, ni une date illisible, ni la borne exclue', async () => {
    const store = createMemoryDeletionStore();
    await store.create({ subject: 'sans-date', state: 'scheduled' });
    await store.create({ subject: 'illisible', state: 'scheduled', eraseAt: 'demain' });
    await store.create({ subject: 'pile', state: 'scheduled', eraseAt: at });
    await store.create({ subject: 'avant', state: 'scheduled', eraseAt: new Date(at.getTime() - 1) });
    const due = await store.list({ eraseAt: { lt: at } });
    expect(due.map((r) => r.subject)).toEqual(['avant']);
    expect((await store.list({ eraseAt: { lt: 'pas une date' } }))).toEqual([]);
  });
});

describe('magasin des demandes d’effacement', () => {
  test('mettre à jour une demande inconnue ne rend rien', async () => {
    expect(await createMemoryErasureStore().update('inconnue', { status: 'done' })).toBeNull();
  });

  test('la liste des demandes en attente exige un magasin capable de lister', async () => {
    const store = createMemoryErasureStore();
    const workflow = createErasureWorkflow({ store: { ...store, list: undefined }, erase: async () => ({ ok: true }) });
    await expect(workflow.pending()).rejects.toThrow(/options\.store\.list/);
  });
});

describe('garde de consentement', () => {
  test('une action gardée exige de savoir de qui vient le consentement et quoi faire', () => {
    const consent = createConsent({ store: createMemoryConsentStore(), scopes: { ai: { version: 1 } } });
    expect(() => consent.guarded('ai', undefined, async () => {})).toThrow(/two functions/);
    expect(() => consent.guarded('ai', () => 'u1', 'pas une fonction')).toThrow(/two functions/);
  });

  test('sans consentement, l’action gardée n’est jamais appelée', async () => {
    const consent = createConsent({ store: createMemoryConsentStore(), scopes: { ai: { version: 1 } } });
    const action = jest.fn();
    const run = consent.guarded('ai', (subject) => subject, action);
    expect(await run('u1')).toMatchObject({ blocked: true, scope: 'ai' });
    expect(action).not.toHaveBeenCalled();
  });
});
