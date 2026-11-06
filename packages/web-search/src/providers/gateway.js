/**
 * Une passerelle de recherche à l'appelant : l'app ne garde pas les clés des
 * moteurs, sa passerelle les tient et compte le coût. Le client de la
 * passerelle n'est pas importé ici, il est passé par l'appelant :
 *
 *   gatewayProvider({ search: (demande, { signal }) => maPasserelle.rechercher(demande, { signal }) });
 *
 * La passerelle n'a pas de filtre de sites : les sites partent en opérateurs
 * (`site:`, `-site:`), que le moteur derrière (Google) comprend, et sont
 * revérifiés à l'arrivée. L'encadré de réponse et la fiche de Google ne sont
 * pas repris : seules les pages, chacune avec son adresse.
 */

const { WebSearchError, CODES } = require('../errors');
const { withOperators } = require('../query');
const { plainText } = require('../text');
const { parseDate } = require('../dates');

const PERIODS = { day: 'jour', week: 'semaine', month: 'mois', year: 'an' };

/**
 * @param {object} options
 * @param {Function} options.search (demande, { signal }) => Promise<{ fournisseur, resultats: { titre, url, extrait, date? }[] }>
 * @param {string} [options.id] Défaut 'gateway'.
 */
function gatewayProvider(options = {}) {
  if (typeof options.search !== 'function') throw new Error('gatewayProvider requires options.search (the search function of your gateway).');
  const id = options.id || 'gateway';
  return {
    id,
    /* La passerelle compte le coût elle-même : ici, inconnu. */
    costPerCallUsd: null,
    cacheTtlMs: options.cacheTtlMs,
    async search(request, { signal, now = Date.now() } = {}) {
      let answer;
      try {
        answer = await options.search({
          requete: withOperators(request),
          nombre: request.limit > 10 ? 20 : 10,
          ...(request.lang ? { langue: request.lang } : {}),
          ...(request.country ? { pays: request.country } : {}),
          ...(request.freshness ? { periode: PERIODS[request.freshness] } : {})
        }, { signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const status = Number.isInteger(error?.statut) ? error.statut : undefined;
        /* Une panne de la passerelle (PasserelleIndisponible) laisse sa chance au
           fournisseur suivant ; une requête refusée pour elle-même ne se retente pas. */
        const refused = error?.name === 'RequetePasserelleRefusee';
        throw new WebSearchError(CODES.PROVIDER_FAILED, `${id} ${refused ? 'refused the request' : 'unavailable'}${status ? ` (${status})` : ''}`, {
          provider: id, status, retryable: false, quota: status === 429 || status === 402
        });
      }
      const results = Array.isArray(answer?.resultats) ? answer.resultats : [];
      return {
        engine: typeof answer?.fournisseur === 'string' ? answer.fournisseur : null,
        hits: results.map((result) => ({
          title: plainText(result?.titre),
          url: String(result?.url ?? ''),
          snippet: plainText(result?.extrait),
          publishedAt: parseDate(result?.date, { now })
        }))
      };
    }
  };
}

module.exports = { gatewayProvider };
