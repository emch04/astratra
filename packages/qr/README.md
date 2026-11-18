# @astratra/qr

Les codes QR sans aucune dépendance, pour Node et le navigateur : modes numérique,
alphanumérique et octets (UTF-8), les quatre niveaux de correction (L, M, Q, H),
les versions 1 à 40, et le meilleur des huit masques selon les pénalités de la
norme (ISO/IEC 18004). Rendu SVG, PNG (Node) et adresse `data:`. MIT.

```sh
npm install @astratra/qr
```

## Usage

```js
const { createQr, qrToSvg, qrToPng, qrToDataUrl } = require('@astratra/qr');

// Un SVG net à toute taille (navigateur ou serveur) :
const svg = qrToSvg('https://example.test/carte/42', { ecc: 'M', margin: 2, width: 220, dark: '#1b2a4a', title: 'Carte 42' });

// Une image pour une balise <img> : SVG partout, PNG sous Node.
const src = qrToDataUrl('https://example.test/carte/42', { type: 'svg' });
const png = qrToPng('https://example.test/carte/42', { scale: 8, margin: 4 });

// La matrice, pour dessiner soi-même (React, PDF…) :
const qr = createQr('texte', { ecc: 'Q' });
qr.size;               // 21 à 177 modules de côté
qr.modules.get(0, 0);  // true pour un module sombre (ligne, colonne)
```

`createQr(texte).modules` a la même forme que `qrcode.create(texte).modules`
(`size`, `get`) : `drawQrMatrix` de `@astratra/pdf` le dessine tel quel.

## Options

| Option | Par défaut | Rôle |
|---|---|---|
| `ecc` | `'M'` | Correction : L (7 %), M (15 %), Q (25 %), H (30 %) |
| `minVersion`, `maxVersion` | 1, 40 | Bornes de la version (la taille du code) |
| `mask` | le meilleur | Forcer un masque (0 à 7) |
| `boostEcc` | `false` | Monter la correction tant que la même version le permet |
| `margin` | 4 | Marge en modules (SVG, PNG) ; la norme en demande 4 |
| `dark`, `light` | noir, blanc | Couleurs ; `light: null` pour un SVG sans fond |
| `scale` | 8 | Pixels par module (PNG) |

## Vérifié

- Comparé module par module à uqr (adaptation du générateur de référence de
  Nayuki) sur 155 cas enregistrés : versions 1 à 40, les quatre niveaux, masques
  forcés, version minimale, texte vide, contenus trop longs refusés.
- Relu par un décodeur indépendant (celui de qr-scanner, issu de jsQR) : les
  textes reviennent à l'identique, accents et émojis compris.
- Structure de la norme vérifiée sur 300 codes tirés au hasard (repères,
  synchronisation, module sombre, bits de format et leur code BCH).
- Une couleur qui n'en est pas une (`red"/><script>`) est refusée avant d'entrer
  dans le SVG ; le titre est échappé.
