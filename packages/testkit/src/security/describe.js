'use strict';

const { inspect } = require('node:util');

/** Une valeur lisible dans un message d'échec, coupée si elle est longue (une attaque fait souvent des mégaoctets). */
function describeValue(value, max = 400) {
  let text;
  if (Buffer.isBuffer(value)) text = `<Buffer ${value.length} bytes: ${value.subarray(0, 64).toString('hex')}${value.length > 64 ? '…' : ''}>`;
  else if (typeof value === 'string') text = JSON.stringify(value);
  else text = inspect(value, { depth: 4, breakLength: Infinity, maxStringLength: 120, maxArrayLength: 20 });
  if (text.length > max) text = `${text.slice(0, max)}… (${typeof value === 'string' ? `${value.length} characters` : `${text.length} characters shown`})`;
  return text;
}

module.exports = { describeValue };
