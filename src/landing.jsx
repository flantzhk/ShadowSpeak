import { firebase, fbAuth } from './firebase.js';
import { captureReferralCode, ensureUserProfile } from './profile.js';

// Capture ?ref= parameter on landing page load
captureReferralCode();

// ---- Landing page logic (extracted from index.html) ----

const G_ICON = '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';
const G_DARK = G_ICON.replace(/currentColor/g, '#1F3329');

let currentUser = null;
let pendingRedirect = null;

// Register Service Worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then(reg => {
      console.log("SW registered:", reg.scope);
    }).catch(err => console.warn("SW registration failed:", err));
  });
}

function render() {
  const app = document.getElementById('app');
  const signedIn = !!currentUser;
  const photo = currentUser?.photoURL || '';
  const name = currentUser?.displayName || 'Learner';
  const firstName = name.split(' ')[0];
  const lastLang = localStorage.getItem('shadowspeak-last-lang');
  const lastLangName = lastLang === 'canto' ? 'Cantonese' : lastLang === 'mandarin' ? 'Mandarin' : null;

  app.innerHTML = `
    <div class="nav">
      <div class="nav-logo">
        <span class="nav-logo-icon">🗣</span>
        <span class="nav-logo-text">Shadow<span>Speak</span></span>
      </div>
      <div class="nav-right">
        ${signedIn ? `
          <img class="user-avatar" src="${photo}" alt="" referrerpolicy="no-referrer" style="width:32px;height:32px;" />
          <button class="nav-login" onclick="doSignOut()">Sign out</button>
        ` : `
          <button class="nav-login" onclick="doSignIn()">Log in</button>
          <button class="nav-signup" onclick="doSignIn()">
            <span style="color:var(--for);display:flex">${G_DARK}</span>
            <span>Sign up</span>
          </button>
        `}
      </div>
    </div>

    <div class="hero">
      ${signedIn ? `
        <div class="user-bar">
          <img class="user-avatar" src="${photo}" alt="" referrerpolicy="no-referrer" />
          <span class="user-name">Welcome back, ${firstName}</span>
        </div>
        ${lastLangName ? `
          <div style="margin-bottom:20px;">
            <button class="cta-btn" onclick="goTo('${lastLang}')">
              <span>Continue ${lastLangName} →</span>
            </button>
          </div>
          <div style="font-size:14px;color:rgba(255,255,255,.45);margin-bottom:8px;">or choose below</div>
        ` : ''}
      ` : `
        <div class="hero-pill"><span>Language through speaking</span></div>
      `}
      <div class="hero-title">Shadow<span>Speak</span></div>
      <div class="hero-sub">You don't learn a language by reading it.<br/>You learn it by <strong>hearing it and saying it back.</strong></div>
      ${signedIn ? '' : `
        <button class="cta-btn" onclick="doSignIn()">
          <span style="color:var(--for);display:flex">${G_DARK}</span>
          <span>Get started free</span>
        </button>
        <div class="hero-sync">Progress syncs across all your devices.</div>
      `}
    </div>

    <div class="cream">
      <div class="cream-inner">
        <div class="method-header">
          <div class="section-label">The method</div>
          <div class="method-title">Shadowing is how polyglots<br/>actually learn languages.</div>
          <div class="method-desc">You hear a phrase in your target language, then immediately repeat it out loud. No grammar tables. No flashcard grinding. Your mouth and your ear learn together, the way children do.</div>
        </div>

        <div class="steps">
          <div class="step">
            <div class="step-icon">👂</div>
            <div>
              <div class="step-name">Listen</div>
              <div class="step-desc">You hear a real phrase. Your brain starts mapping the sounds, the rhythm, the tone patterns.</div>
            </div>
          </div>
          <div class="step">
            <div class="step-icon">🗣</div>
            <div>
              <div class="step-name">Say it out loud</div>
              <div class="step-desc">You repeat it immediately. Even whispering is 3x more effective than listening alone. Your mouth needs to learn the shapes.</div>
            </div>
          </div>
          <div class="step">
            <div class="step-icon">🔁</div>
            <div>
              <div class="step-name">Repeat and layer</div>
              <div class="step-desc">Each 30-minute lesson takes you through 6 phases: warm up, learn, drill, review, quiz, wind down. Phrases build on each other.</div>
            </div>
          </div>
          <div class="step">
            <div class="step-icon">🧠</div>
            <div>
              <div class="step-name">It sticks</div>
              <div class="step-desc">Shadowing activates motor memory, not just recall. You don't just recognise the words. You can actually say them when you need to.</div>
            </div>
          </div>
        </div>

        <div class="lang-header">
          <div class="section-label">Choose your language</div>
        </div>

        <div class="lang-cards">
          <div class="lang-card" onclick="pickLang('canto')">
            <div class="lang-flag">🇭🇰</div>
            <div class="lang-name">Cantonese</div>
            <div class="lang-native" style="font-family:'Noto Sans HK',sans-serif">廣東話</div>
            <div class="lang-stats">85 million speakers.<br/>11 units. 374 phrases.</div>
            ${signedIn ? '<div class="lang-badge">Start speaking</div>' : '<div class="signin-badge">Sign in to start →</div>'}
          </div>
          <div class="lang-card" onclick="pickLang('mandarin')">
            <div class="lang-flag">🇨🇳</div>
            <div class="lang-name">Mandarin</div>
            <div class="lang-native" style="font-family:'Noto Sans SC',sans-serif">普通话</div>
            <div class="lang-stats">920 million speakers.<br/>11 units. 370 phrases.</div>
            ${signedIn ? '<div class="lang-badge">Start speaking</div>' : '<div class="signin-badge">Sign in to start →</div>'}
          </div>
        </div>

        <div class="bottom-cta">
          <div class="bottom-cta-title">30 minutes a day.</div>
          <div class="bottom-cta-desc">That's all it takes. One lesson a day rewires your brain for a new language. Shadowing does more in 30 minutes than most apps do in an hour.</div>
          ${signedIn ? '' : `
            <button class="cta-btn small" onclick="doSignIn()">
              <span style="color:var(--for);display:flex">${G_DARK}</span>
              <span>Start learning now</span>
            </button>
            <div class="bottom-login">
              <span>Already have an account? </span>
              <a onclick="doSignIn()">Log in</a>
            </div>
          `}
        </div>

        <div class="footer">Built in Hong Kong.</div>
      </div>
    </div>
  `;
}

// Sign in with Google
window.doSignIn = function() {
  const provider = new firebase.auth.GoogleAuthProvider();
  fbAuth.signInWithPopup(provider).catch(err => {
    console.error('Sign-in error:', err);
  });
};

// Sign out
window.doSignOut = function() {
  fbAuth.signOut();
};

// Pick a language
window.pickLang = function(lang) {
  if (currentUser) {
    window.goTo(lang);
  } else {
    pendingRedirect = lang;
    window.doSignIn();
  }
};

// Navigate to app — store language choice and go to app page
window.goTo = function(lang) {
  localStorage.setItem('shadowspeak-lang', lang);
  localStorage.setItem('shadowspeak-last-lang', lang);
  window.location.href = 'app.html';
};

// Auth state listener
fbAuth.onAuthStateChanged(user => {
  const wasSignedOut = !currentUser;
  currentUser = user;

  // Create/update user profile on sign-in
  if (user) ensureUserProfile(user);

  render();

  if (user && wasSignedOut && pendingRedirect) {
    const dest = pendingRedirect;
    pendingRedirect = null;
    window.goTo(dest);
  }
});
