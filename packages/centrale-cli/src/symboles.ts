/**
 * `centrale envoyer-symboles <archive | .dSYM | fichier DWARF> [--version X] [--racine dossier]` : les tables de symboles
 * des binaires Apple (iOS, macOS), pour que le tableau de bord traduise lui-même « MonApp +5552808 » en fonction, fichier
 * et ligne, sans jamais recevoir le dSYM.
 *
 * Sur le Mac de publication, avec les outils de Xcode (`xcrun`) :
 * 1. `dwarfdump --uuid` : l'UUID de chaque architecture du binaire (celui que donnent les rapports d'Apple) ;
 * 2. `otool -l` : l'adresse du segment __TEXT, pour compter en décalages (l'unité de `offsetIntoBinaryTextSegment`) ;
 * 3. `dwarfdump --debug-line` : les adresses où commence chaque ligne de code ;
 * 4. `atos`, la référence d'Apple, traduit chacune de ces adresses (fonction, fichier, ligne), en tenant compte du code
 *    déplié (inlined) : la ligne rendue est celle de la fonction elle-même, pas celle d'une macro dépliée dedans ;
 * 5. `nm -n` puis `swift-demangle` : le début de chaque fonction, pour le code sans informations de débogage.
 * Le serveur n'a plus qu'à chercher, pour un décalage, la dernière entrée qui le précède.
 * Les chemins sous `--racine` (le dossier courant par défaut) deviennent relatifs ; les autres ne gardent que leurs deux
 * derniers segments : aucun chemin de la machine (nom d'utilisateur, disques) ne part.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { appeler, type Connexion } from './envoyer.ts';

const execFileAsync = promisify(execFile);

export interface TableSymboles {
  version: 1;
  uuid: string;
  arch: string;
  binaire: string;
  fichiers: string[];
  /** Les noms lisibles des fonctions, chacun une seule fois. */
  noms: string[];
  /** [décalage depuis __TEXT, index du nom], triées. */
  fonctions: Array<[number, number]>;
  /** [décalage, index du fichier (-1 : aucune ligne connue, fin de séquence), ligne], triées. */
  lignes: Array<[number, number, number]>;
}

/** Lance un outil de Xcode et rend sa sortie (injectable pour les tests). */
export type Outil = (outil: string, args: string[], entree?: string) => Promise<string>;

export const outilXcode: Outil = async (outil, args, entree) => {
  if (entree === undefined) {
    const { stdout } = await execFileAsync('xcrun', [outil, ...args], { maxBuffer: 1024 * 1024 * 1024 });
    return stdout;
  }
  return new Promise((ok, echec) => {
    const enfant = execFile('xcrun', [outil, ...args], { maxBuffer: 1024 * 1024 * 1024 }, (erreur, stdout) => (erreur ? echec(erreur) : ok(stdout)));
    enfant.stdin?.end(entree);
  });
};

/** Les UUID et architectures d'un fichier DWARF, lus dans la sortie de `dwarfdump --uuid`. */
export function lireUuids(sortie: string): Array<{ uuid: string; arch: string }> {
  return [...sortie.matchAll(/UUID:\s+([0-9A-F-]{36})\s+\(([^)]+)\)/gi)].map((m) => ({ uuid: m[1].toUpperCase(), arch: m[2] }));
}

/** L'adresse du segment __TEXT, lue dans la sortie de `otool -l`. */
export function lireBaseTexte(sortie: string): bigint | null {
  const m = /segname __TEXT\s+vmaddr (0x[0-9a-f]+)/i.exec(sortie);
  return m ? BigInt(m[1]) : null;
}

/** Les fonctions (symboles de texte t/T) de `nm -n`, en décalages ; une adresse partagée garde le premier nom. */
export function lireFonctions(sortie: string, base: bigint): Array<[number, string]> {
  const vues = new Set<number>();
  const fonctions: Array<[number, string]> = [];
  for (const ligne of sortie.split('\n')) {
    const m = /^([0-9a-f]{8,16})\s+[tT]\s+(\S.*)$/i.exec(ligne.trim());
    if (!m) continue;
    const adresse = BigInt(`0x${m[1]}`);
    if (adresse < base) continue;
    const decalage = Number(adresse - base);
    if (vues.has(decalage)) continue;
    vues.add(decalage);
    fonctions.push([decalage, m[2]]);
  }
  return fonctions.sort((a, b) => a[0] - b[0]);
}

