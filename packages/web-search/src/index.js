/**
 * @astratra/web-search : une recherche web pour les IA où chaque fait reste
 * attaché à sa page. Voir README.md.
 */

module.exports = {
  ...require('./webSearch'),
  ...require('./errors'),
  ...require('./url'),
  ...require('./dates'),
  ...require('./query'),
  ...require('./fusion'),
  ...require('./address'),
  ...require('./safeFetch'),
  ...require('./extract'),
  ...require('./passages'),
  ...require('./stores'),
  ...require('./format'),
  ...require('./tools'),
  ...require('./evaluation'),
  ...require('./providers/serper'),
  ...require('./providers/brave'),
  ...require('./providers/tavily'),
  ...require('./providers/exa'),
  ...require('./providers/gateway'),
  ...require('./browser/client'),
  ...require('./browser/engine'),
  ...require('./browser/service'),
  ...require('./browser/deploy'),
  ...require('./browser/robots'),
  ...require('./browser/siteSearch'),
  ...require('./browser/webBotAuth'),
  ...require('./browser/isolation'),
  ...require('./browser/egressProxy')
};
