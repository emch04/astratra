# Compte rendu — @astratra/credentials 1.1.0

Les huit ajouts demandés sont implémentés, documentés et testés localement.
Aucune publication, aucun push, aucun changement dans les applications ou dans
l'autre worktree. Les seuls éléments bloqués sont le commit local (permissions
Git du bac à sable) et le lint global (trois erreurs préexistantes hors du paquet).

## API ajoutée

Les types complets sont dans `src/index.d.ts`, les exemples dans `README.md`.

```ts
interface CredentialScope { tenant: string; environment: string }
interface CredentialContext {
  tenant: string | null; environment: string | null; name: string; version: number;
}
interface VersionMetadata {
  key: string; tenant?: string; environment?: string; version?: number;
  updatedAt: Date | string | null; updatedBy: string | null;
  retiredAt: Date | string | null; expiresAt: Date | string | null; purged: boolean;
}
interface WriteEvent extends VersionMetadata { action: 'set' | 'disconnect' }

// Options supplémentaires de createCredentialVault :
// strict?: boolean (false), fallback?: 'env' | 'none' ('env'), scope?: CredentialScope,
// history?: boolean (false), retentionMs?: number (30 jours),
// onWrite?: (event: WriteEvent) => void | Promise<void>.
// cacheMs existait déjà : 60000 par défaut, 0 pour relire à chaque appel.
vault.get(key: string, options?: { version?: number }): Promise<string | null>;
vault.listVersions(key: string): Promise<VersionMetadata[]>;
vault.purgeVersions(): Promise<number>;
vault.scope: Readonly<CredentialScope> | null;

createContextCipher(options: { key: Buffer }): FieldCipher;
// Contexte obligatoire à l'exécution pour ce chiffreur ; facultatif dans FieldCipher
// afin de garder les anciens chiffreurs à un argument compatibles.
cipher.encrypt(plaintext: string, context?: CredentialContext): string;
cipher.decrypt(payload: string, context?: CredentialContext): string;

createMemoryVersionedCredentialStore(): VersionedCredentialStore;
createMongoVersionedCredentialStore(options: {
  collection: unknown; isReady?: () => boolean; maxTimeMS?: number;
}): VersionedCredentialStore;
// Contrat atomique du store versionné :
store.appendVersion(key: string, scope: CredentialScope | undefined,
  build: (version: number) => CredentialRow, retentionMs: number): Promise<CredentialRow>;
store.findVersion(key: string, version: number, scope?: CredentialScope): Promise<CredentialRow | null>;
store.listVersions(key: string, scope?: CredentialScope): Promise<VersionMetadata[]>;
store.purgeVersions(at: Date, scope?: CredentialScope): Promise<number>;
// Stores classiques : supportsScopes?: boolean ;
// findAll(scope?: CredentialScope, options?: { strict?: boolean }) ;
// upsert(row), avec tenant/environment dans row.
// createCredentialRotation accepte désormais scope?: CredentialScope.

createReadChallenge(options: {
  store: ReadChallengeStore;
  verify: (input: { challenge: ReadChallengeRecord; proof: unknown }) => boolean | Promise<boolean>;
  ttlMs?: number; now?: () => number;
}): ReadChallenge;
challenge.request(subjectId: string | number, target: {
  key: string; version?: number; scope?: CredentialScope;
}): Promise<ReadChallengeRecord>;
challenge.read(subjectId: string | number, id: string, proof: unknown,
  vault: CredentialVault): Promise<string | null>;
createMemoryReadChallengeStore(): ReadChallengeStore;
createMongoReadChallengeStore(options: { collection: unknown }): ReadChallengeStore;
// consume(id, subjectId) doit être atomique et définitif avant vérification.

createKeyProbe<TTransport extends (...args: any[]) => any>(options: {
  vault: Pick<CredentialVault, 'get'>;
  probes: Record<string, (value: string, context: {
    transport: TTransport; signal: AbortSignal;
  }) => KeyProbeStatus | Promise<KeyProbeStatus>>;
  transport: TTransport; timeoutMs?: number;
}): KeyProbe;
probe.check(key: string): Promise<{ status: 'ok' | 'rejected' | 'quota' | 'unavailable' }>;
```

Lecture stricte : erreurs constantes avec codes `CREDENTIAL_STORE_UNREADABLE`
ou `CREDENTIAL_VALUE_UNREADABLE`. La stricte interdit le secours sur erreur ;
`fallback: 'none'` interdit aussi le secours sur absence. Cache valide : pas de
lecture de base ; `cacheMs: 0` pour vérifier chaque fois.
Crochet en échec : `CREDENTIAL_AFTER_WRITE_FAILED`, `committed: true` ; la clé
est déjà écrite. Le crochet reçoit uniquement les métadonnées et ne constitue
pas une file de livraison durable.

## Fichiers du paquet

