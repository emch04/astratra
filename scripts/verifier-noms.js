/* Astratra est un framework générique : aucun nom de personne, de projet
   personnel ou de projet client ne doit figurer dans ses fichiers, ni dans les
   messages des commits qui ne sont pas encore poussés.

   La liste est faite d'empreintes, pour ne pas écrire les noms qu'elle
   interdit. Chaque mot (lettres et chiffres, sans accents, en minuscules) et
   chaque paire de mots voisins est comparé à la liste. Pour ajouter un nom :
     node scripts/verifier-noms.js --empreinte "le nom"
   puis coller l'empreinte dans INTERDITS. */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const racine = path.resolve(__dirname, '..');

const INTERDITS = new Set([
  '49f106b5d9e7e0987c84', '33961073611853611b5f', '00a077907693b632e081', 'e5a488d5f8b335e3a7fa',
  '470e3a627abe2fdda7eb', '0a6476e78d74a1e8efef', 'bdf1c381753ea2e32f7b', '2603a9558657b318f49a',
  '020aaecbc10923015941', 'f72e3b5eae0d1ee0c94e', 'ed3f4d611fb681591afd', '17fed598e17d80d8b9fe',
  'c9fd0ae6a0b507614742', '3aa0dca597b6bbc8fbe1', 'c90de06efbd7add06405',
  '4b49a7cabde14555d70f', 'cc520d382812b4eb5348', 'b74afad57ce52ff95933'
]);

const empreinte = (texte) => crypto.createHash('sha256').update(`astratra-noms:${texte}`).digest('hex').slice(0, 20);

const mots = (texte) => texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];

/** Les mots ou paires interdits trouvés dans un texte, avec leur ligne. */
function trouver(texte) {
  const trouves = [];
  texte.split('\n').forEach((ligne, i) => {
    const liste = mots(ligne);
    liste.forEach((mot, j) => {
      if (INTERDITS.has(empreinte(mot))) trouves.push({ ligne: i + 1, texte: mot });
      if (j > 0 && INTERDITS.has(empreinte(`${liste[j - 1]} ${mot}`))) trouves.push({ ligne: i + 1, texte: `${liste[j - 1]} ${mot}` });
    });
  });
  return trouves;
}

function git(...args) {
  return execFileSync('git', args, { cwd: racine, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function verifier() {
  const fautes = [];
  for (const fichier of git('ls-files', '-z').split('\0').filter(Boolean)) {
    const chemin = path.join(racine, fichier);
    if (!fs.existsSync(chemin) || fs.statSync(chemin).isDirectory()) continue;
    const contenu = fs.readFileSync(chemin);
    if (contenu.includes(0)) continue;
    for (const { ligne, texte } of trouver(`${fichier}\n${contenu.toString('utf8')}`)) {
      fautes.push(ligne === 1 ? `${fichier} (nom du fichier) : « ${texte} »` : `${fichier}:${ligne - 1} : « ${texte} »`);
    }
  }
  /* Les commits pas encore poussés : leurs messages se corrigent encore. */
  let commits = [];
  try {
    commits = git('rev-list', '@{upstream}..HEAD').split('\n').filter(Boolean);
  } catch {
    /* Pas de branche suivie (copie de travail, intégration continue) : rien à relire. */
  }
  for (const commit of commits) {
    for (const { texte } of trouver(git('log', '-1', '--format=%an%n%B', commit))) {
      fautes.push(`commit ${commit.slice(0, 7)} (auteur ou message) : « ${texte} »`);
    }
  }
  return fautes;
}

if (require.main === module) {
  const demande = process.argv.indexOf('--empreinte');
  if (demande !== -1) {
    const texte = mots(process.argv.slice(demande + 1).join(' ')).join(' ');
    console.log(empreinte(texte));
  } else {
    const fautes = verifier();
    if (fautes.length > 0) {
      console.error(`Noms interdits (personne, projet personnel ou client) :\n${fautes.map((f) => `  ${f}`).join('\n')}`);
      process.exit(1);
    }
    console.log('Aucun nom interdit.');
  }
}

module.exports = { trouver, empreinte, mots };
