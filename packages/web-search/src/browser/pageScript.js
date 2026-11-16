/**
 * Le script exécuté dans la page, une fois rendue. Il ne clique sur rien, ne
 * tape rien, n'envoie rien : il masque et il lit.
 *
 * 1. Les surcouches fixes (bandeaux de cookies, fenêtres d'abonnement,
 *    boîtes modales) sont masquées, et le défilement bloqué est rendu.
 * 2. Le texte caché est retiré : élément invisible (`display`, `visibility`,
 *    `opacity` de lui ou d'un parent, `content-visibility`), de taille nulle ou
 *    d'un pixel (texte « sr-only »), hors de l'écran, découpé à rien
 *    (`clip`, `clip-path`), police de moins d'un pixel, couleur transparente
 *    ou identique au fond, `aria-hidden`, `hidden`. Un texte caché est l'arme
 *    classique pour glisser un ordre à une IA : il ne doit pas être lu.
 * 3. Le texte visible (`innerText` après masquage), les liens visibles, les
 *    descriptions OpenSearch et les formulaires de recherche sont rendus.
 *
 * Doit rester autonome : Playwright le sérialise et l'exécute dans la page.
 */

/* global window, document, NodeFilter -- exécuté dans Chromium */
function readRenderedPage(limits) {
  const MAX_ELEMENTS = limits.maxElements;
  const MAX_TEXT = limits.maxTextChars;
  const view = { width: window.innerWidth || 1280, height: window.innerHeight || 800 };
  const viewArea = view.width * view.height;
  let overlays = 0;
  let hidden = 0;

  const hide = (element) => {
    element.setAttribute('data-astratra-hidden', '');
    element.style.setProperty('display', 'none', 'important');
  };

  /* 1. Surcouches fixes : grandes, ou nommées comme un bandeau / une fenêtre. */
  const overlayWords = /(cookie|consent|gdpr|rgpd|cmp|onetrust|didomi|tarteaucitron|newsletter|subscribe|abonn|paywall|modal|popup|pop-up|overlay|lightbox|interstitial|dialog)/i;
  const all = Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, MAX_ELEMENTS);
  for (const element of all) {
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    if (style.display === 'none') continue;
    const rect = element.getBoundingClientRect();
    const area = Math.max(0, Math.min(rect.right, view.width) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, view.height) - Math.max(rect.top, 0));
    const named = overlayWords.test(`${element.id} ${typeof element.className === 'string' ? element.className : ''} ${element.getAttribute('role') || ''} ${element.getAttribute('aria-label') || ''}`)
      || element.getAttribute('aria-modal') === 'true';
    const big = area >= viewArea * 0.3;
    if ((style.position === 'fixed' && (big || named)) || (style.position === 'sticky' && named && big)) {
      hide(element);
      overlays += 1;
    }
  }
  for (const root of [document.documentElement, document.body]) {
    if (!root) continue;
    root.style.setProperty('overflow', 'visible', 'important');
    root.style.setProperty('position', 'static', 'important');
  }

  /* 2. Texte caché. */
  const parseColor = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const backgroundOf = (element) => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const color = parseColor(window.getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.9) return color;
      if (window.getComputedStyle(node).backgroundImage !== 'none') return null;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const isHidden = (element) => {
    if (element.closest('[aria-hidden="true"], [hidden], [inert]')) return true;
    if (typeof element.checkVisibility === 'function'
      && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return true;
    const style = window.getComputedStyle(element);
    if (parseFloat(style.fontSize) < 1) return true;
    const rects = element.getClientRects();
    if (!rects.length) return true;
    let visible = false;
    for (const rect of rects) {
      if (rect.width <= 1 || rect.height <= 1) continue;
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      if (rect.right + scrollX <= 0 || rect.bottom + scrollY <= 0) continue;
      if (rect.left + scrollX >= Math.max(document.documentElement.scrollWidth, view.width) + 50) continue;
      visible = true;
      break;
    }
    if (!visible) return true;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const nodeStyle = node === element ? style : window.getComputedStyle(node);
      if (nodeStyle.clip && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(nodeStyle.clip)) return true;
      if (nodeStyle.clipPath && /inset\(\s*(50%|100%)/.test(nodeStyle.clipPath)) return true;
      if (nodeStyle.clipPath && /circle\(\s*0/.test(nodeStyle.clipPath)) return true;
      if (node !== element && nodeStyle.overflow !== 'visible') {
        const box = node.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1) return true;
      }
    }
    const color = parseColor(style.color);
    if (color && color.a < 0.1) return true;
    const textFill = parseColor(style.webkitTextFillColor);
    if (textFill && textFill.a < 0.1) return true;
    const background = backgroundOf(element);
    if (color && background && Math.abs(color.r - background.r) + Math.abs(color.g - background.g) + Math.abs(color.b - background.b) < 24) return true;
    return false;
  };
  const withText = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let steps = 0;
  for (let node = walker.nextNode(); node && steps < MAX_ELEMENTS * 4; node = walker.nextNode()) {
    steps += 1;
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const parent = node.parentElement;
    if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) continue;
    withText.add(parent);
  }
  const toHide = [];
  for (const element of withText) {
    if (element.closest('[data-astratra-hidden]')) continue;
    if (isHidden(element)) toHide.push(element);
  }
  for (const element of toHide) {
    hide(element);
    hidden += 1;
  }

  /* 3. Ce que la page montre. */
  let text = (document.body ? document.body.innerText : '') || '';
  text = text.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const textTruncated = text.length > MAX_TEXT;
  if (textTruncated) text = text.slice(0, MAX_TEXT);

  const links = [];
  const seen = new Set();
  for (const anchor of Array.from(document.querySelectorAll('a[href]')).slice(0, MAX_ELEMENTS)) {
    if (anchor.closest('[data-astratra-hidden]')) continue;
    let href;
    try {
      const url = new URL(anchor.href, document.baseURI);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      url.hash = '';
      href = url.href;
    } catch (_error) {
      continue;
    }
    if (seen.has(href)) continue;
    const label = (anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    if (isHidden(anchor)) continue;
    seen.add(href);
    links.push({ url: href, text: label.slice(0, 120) });
    if (links.length >= limits.maxLinksScanned) break;
  }

  const openSearch = Array.from(document.querySelectorAll('link[rel~="search"][href]'))
    .filter((link) => String(link.getAttribute('type') || '').toLowerCase().startsWith('application/opensearchdescription+xml'))
    .map((link) => link.href)
    .slice(0, 3);

  const forms = [];
  for (const form of Array.from(document.querySelectorAll('form')).slice(0, 20)) {
    const fields = [];
    for (const field of Array.from(form.elements).slice(0, 40)) {
      const tag = field.tagName;
      if (tag === 'INPUT') {
        const type = String(field.getAttribute('type') || '').toLowerCase();
        if (['submit', 'button', 'image', 'reset'].includes(type)) continue;
        fields.push({ name: field.name || '', type, value: type === 'hidden' || type === 'checkbox' || type === 'radio' ? field.value : '', checked: Boolean(field.checked) });
      } else if (tag === 'SELECT') {
        fields.push({ name: field.name || '', type: 'select', value: field.value });
      } else if (tag === 'TEXTAREA') {
        fields.push({ name: field.name || '', type: 'textarea', value: '' });
      }
    }
    forms.push({
      action: form.getAttribute('action') ? form.action : '',
      method: String(form.getAttribute('method') || 'get').toLowerCase(),
      searchRole: form.getAttribute('role') === 'search' || Boolean(form.closest('[role="search"], search')),
      fields
    });
  }

  return {
    title: (document.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    lang: document.documentElement.getAttribute('lang') || null,
    text,
    textTruncated,
    links,
    openSearch,
    forms,
    removed: { overlays, hidden }
  };
}

module.exports = { readRenderedPage };
