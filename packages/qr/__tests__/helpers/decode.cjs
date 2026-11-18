// Relit des codes QR avec le décodeur de qr-scanner (port de jsQR), récupéré de son worker et lancé hors navigateur.
// node decode.cjs <qr-scanner-worker.min.js> <codes.json> : chaque code { size, data (base64, un octet par module) }.
/* global TextDecoder */
'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const { resolveObjectURL } = require('node:buffer');
const { pathToFileURL } = require('node:url');

(async () => {

const [workerPath, input] = process.argv.slice(2);
globalThis.Worker = class { constructor(url) { this.url = url; } };
const { createWorker } = await import(pathToFileURL(workerPath).href);
const source = await resolveObjectURL(createWorker().url).text();
let last;
const context = vm.createContext({ postMessage: (m) => { last = m; }, Uint8ClampedArray, Int32Array, Uint8Array, Float32Array, TextDecoder });
context.self = context;
vm.runInContext(source, context);
const decode = ({ size, data }) => {
  const modules = Buffer.from(data, 'base64');
  const scale = 3;
  const side = (size + 8) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let py = 0; py < side; py++) for (let px = 0; px < side; px++) {
    const y = Math.floor(py / scale) - 4;
    const x = Math.floor(px / scale) - 4;
    if (y >= 0 && y < size && x >= 0 && x < size && modules[y * size + x]) pixels.fill(0, (py * side + px) * 4, (py * side + px) * 4 + 3);
  }
  last = undefined;
  (context.onmessage || context.self.onmessage)({ data: { id: 1, type: 'decode', data: { data: pixels, width: side, height: side } } });
  return last ? last.data : null;
};
process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(input, 'utf8')).map(decode)));
})();
