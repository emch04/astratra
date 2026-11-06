import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cheminPropre, extraireTables, instructions, lireAtos, lireBaseTexte, lireFonctions, lireLignes, lireUuids, type TableSymboles } from '../src/symboles.ts';
import { executer } from '../src/cli.ts';

/* Les tables de symboles natives : extraites des dSYM sur le Mac, envoyées par UUID, sans chemin de la machine. */

test('les sorties des outils de Xcode sont lues : UUID, base de __TEXT, fonctions, lignes, atos', () => {
  assert.deepEqual(lireUuids('UUID: ecbbf78a-b58e-3df9-819c-7b2ea15372f5 (arm64) /tmp/App\nUUID: 11111111-2222-3333-4444-555555555555 (x86_64) /tmp/App'),
    [{ uuid: 'ECBBF78A-B58E-3DF9-819C-7B2EA15372F5', arch: 'arm64' }, { uuid: '11111111-2222-3333-4444-555555555555', arch: 'x86_64' }]);
  assert.equal(lireBaseTexte('Load command 1\n      cmd LC_SEGMENT_64\n  cmdsize 552\n  segname __TEXT\n   vmaddr 0x0000000100000000\n'), 0x100000000n);
  assert.deepEqual(lireFonctions('0000000100000000 T __mh_execute_header\n0000000100003f20 t _$s7Exemple8calculeryyF\n0000000100003f20 t _autre_nom\n0000000100004000 D _donnee\n', 0x100000000n),
    [[0, '__mh_execute_header'], [0x3f20, '_$s7Exemple8calculeryyF']]);

  const debugLine = [
    'debug_line[0x00000000]',
    'include_directories[  0] = "/Users/quelquun/projet"',
    'include_directories[  1] = "Sources"',
    'file_names[  0]:',
    '           name: "Exemple.swift"',
    '      dir_index: 1',
    'file_names[  1]:',
    '           name: "/Applications/Xcode.app/Contents/SDK/usr/include/stdio.h"',
    '      dir_index: 0',
    'Address            Line   Column File   ISA Discriminator OpIndex Flags',
    '0x0000000100003f20     12      5      0   0             0       0  is_stmt',
    '0x0000000100003f28     13      9      1   0             0       0  is_stmt',
    '0x0000000100003f30     13      9      1   0             0       0  is_stmt end_sequence',
    '0x0000000000000000      1      0      0   0             0       0  is_stmt end_sequence'
  ].join('\n');
  const { fichiers, lignes } = lireLignes(debugLine, 0x100000000n, '/Users/quelquun/projet');
  assert.deepEqual(fichiers, ['Sources/Exemple.swift', 'include/stdio.h'], 'relatif sous la racine, deux segments ailleurs');
  assert.deepEqual(lignes, [[0x3f20, 0, 12], [0x3f28, 1, 13], [0x3f30, -1, 0]], 'l\'adresse 0 (code retiré) est ignorée');
  assert.deepEqual(instructions(lignes), [0x3f20, 0x3f24, 0x3f28, 0x3f2c]);

  assert.deepEqual(lireAtos('calculer() (in Exemple) (Exemple.swift:12)'), { nom: 'calculer()', fichier: 'Exemple.swift', ligne: 12 });
  assert.deepEqual(lireAtos('closure #1 in Vue.corps.getter (in Exemple) (/<compiler-generated>:0)'), { nom: 'closure #1 in Vue.corps.getter', fichier: null, ligne: null });
  assert.deepEqual(lireAtos('_dyld_start (in dyld) + 12'), { nom: '_dyld_start', fichier: null, ligne: null });
  assert.deepEqual(lireAtos('0x0000000100002564'), { nom: null, fichier: null, ligne: null });
  assert.equal(cheminPropre('/Users/quelquun/Documents/secret/Vue.swift', '/ailleurs'), 'secret/Vue.swift');
});

/** La recherche que fait le tableau de bord : la dernière entrée au plus égale au décalage. */
function chercher(table: TableSymboles, decalage: number) {
  const avant = <T extends [number, ...unknown[]]>(l: T[]) => l.filter((e) => e[0] <= decalage).pop();
  const f = avant(table.fonctions);
  const l = avant(table.lignes);
  return { fonction: f ? table.noms[f[1]] : null, fichier: l && l[1] >= 0 ? table.fichiers[l[1]] : null, ligne: l && l[1] >= 0 ? l[2] : null };
}

