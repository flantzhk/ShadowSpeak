import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { captureReferralCode } from './profile.js';
import { trackEvent } from './analytics.js';

// Capture ?ref= parameter before anything else
captureReferralCode();

// Language picker shown on first launch (no language stored yet)
function LanguagePicker() {
  const pick = (lang) => {
    trackEvent('language_selected', { language: lang });
    localStorage.setItem('shadowspeak-lang', lang);
    window.location.reload(); // reload to load the chosen data file
  };

  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'#1F3329', padding:24, fontFamily:"'DM Sans',-apple-system,sans-serif"
    }}>
      <div style={{maxWidth:420, width:'100%', textAlign:'center'}}>
        <div style={{fontSize:40, marginBottom:12}}>🗣</div>
        <div style={{fontSize:28, fontWeight:900, color:'#fff', marginBottom:4}}>
          Shadow<span style={{color:'#C4F000'}}>Speak</span>
        </div>
        <div style={{fontSize:15, color:'rgba(255,255,255,.6)', marginBottom:32, lineHeight:1.5}}>
          Choose your language to get started.
        </div>

        <div style={{display:'flex', flexDirection:'column', gap:12, marginBottom:24}}>
          <button onClick={() => pick('canto')} style={{
            display:'flex', alignItems:'center', gap:16, padding:'20px 24px',
            background:'#fff', border:'2px solid #EDE8E0', borderRadius:16,
            cursor:'pointer', textAlign:'left', transition:'all .15s', fontFamily:'inherit'
          }}>
            <span style={{fontSize:'2rem'}}>🇭🇰</span>
            <div>
              <div style={{fontSize:17, fontWeight:800, color:'#1F3329'}}>Cantonese</div>
              <div style={{fontSize:22, fontWeight:800, color:'#2C2C2C', fontFamily:"'Noto Sans HK',sans-serif"}}>廣東話</div>
              <div style={{fontSize:13, color:'#7A756E', marginTop:2}}>85 million speakers</div>
            </div>
          </button>

          <button onClick={() => pick('mandarin')} style={{
            display:'flex', alignItems:'center', gap:16, padding:'20px 24px',
            background:'#fff', border:'2px solid #EDE8E0', borderRadius:16,
            cursor:'pointer', textAlign:'left', transition:'all .15s', fontFamily:'inherit'
          }}>
            <span style={{fontSize:'2rem'}}>🇨🇳</span>
            <div>
              <div style={{fontSize:17, fontWeight:800, color:'#1F3329'}}>Mandarin</div>
              <div style={{fontSize:22, fontWeight:800, color:'#2C2C2C', fontFamily:"'Noto Sans SC',sans-serif"}}>普通话</div>
              <div style={{fontSize:13, color:'#7A756E', marginTop:2}}>920 million speakers</div>
            </div>
          </button>
        </div>

        <div style={{fontSize:13, color:'rgba(255,255,255,.35)', lineHeight:1.5}}>
          More languages coming soon.
        </div>
      </div>
    </div>
  );
}

// Check stored language — URL param overrides for backward compat, but primary source is localStorage
const urlParams = new URLSearchParams(window.location.search);
const urlLang = urlParams.get('lang');
const storedLang = localStorage.getItem('shadowspeak-lang');

// If URL has ?lang=, store it and strip the param from URL
if (urlLang) {
  localStorage.setItem('shadowspeak-lang', urlLang);
  // Clean the URL (remove ?lang= param)
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('lang');
  window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.hash);
}

const lang = urlLang || storedLang; // null if neither exists (first launch)

async function loadApp() {
  const root = createRoot(document.getElementById('root'));

  // No language selected yet — show picker
  if (!lang) {
    root.render(React.createElement(LanguagePicker));
    return;
  }

  // Load the appropriate language data
  let LANG_CONFIG;
  if (lang === 'mandarin') {
    const mod = await import('./data-mandarin.js');
    LANG_CONFIG = mod.default;
  } else {
    const mod = await import('./data-canto.js');
    LANG_CONFIG = mod.default;
  }

  // Set global for compatibility with existing code
  window.LANG_CONFIG = LANG_CONFIG;

  // Now import and mount the app (after LANG_CONFIG is set)
  const { default: App, setLangConfig } = await import('./App.jsx');
  setLangConfig(LANG_CONFIG);

  root.render(React.createElement(App));
}

loadApp();
