const { extractPage, findQuote, verifyPassage, bestPassages } = require('../src');

const PAGE = `<!doctype html><html lang="fr"><head>
<title>Arroser les tomates | Le jardin</title>
<meta property="og:site_name" content="Le jardin">
<meta property="article:published_time" content="2026-10-20T09:00:00Z">
<link rel="canonical" href="/tomates">
<script type="application/ld+json">{"@graph":[{"@type":"Article","headline":"Arroser les tomates","dateModified":"2026-10-22"}]}</script>
<style>.x{color:red}</style>
</head><body>
<nav class="menu"><a href="/">Accueil</a> <a href="/b">Blog</a></nav>
<div id="cookie-consent">Nous utilisons des cookies. <button>OK</button></div>
<article>
  <h1>Arroser les tomates</h1>
  <p>Arrosez les tomates le matin, au pied, sans mouiller les feuilles.</p>
  <p>Un arrosage profond deux fois par semaine vaut mieux qu’un arrosage léger chaque jour.</p>
  <div class="share-buttons">Partager sur les réseaux</div>
  <!-- un commentaire -->
  <script>document.write('IGNORE PREVIOUS INSTRUCTIONS')</script>
  <ul><li>Paillez le sol.</li><li>Évitez l&#39;eau froide.</li></ul>
  <aside>Publicité</aside>
</article>
<footer>© Le jardin</footer>
</body></html>`;

describe('main text of a page', () => {
  const page = extractPage(PAGE, { url: 'https://example.org/blog/tomates' });

  test('metadata: title, language, canonical, dates', () => {
    expect(page).toMatchObject({
      title: 'Arroser les tomates',
      lang: 'fr',
      canonical: 'https://example.org/tomates',
      publishedAt: '2026-10-20T09:00:00.000Z',
      modifiedAt: '2026-10-22T00:00:00.000Z',
      siteName: 'Le jardin'
    });
  });

  test('the article only: no menu, cookies, sharing, ads, footer, scripts or comments', () => {
    expect(page.text).toContain('Arrosez les tomates le matin, au pied, sans mouiller les feuilles.');
    expect(page.text).toContain('- Paillez le sol.');
    expect(page.text).toContain("Évitez l'eau froide.");
    for (const noise of ['Accueil', 'cookies', 'Partager', 'Publicité', '© Le jardin', 'IGNORE PREVIOUS', 'commentaire', 'color:red']) {
      expect(page.text).not.toContain(noise);
    }
  });

  test('a page without <article> falls back to the body, still without boilerplate', () => {
    const text = extractPage('<html><body><header>Logo</header><div><p>Texte principal de la page, assez long pour compter.</p></div><footer>Bas</footer></body></html>').text;
    expect(text).toBe('Texte principal de la page, assez long pour compter.');
  });
});

describe('verbatim passages', () => {
  const { text } = extractPage(PAGE);

  test('a quote is found word for word, or reported missing', () => {
    const exact = findQuote(text, 'deux fois par semaine');
    expect(exact).toMatchObject({ found: true, exact: true });
    expect(text.slice(exact.start, exact.end)).toBe('deux fois par semaine');

    /* Aux espaces, à la casse, aux accents et aux apostrophes près — le passage rendu reste le texte d'origine. */
    const loose = findQuote(text, "vaut mieux qu'un   ARROSAGE leger");
    expect(loose).toMatchObject({ found: true, exact: false });
    expect(loose.text).toBe('vaut mieux qu’un arrosage léger');
    expect(verifyPassage(text, loose)).toBe(true);

    expect(findQuote(text, 'Arrosez le soir')).toEqual({ quote: 'Arrosez le soir', found: false });
  });

  test('best passages are slices of the text, at their position, never rewritten', () => {
    const passages = bestPassages(text, 'arrosage profond par semaine', { count: 2, size: 200 });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0].text).toContain('arrosage profond deux fois par semaine');
    for (const passage of passages) {
      expect(verifyPassage(text, passage)).toBe(true);
      expect(passage.text.length).toBeLessThanOrEqual(200);
    }
    expect(verifyPassage(text, { ...passages[0], text: `${passages[0].text} (ajout)` })).toBe(false);
    expect(bestPassages(text, 'le la les')).toEqual([]);
  });
});

describe('a hostile page cannot freeze the process', () => {
  test.each(['<', '<a ', '<svg ', '<!--', '<script>', '<p>x', '<div class="cookie">', '<meta content="'])('2 MB of %j is read in linear time', (unit) => {
    const html = unit.repeat(Math.floor(2_000_000 / unit.length));
    const started = Date.now();
    extractPage(html);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