/** Un chemin source sans rien de la machine : relatif sous la racine, sinon ses deux derniers segments. */
export function cheminPropre(chemin: string, racine: string | null): string {
  const r = racine ? racine.replace(/\/+$/, '') + '/' : null;
  if (r && chemin.startsWith(r)) return chemin.slice(r.length);
  const segments = chemin.split('/').filter(Boolean);
  return segments.slice(-2).join('/');
}

/**
 * La table des lignes, lue dans la sortie de `dwarfdump --debug-line` : pour chaque unité, ses dossiers et ses fichiers
 * (DWARF 4 et 5), puis les lignes « adresse ligne colonne fichier … ». Une ligne `end_sequence` ferme une plage. Les
 * adresses sous __TEXT (fonctions retirées par l'éditeur de liens, à l'adresse 0) sont ignorées.
 */
export function lireLignes(sortie: string, base: bigint, racine: string | null): { fichiers: string[]; lignes: Array<[number, number, number]> } {
  const fichiers: string[] = [];
  const indexFichier = new Map<string, number>();
  const lignes: Array<[number, number, number]> = [];
  let dossiers: string[] = [];
  let noms = new Map<number, { nom: string; dossier: number }>();
  let courant: { index: number; nom?: string; dossier?: number } | null = null;
  const fermerFichier = () => {
    if (courant && courant.nom !== undefined) noms.set(courant.index, { nom: courant.nom, dossier: courant.dossier ?? 0 });
    courant = null;
  };
  const resoudre = (numero: number): number => {
    const f = noms.get(numero);
    if (!f) return -1;
    const dossier = dossiers[f.dossier] ?? '';
    const complet = f.nom.startsWith('/') || !dossier ? f.nom : `${dossier}/${f.nom}`;
    const propre = cheminPropre(complet, racine);
    let i = indexFichier.get(propre);
    if (i === undefined) { i = fichiers.length; fichiers.push(propre); indexFichier.set(propre, i); }
    return i;
  };
  const cacheUnite = new Map<number, number>();
  for (const brute of sortie.split('\n')) {
    const ligne = brute.trim();
    if (ligne.startsWith('debug_line[')) { fermerFichier(); dossiers = []; noms = new Map(); cacheUnite.clear(); continue; }
    let m = /^include_directories\[\s*(\d+)\]\s*=\s*"(.*)"$/.exec(ligne);
    if (m) { dossiers[Number(m[1])] = m[2]; continue; }
    m = /^file_names\[\s*(\d+)\]:$/.exec(ligne);
    if (m) { fermerFichier(); courant = { index: Number(m[1]) }; continue; }
    m = /^name:\s*"(.*)"$/.exec(ligne);
    if (m && courant) { courant.nom = m[1]; continue; }
    m = /^dir_index:\s*(\d+)$/.exec(ligne);
    if (m && courant) { courant.dossier = Number(m[1]); continue; }
    m = /^0x([0-9a-f]{16})\s+(\d+)\s+\d+\s+(\d+)\s.*?(end_sequence)?$/i.exec(ligne);
    if (m) {
      fermerFichier();
      const adresse = BigInt(`0x${m[1]}`);
      if (adresse < base) continue;
      const decalage = Number(adresse - base);
      if (m[4]) { lignes.push([decalage, -1, 0]); continue; }
      const numero = Number(m[3]);
      let i = cacheUnite.get(numero);
      if (i === undefined) { i = resoudre(numero); cacheUnite.set(numero, i); }
      const numeroLigne = Number(m[2]);
      if (i >= 0 && numeroLigne > 0) lignes.push([decalage, i, numeroLigne]);
    }
  }
  /* À décalage égal, la fin de séquence passe avant le début de la suivante. */
  lignes.sort((a, b) => a[0] - b[0] || (a[1] === -1 ? -1 : b[1] === -1 ? 1 : 0));
  return { fichiers, lignes };
}

/** Les noms lisibles (Swift démanglé, C sans son « _ »), dans le même ordre. */
export async function demangler(noms: string[], outil: Outil): Promise<string[]> {
  if (!noms.length) return [];
  const sortie = await outil('swift-demangle', ['--simplified', '--compact'], noms.join('\n') + '\n');
  const lus = sortie.split('\n');
  return noms.map((nom, i) => {
    const lisible = (lus[i] ?? nom).trim() || nom;
    return lisible === nom && nom.startsWith('_') ? nom.slice(1) : lisible;
  });
}

