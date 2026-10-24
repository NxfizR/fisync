// Language support for the phone page. Translations live in /i18n/<code>.json.
(() => {
  const LANGS = ['en', 'bg', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'ga', 'it',
    'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv'];
  let dict = {};

  const chooseLanguage = () => {
    const saved = localStorage.getItem('fisync.lang');
    if (LANGS.includes(saved)) return saved;
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const code = String(l).slice(0, 2).toLowerCase();
      if (LANGS.includes(code)) return code;
    }
    return 'en';
  };

  window.t = (key, vars) => {
    let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  };

  function applyText() {
    document.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(e => { e.placeholder = t(e.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-aria]').forEach(e => e.setAttribute('aria-label', t(e.dataset.i18nAria)));
  }

  async function load(lang) {
    try {
      const r = await fetch(`/i18n/${lang}.json`);
      dict = r.ok ? await r.json() : {};
    } catch (e) {
      dict = {};
    }
    document.documentElement.lang = lang;
    applyText();
  }

  window.setLanguage = lang => {
    if (!LANGS.includes(lang)) return;
    localStorage.setItem('fisync.lang', lang);
    load(lang);
  };

  const start = chooseLanguage();
  const sel = document.getElementById('lang');
  if (sel) {
    sel.value = start;
    sel.onchange = () => window.setLanguage(sel.value);
  }
  window.i18nReady = load(start);
})();
