// Shows the app in the chosen language. English is the source: whatever has no translation stays English.
// Screen text is translated as it appears, so the rest of the app, errors from the wallet included, only deals in English.
(() => {
  const LANGUAGES: [string, string][] = [['en', 'English'], ['ko', '한국어'], ['ja', '日本語'], ['zh-CN', '简体中文'], ['vi', 'Tiếng Việt'], ['pt', 'Português'], ['tr', 'Türkçe'], ['uk', 'Українська'], ['ru', 'Русский']];
  const KEY = 'kusari.language';
  const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
  const LOCALES: Record<string, Record<string, string>> = (window as any).__LOCALES ?? {};
  type Pattern = { match: RegExp; text: string };
  const patterns = new Map<string, Pattern[]>();
  type Seen = { source: string; shown: string };
  const originals = new WeakMap<Node, Seen>();
  const originalAttrs = new WeakMap<Element, Record<string, Seen>>();

  function detect(): string {
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* not available here */ }
    if (saved && LANGUAGES.some(([code]) => code === saved)) return saved;
    return 'en';
  }

  let language = detect();

  function patternsFor(code: string): Pattern[] {
    let list = patterns.get(code);
    if (list) return list;
    list = Object.entries(LOCALES[code] ?? {}).filter(([source]) => /\{\d\}/.test(source) && source.replace(/\{\d\}/g, '').replace(/[^\p{L}]/gu, '').length >= 4)
      .sort((a, b) => b[0].length - a[0].length)
      .map(([source, text]) => {
        const order = [...source.matchAll(/\{(\d)\}/g)].map((m) => m[1]);
        const body = source.split(/\{\d\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*?)');
        return { match: new RegExp(`^${body}$`, 's'), text: order.reduce((t, n, i) => t.split(`{${n}}`).join(`\u0000${i}\u0000`), text) };
      });
    patterns.set(code, list);
    return list;
  }

  function translate(text: string): string {
    if (language === 'en') return text;
    const dictionary = LOCALES[language];
    if (!dictionary) return text;
    const clean = text.trim();
    if (!clean || !/\p{L}/u.test(clean)) return text;
    const whole = dictionary[clean];
    const done = whole ?? (() => {
      for (const p of patternsFor(language)) {
        const m = clean.match(p.match);
        // What fills a gap may be text too, such as the reason inside a longer message.
        if (m) return p.text.replace(/\u0000(\d)\u0000/g, (_, i) => translate(m[Number(i) + 1]));
      }
      return null;
    })();
    if (done === null) return text;
    return text.replace(clean, () => done);
  }

  const skipped = (el: Element | null) => Boolean(el?.closest('script, style, textarea, input, .addr-check, code, [data-no-translate]'));

  function paintText(node: Node): void {
    if (skipped(node.parentElement)) return;
    const shown = node.nodeValue ?? '';
    const known = originals.get(node);
    // Text changed by the app since the last visit is the new original.
    const source = known?.shown === shown ? known.source : shown;
    const text = translate(source);
    originals.set(node, { source, shown: text });
    if (text !== shown) node.nodeValue = text;
  }

  function paintAttributes(el: Element): void {
    if (el.closest('script, style')) return;
    const kept = originalAttrs.get(el) ?? {};
    for (const name of ATTRIBUTES) {
      const shown = el.getAttribute(name);
      if (shown === null) continue;
      const source = kept[name]?.shown === shown ? kept[name].source : shown;
      const text = translate(source);
      kept[name] = { source, shown: text };
      if (text !== shown) el.setAttribute(name, text);
    }
    originalAttrs.set(el, kept);
  }

  function paint(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) { paintText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    paintAttributes(root as Element);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) paintText(n); else paintAttributes(n as Element);
    }
  }

  const observer = new MutationObserver((changes) => {
    for (const c of changes) {
      if (c.type === 'characterData') paintText(c.target);
      else if (c.type === 'attributes') paintAttributes(c.target as Element);
      else c.addedNodes.forEach(paint);
    }
    observer.takeRecords();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  document.documentElement.lang = language;

  let offered = LANGUAGES;
  (window as any).kusariI18n = {
    get languages() { return offered; },
    /** Offers only these languages (the developer build: English and Korean); any other choice goes back to English. */
    only(codes: string[]) {
      offered = LANGUAGES.filter(([c]) => codes.includes(c));
      if (!offered.some(([c]) => c === language)) (window as any).kusariI18n.set('en');
    },
    current: () => language,
    /** One string in the current language, for text shown outside the page (an Android notification). */
    t: (text: string) => translate(text),
    set(code: string) {
      if (!offered.some(([c]) => c === code)) return;
      language = code;
      try { localStorage.setItem(KEY, code); } catch { /* it just won't be remembered */ }
      document.documentElement.lang = code;
      paint(document.documentElement);
      observer.takeRecords();
    },
  };
})();
