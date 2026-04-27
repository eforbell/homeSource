'use strict';

(function () {
  const STORAGE_KEY = 'source-theme';
  const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function getPreference() {
    return localStorage.getItem(STORAGE_KEY) || 'system';
  }

  function resolveTheme(preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    return themeMedia && themeMedia.matches ? 'light' : 'dark';
  }

  function themeColor(theme) {
    return theme === 'light' ? '#fef3c7' : '#0b0b0b';
  }

  function setThemeColorMeta(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeColor(theme));
  }

  function applyTheme(preference) {
    const resolvedTheme = resolveTheme(preference);
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-theme-preference', preference);
    setThemeColorMeta(resolvedTheme);
  }

  function setPreference(preference) {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
    applyTheme(getPreference());
  }

  window.SourceTheme = {
    getPreference,
    getResolvedTheme() {
      return document.documentElement.getAttribute('data-theme') || resolveTheme(getPreference());
    },
    setPreference,
    applyCurrentTheme() { applyTheme(getPreference()); }
  };

  if (themeMedia && typeof themeMedia.addEventListener === 'function') {
    themeMedia.addEventListener('change', () => {
      if (getPreference() === 'system') applyTheme('system');
    });
  }

  applyTheme(getPreference());
})();
