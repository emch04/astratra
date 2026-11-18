'use strict';

// @astratra/qr : les codes QR sans dépendance (génération, SVG, PNG, adresse data:).
module.exports = {
  ...require('./qr'),
  ...require('./render'),
};