| Fichier source | Travail effectué | Exclusion volontaire |
|---|---|---|
| `src/vault.js` | Strict/repli, contexte, espace lié, versions, conservation, crochet et protection contre le retour d'un cache ancien | Aucun changement des valeurs par défaut |
| `src/stores.js` | Isolation mémoire/Mongo et indisponibilité Mongo explicite en mode strict | Pas de migration automatique des index ou des bases existantes |
| `src/context.js` (nouveau) | Validation des espaces, identité canonique, contexte AAD, projection des métadonnées | Pas de schéma métier organisation/projet imposé |
| `src/contextCipher.js` (nouveau) | AES-256-GCM, nonce aléatoire, contexte fourni séparément, refus d'altération | Pas de conversion implicite des anciens formats |
| `src/versionedStores.js` (nouveau) | Historique mémoire/Mongo, ajout atomique par clé, expiration depuis le retrait, purge du chiffré | Pas d'adapter PostgreSQL ni de migration d'un schéma existant ; contrat documenté |
| `src/readChallenge.js` (nouveau) | Défi court lié au sujet/clé/version/espace, consommation atomique mémoire/Mongo, vérificateur injectable | La vérification cryptographique des passkeys reste injectée par l'app |
| `src/keyProbe.js` (nouveau) | Sondes par clé/service, transport injecté, délai et annulation, statut seul en sortie | Les endpoints et mappings propres aux fournisseurs restent dans l'app |
| `src/rotation.js` | Contexte et espace préservés, erreurs de lecture nettoyées | Sur store versionné : nouvelle version via le coffre, pas d'écrasement de l'historique |
| `src/index.js` | Tous les nouveaux exports | Aucun export retiré |
| `src/index.d.ts` | Déclarations de toutes les nouvelles API et options | Aucune rupture de signature existante |
| `src/catalog.js`, `src/valueGuard.js`, `src/utils.js` | Conservés, régressions existantes exécutées ; garde appliqué aussi aux lectures historiques | Pas de catalogue ni de politique métier d'une application importés |
| `src/unlockChallenge.js` | Courrier et fenêtre existants conservés ; nouvelle primitive de lecture séparée | Aucun changement du déverrouillage historique |
| `src/balance.js`, `src/screenState.js`, `src/routes.js`, `src/envHydrator.js` | Conservés, tous leurs tests exécutés | Pas de routes de révélation de secrets ajoutées ; les nouvelles primitives sont serveur |
| `typecheck.ts` | Exemples typés pour chiffrement, historique, défi, sondes et adapters | Aucun |
| `__tests__/contextCipher.test.js`, `vaultExtensions.test.js`, `versionedStores.test.js`, `readChallenge.test.js`, `keyProbe.test.js` | Cinq suites nouvelles avec cas de sécurité, concurrence et erreurs | Aucun appel réseau réel |
| `__tests__/rotation.test.js`, `stores.test.js` | Régressions du contexte et des espaces, filtre Mongo plat corrigé dans l'attendu | Autres tests conservés |
| `README.md` | Exemples, contrats, rechargement local/multiprocessus, migration et limites | Aucun |
| `package.json`, `../../package-lock.json` | Version 1.1.0 cohérente, aucune dépendance ajoutée | Aucun autre paquet versionné |
| `../../CHANGELOG.md` | Entrée en français | Aucun |

## Vérifications

- `npm test -w @astratra/credentials -- --runInBand` : **15 suites, 241 tests**, tous passants.
- Tests entièrement locaux, transports et collections Mongo simulés ; aucune preuve
  d'intégration sur une base Mongo/PostgreSQL réelle revendiquée.
- `eslint packages/credentials --max-warnings 0` : passe sans avertissement.
- `npm run typecheck` du dépôt : passe, y compris les nouveaux exemples.
- `npm run lint` global : trois erreurs hors périmètre : parsing ESM de
  `fetch` non déclaré
  dans `packages/saas-kit/__tests__/login-limiter.test.js:21,34`. Fichiers inchangés.
- `git diff --check` : passe.
- `npm pack --dry-run -w @astratra/credentials --json --cache /private/tmp/credentials-npm-cache` :
  version **1.1.0**, uniquement LICENSE, README, package.json et src, sans tests.
- Aucune publication npm, aucun script de publication, aucun push.

### Mutations exécutées puis restaurées

1. Lecture stricte désactivée : `strict get refuses store failure with a safe event`
   et 11 autres tests échouent (**12 échecs**).
2. AAD retirée du chiffrement/déchiffrement : `changing tenant refuses the ciphertext`
   ainsi que les changements d'environnement/nom/version échouent (**4 échecs**).
3. Défi laissé réutilisable : `concurrent consumption admits only one verification`
   et le test de lecture unique échouent (**2 échecs**).

Le code original a été rétabli dans un `finally` après chaque mutation.
La suite complète a repassé après restauration et après les dernières corrections.

## Commit local

La mission demandait un commit en français. `git add` a échoué :
`Unable to create /Users/emchkongo/astratra/.git/worktrees/astratra-credentials/index.lock: Operation not permitted`.
Le bac à sable autorise l'arbre de travail, mais pas l'écriture des métadonnées
Git externes. Aucun commit créé ; tous les changements restent dans l'arbre.
Commit prévu : **Ajouter le coffre strict, les espaces isolés et les versions de credentials 1.1.0**.

## Limites d'exploitation documentées

La collection versionnée Mongo est dédiée ; l'historique de métadonnées doit
être archivé avant la limite de taille d'un document pour les clés très souvent
modifiées. Les index du store classique existant, l'effacement périodique des
versions et défis expirés, le bus d'invalidation et la file de livraison durable
restent configurés par l'app. Une ancienne génération de chiffrement doit rester
disponible tant que ses versions historiques sont conservées.