/** Une ligne de sortie d'`atos` : « nom (in Binaire) (Fichier.swift:42) », ou sans fichier, ou l'adresse seule. */
export function lireAtos(ligne: string): { nom: string | null; fichier: string | null; ligne: number | null } {
  const t = ligne.trim();
  if (!t || /^0x[0-9a-f]+$/i.test(t)) return { nom: null, fichier: null, ligne: null };
  const avecFichier = /^(.*?) \(in [^)]*\) \((.+):(\d+)\)$/.exec(t);
  if (avecFichier) {
    const fichier = avecFichier[2] === '/<compiler-generated>' || avecFichier[2] === '<compiler-generated>' ? null : avecFichier[2];
    return { nom: avecFichier[1], fichier, ligne: fichier && Number(avecFichier[3]) > 0 ? Number(avecFichier[3]) : null };
  }
  const sansFichier = /^(.*?) \(in [^)]*\)/.exec(t);
  return { nom: sansFichier ? sansFichier[1] : null, fichier: null, ligne: null };
}

/** Les fichiers DWARF d'une archive Xcode (.xcarchive), d'un .dSYM, ou le fichier lui-même. */
export function fichiersDwarf(chemin: string): string[] {
  const absolu = resolve(chemin);
  if (!existsSync(absolu)) return [];
  if (statSync(absolu).isFile()) return [absolu];
  if (absolu.endsWith('.dSYM')) {
    const dossier = join(absolu, 'Contents', 'Resources', 'DWARF');
    return existsSync(dossier) ? readdirSync(dossier).map((f) => join(dossier, f)).filter((f) => statSync(f).isFile()) : [];
  }
  const dsyms = existsSync(join(absolu, 'dSYMs')) ? join(absolu, 'dSYMs') : absolu;
  return readdirSync(dsyms).filter((f) => f.endsWith('.dSYM')).flatMap((f) => fichiersDwarf(join(dsyms, f)));
}

/** Les tables de symboles de chaque architecture de chaque binaire trouvé. */
export async function extraireTables(chemin: string, { racine = process.cwd(), outil = outilXcode }: { racine?: string | null; outil?: Outil } = {}): Promise<TableSymboles[]> {
  const racineAbsolue = racine ? resolve(racine) : null;
  const tables: TableSymboles[] = [];
  for (const fichier of fichiersDwarf(chemin)) {
    for (const { uuid, arch } of lireUuids(await outil('dwarfdump', ['--uuid', fichier]))) {
      const base = lireBaseTexte(await outil('otool', ['-arch', arch, '-l', fichier]));
      if (base === null) continue;
      tables.push(await tableDe(fichier, uuid, arch, base, racineAbsolue, outil));
    }
  }
  return tables;
}

