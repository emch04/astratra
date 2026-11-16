/* Configurations que notify refuse : les cas qu'aucun autre test n'exerçait. */
const { createPushSender, createNotificationCatalog, createInboxHandlers } = require('../src');

test('l’envoi de notifications refuse une concurrence ou un délai qui ne sont pas des entiers positifs', () => {
  const transport = async () => ({ status: 200 });
  for (const concurrency of [0, -1, 1.5, '4', NaN]) {
    expect(() => createPushSender({ transport, concurrency })).toThrow(/concurrency must be a positive integer/);
  }
  for (const timeoutMs of [0, -10, 2.5, 'long']) {
    expect(() => createPushSender({ transport, timeoutMs })).toThrow(/timeoutMs must be a positive integer/);
  }
});

test('le catalogue refuse une entrée qui n’est pas rangée par langue', () => {
  for (const entry of ['Bonjour', null, 42]) {
    expect(() => createNotificationCatalog({ languages: ['fr'], entries: { 'commande.prete': entry } })).toThrow(/must be an object keyed by language/);
  }
});

test('les routes de la boîte de réception ne se construisent pas sans boîte', () => {
  expect(() => createInboxHandlers()).toThrow(/createNotificationInbox/);
  expect(() => createInboxHandlers({})).toThrow(/createNotificationInbox/);
});
