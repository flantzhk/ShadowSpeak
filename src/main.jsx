import React from 'react';
import { createRoot } from 'react-dom/client';

// Determine language from URL param or localStorage
const urlParams = new URLSearchParams(window.location.search);
const lang = urlParams.get('lang') || localStorage.getItem('shadowspeak-lang') || 'canto';
localStorage.setItem('shadowspeak-lang', lang);

// Clean ?lang= from URL after reading it
if (urlParams.has('lang')) {
  const clean = new URL(window.location.href);
  clean.searchParams.delete('lang');
  window.history.replaceState({}, '', clean.pathname + clean.hash);
}

async function loadApp() {
  // 1. Load the language data first
  let LANG_CONFIG;
  if (lang === 'mandarin') {
    LANG_CONFIG = (await import('./data-mandarin.js')).default;
  } else {
    LANG_CONFIG = (await import('./data-canto.js')).default;
  }
  window.LANG_CONFIG = LANG_CONFIG;

  // 2. Now import App (it reads window.LANG_CONFIG at module init)
  const { default: App } = await import('./App.jsx');

  // 3. Mount
  const root = createRoot(document.getElementById('root'));
  root.render(React.createElement(App));
}

loadApp();