/** La table d'une architecture : débuts de lignes traduits par `atos`, débuts de fonctions par `nm`. */
async function tableDe(fichier: string, uuid: string, arch: string, base: bigint, racine: string | null, outil: Outil): Promise<TableSymboles> {
  const noms: string[] = [];
  const indexNom = new Map<string, number>();
  const nom = (n: string) => {
    const court = n.slice(0, 2000);
    let i = indexNom.get(court);
    if (i === undefined) { i = noms.length; noms.push(court); indexNom.set(court, i); }
    return i;
  };
  const fonctions: Array<[number, number]> = [];

  /* Les débuts de fonctions (nm), même sans informations de débogage. */
  const brutes = lireFonctions(await outil('nm', ['-arch', arch, '-n', '--defined-only', fichier]), base);
  const lisibles = await demangler(brutes.map(([, n]) => n), outil);
  brutes.forEach(([d], i) => fonctions.push([d, nom(lisibles[i]!)]));

  /* Les débuts de lignes (DWARF), traduits par atos : fonction englobante, fichier et ligne de son propre code. */
  const { fichiers: chemins, lignes: brutesLignes } = lireLignes(await outil('dwarfdump', [`--arch=${arch}`, '--debug-line', fichier]), base, racine);
  /*
   * Les adresses à traduire. Sur arm64 (toutes les instructions font 4 octets), CHAQUE instruction des plages couvertes par
   * les informations de débogage : la table rend alors exactement ce que rendrait atos. Ailleurs (x86_64, instructions de
   * longueur variable), le début de chaque ligne de la table DWARF.
   */
  const debuts = arch.startsWith('arm64') ? instructions(brutesLignes) : [...new Set(brutesLignes.filter((l) => l[1] >= 0).map((l) => l[0]))].sort((a, b) => a - b);
  const sortie = debuts.length
    ? (await outil('atos', ['-arch', arch, '-o', fichier, '-l', `0x${base.toString(16)}`], debuts.map((d) => `0x${(base + BigInt(d)).toString(16)}`).join('\n') + '\n')).split('\n')
    : [];
  /* atos ne rend que le nom du fichier : on le rattache au chemin relatif de la table des lignes quand il est unique. */
  const parNom = new Map<string, string | null>();
  for (const c of chemins) { const n = c.split('/').pop()!; parNom.set(n, parNom.has(n) ? null : c); }
  const fichiers: string[] = [];
  const indexFichier = new Map<string, number>();
  const fichierDe = (f: string) => {
    const n = f.split('/').pop()!;
    const chemin = f.startsWith('/') ? cheminPropre(f, racine) : (parNom.get(n) ?? n);
    let i = indexFichier.get(chemin);
    if (i === undefined) { i = fichiers.length; fichiers.push(chemin); indexFichier.set(chemin, i); }
    return i;
  };
  const lignes: Array<[number, number, number]> = [];
  let dernierNom = -1;
  let derniere = '';
  debuts.forEach((d, i) => {
    const lu = lireAtos(sortie[i] ?? '');
    if (lu.nom) {
      const n = nom(lu.nom);
      if (n !== dernierNom) { fonctions.push([d, n]); dernierNom = n; }
    }
    /* Seuls les changements sont gardés : la table reste petite même quand chaque instruction est traduite. */
    const entree: [number, number, number] = lu.fichier && lu.ligne ? [d, fichierDe(lu.fichier), lu.ligne] : [d, -1, 0];
    const cle = `${entree[1]}:${entree[2]}`;
    if (cle !== derniere || (i > 0 && debuts[i - 1] !== d - 4 && arch.startsWith('arm64'))) { lignes.push(entree); derniere = cle; }
  });
  /* Les fins de séquence : au-delà, plus aucune ligne connue. */
  const debutsConnus = new Set(debuts);
  for (const [d, f] of brutesLignes) if (f === -1 && !debutsConnus.has(d)) lignes.push([d, -1, 0]);
  lignes.sort((a, b) => a[0] - b[0]);
  /* À décalage égal, le nom donné par atos (dernier ajouté) l'emporte sur celui de nm. */
  const fonctionsTriees = fonctions.map((f, i) => ({ f, i })).sort((a, b) => a.f[0] - b.f[0] || a.i - b.i)
    .filter((x, k, t) => k === t.length - 1 || t[k + 1].f[0] !== x.f[0]).map((x) => x.f);
  return { version: 1, uuid, arch, binaire: basename(fichier), fichiers, noms, fonctions: fonctionsTriees, lignes };
}

/** Chaque instruction (4 octets) des plages couvertes par la table des lignes : du premier début à la fin de séquence. */
export function instructions(lignes: Array<[number, number, number]>): number[] {
  const adresses: number[] = [];
  let debut: number | null = null;
  for (const [d, f] of lignes) {
    if (f >= 0) { if (debut === null) debut = d; continue; }
    if (debut !== null) {
      for (let a = debut - (debut % 4); a < d; a += 4) adresses.push(a);
      debut = null;
    }
  }
  return [...new Set(adresses)].sort((a, b) => a - b);
}

export interface BilanSymboles { envoyees: string[]; dejaConnues: string[] }

/** Envoie les tables que le backend n'a pas encore (`POST /v1/symboles/connues`, puis `POST /v1/symboles`, une par une). */
export async function envoyerSymboles(connexion: Connexion, tables: TableSymboles[], { version, signaler }: { version?: string; signaler?: (m: string) => void } = {}): Promise<BilanSymboles> {
  const bilan: BilanSymboles = { envoyees: [], dejaConnues: [] };
  if (!tables.length) return bilan;
  const r = await appeler(connexion, '/v1/symboles/connues', { uuids: tables.map((t) => t.uuid) }) as { connues?: string[] };
  const connues = new Set((r?.connues ?? []).map((u) => u.toUpperCase()));
  for (const table of tables) {
    if (connues.has(table.uuid.toUpperCase())) { bilan.dejaConnues.push(table.uuid); continue; }
    signaler?.(`${table.binaire} (${table.arch}) : ${table.fonctions.length} fonctions, ${table.lignes.length} lignes`);
    await appeler(connexion, '/v1/symboles', { ...(version ? { version } : {}), table });
    bilan.envoyees.push(table.uuid);
  }
  return bilan;
}
