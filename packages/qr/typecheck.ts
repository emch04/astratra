import { createQr, qrToSvg, qrToPng, qrToDataUrl } from './src';
import type { Qr } from './src';

const qr: Qr = createQr('https://www.example.test', { ecc: 'Q', boostEcc: true });
const dark: boolean = qr.modules.get(0, 0);
const svg: string = qrToSvg(qr, { margin: 2, dark: '#1b2a4a', width: 220, title: 'Lien' });
const png: Buffer = qrToPng('texte', { scale: 4 });
const url: string = qrToDataUrl(qr, { type: 'png', scale: 2 });
void dark;
void svg;
void png;
void url;