const xcode = (() => { try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('sur un vrai binaire compilé : la table rend la même fonction, le même fichier et la même ligne qu\'atos', { skip: !xcode && 'Xcode absent' }, async () => {
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'centrale-symboles-')));
  writeFileSync(join(dossier, 'Exemple.swift'), [
    'struct Panier {',
    '  var prix: [Int]',
    '  func total() -> Int {',
    '    var somme = 0',
    '    for p in prix { somme += p * 2 }',
    '    return somme',
    '  }',
    '}',
    '@inline(never) func calculer(_ n: Int) -> Int { Panier(prix: Array(0..<n)).total() }',
    'print(calculer(Int(CommandLine.arguments.count) + 5))',
    ''
  ].join('\n'));
  const exe = join(dossier, 'Exemple');
  /* En deux temps : dsymutil lit les informations de débogage dans le fichier objet, que swiftc effacerait sinon. */
  execFileSync('xcrun', ['swiftc', '-g', '-Onone', '-c', '-module-name', 'Exemple', '-o', `${exe}.o`, join(dossier, 'Exemple.swift')], { cwd: dossier });
  execFileSync('xcrun', ['swiftc', '-o', exe, `${exe}.o`], { cwd: dossier });
  execFileSync('xcrun', ['dsymutil', exe, '-o', `${exe}.dSYM`]);
  const tables = await extraireTables(`${exe}.dSYM`, { racine: dossier });
  assert.equal(tables.length, 1);
  const table = tables[0]!;
  assert.match(table.uuid, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.ok(table.fichiers.includes('Exemple.swift'), 'chemin relatif à la racine');
  assert.ok(!JSON.stringify(table).includes(dossier), 'aucun chemin de la machine');

  /* Chaque instruction de Panier.total(), comparée à atos. */
  const base = 0x100000000;
  const debut = table.fonctions.find(([, n]) => table.noms[n] === 'Panier.total()')?.[0];
  assert.ok(debut !== undefined, 'la fonction est dans la table');
  let comparees = 0;
  for (let d = debut!; d < debut! + 64; d += 4) {
    const atos = lireAtos(execFileSync('xcrun', ['atos', '-arch', table.arch, '-o', `${exe}.dSYM`, '-l', `0x${base.toString(16)}`, `0x${(base + d).toString(16)}`]).toString());
    if (!atos.ligne) continue;
    const nous = chercher(table, d);
    assert.equal(nous.fonction, atos.nom, `fonction en +${d}`);
    assert.equal(nous.ligne, atos.ligne, `ligne en +${d}`);
    assert.ok(nous.fichier?.endsWith(atos.fichier!), `fichier en +${d}`);
    comparees++;
  }
  assert.ok(comparees >= 5, `au moins 5 instructions comparées (${comparees})`);
});

test('envoyer-symboles : jeton de déploiement, tables déjà connues sautées, les autres envoyées une par une', async () => {
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'centrale-symboles-')));
  const dsym = join(dossier, 'App.dSYM');
  execFileSync('mkdir', ['-p', join(dsym, 'Contents', 'Resources', 'DWARF')]);
  writeFileSync(join(dsym, 'Contents', 'Resources', 'DWARF', 'App'), 'faux');
  const outil = async (nom: string, args: string[], entree?: string) => {
    if (nom === 'dwarfdump' && args[0] === '--uuid') return `UUID: AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE (arm64) x\nUUID: 11111111-2222-3333-4444-555555555555 (x86_64) x\n`;
    if (nom === 'otool') return 'segname __TEXT\n   vmaddr 0x0000000100000000\n';
    if (nom === 'nm') return '0000000100000010 T _main\n';
    if (nom === 'swift-demangle') return entree ?? '';
    if (nom === 'dwarfdump') return ['debug_line[0x0]', 'include_directories[  0] = ""', 'file_names[  0]:', 'name: "main.swift"', 'dir_index: 0',
      '0x0000000100000010      3      1      0   0 0 0 is_stmt', '0x0000000100000018      3      1      0   0 0 0 is_stmt end_sequence'].join('\n');
    if (nom === 'atos') return (entree ?? '').trim().split('\n').map(() => 'main (in App) (main.swift:3)').join('\n');
    throw new Error(`outil inattendu : ${nom}`);
  };
  const appels: Array<{ adresse: string; corps: unknown; jeton: string }> = [];
  const fetch = (async (adresse: string, init: { body: string | Uint8Array; headers: Record<string, string> }) => {
    const brut = typeof init.body === 'string' ? init.body : gunzipSync(init.body).toString('utf8');
    const corps = JSON.parse(brut);
    appels.push({ adresse, corps, jeton: init.headers.Authorization });
    const json = adresse.endsWith('/connues') ? { connues: ['11111111-2222-3333-4444-555555555555'] } : { nouvelle: true };
    return new Response(JSON.stringify(json), { status: adresse.endsWith('/connues') ? 200 : 201 });
  }) as unknown as typeof globalThis.fetch;
  const sorties: string[] = [];
  const code = await executer(['envoyer-symboles', dsym, '--version', '1.3.0', '--racine', dossier], {
    env: { CENTRALE_JETON: 'clj_dep_essai', CENTRALE_ADRESSE: 'https://centrale.exemple.test' },
    sorties: { ecrire: (t) => sorties.push(t), erreur: (t) => sorties.push(`ERREUR ${t}`) },
    connexion: { fetch }, outil
  });
  assert.equal(code, 0, sorties.join('\n'));
  assert.deepEqual(appels.map((a) => a.adresse), ['https://centrale.exemple.test/v1/symboles/connues', 'https://centrale.exemple.test/v1/symboles']);
  assert.equal(appels[0]!.jeton, 'Bearer clj_dep_essai');
  const envoi = appels[1]!.corps as { version: string; table: TableSymboles };
  assert.equal(envoi.version, '1.3.0');
  assert.equal(envoi.table.uuid, 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
  assert.deepEqual(envoi.table.noms, ['main']);
  assert.deepEqual(envoi.table.lignes, [[0x10, 0, 3], [0x18, -1, 0]]);
  assert.match(sorties.at(-1)!, /1 table\(s\) de symboles envoyée\(s\), 1 déjà connue\(s\)/);

  assert.equal(await executer(['envoyer-symboles', join(dossier, 'absent')], { env: {}, sorties: { ecrire: () => {}, erreur: () => {} } }), 2);
});
