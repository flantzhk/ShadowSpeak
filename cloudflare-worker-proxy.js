const ALLOWED_ORIGINS = [
  "https://flantzhk.github.io",
  "http://localhost",
  "http://127.0.0.1",
  "null",
];

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o)) || origin === "null";
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShadowSpeak — Pronunciation Score</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=Noto+Sans+HK:wght@400;700;900&display=swap" rel="stylesheet">
<style>
:root {
  --cream: #F5F2EE;
  --for: #1F3329;
  --lime: #C4F000;
  --ld: #7AAA00;
  --plum: #8F6AE8;
  --ink: #2C2C2C;
  --ink2: #5A554F;
  --ink3: #7A756E;
  --wh: #fff;
  --st: #EDE8E0;
  --coral: #F05A3A;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'DM Sans', sans-serif;
  background: var(--cream);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px;
}

/* Demo controls */
.demo-bar {
  display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; justify-content: center;
  max-width: 700px;
}
.demo-btn {
  padding: 10px 20px; border-radius: 999px; border: 2px solid var(--for);
  background: var(--wh); font-size: .75rem; font-weight: 700; cursor: pointer;
  color: var(--for); transition: all .15s;
}
.demo-btn:hover { background: var(--for); color: var(--lime); }
.demo-btn.active { background: var(--for); color: var(--lime); }

/* Score card container */
.score-card {
  width: 100%; max-width: 400px; background: var(--wh);
  border-radius: 24px; overflow: hidden; position: relative;
  box-shadow: 0 8px 40px rgba(0,0,0,.08);
}

/* Desktop layout */
@media (min-width: 768px) {
  body { padding: 40px; }
  .score-card {
    max-width: 600px;
  }
  .score-top { padding: 40px 32px 28px; }
  .ring-wrap { width: 160px; height: 160px; margin-bottom: 20px; }
  .ring-wrap svg { width: 160px; height: 160px; }
  .score-number { font-size: 2.8rem; }
  .result-label { font-size: .9rem; padding: 10px 24px; }
  .phrase-section { padding: 28px 32px; }
  .phrase-cn { font-size: 1.9rem; }
  .phrase-jy { font-size: .88rem; }
  .phrase-en { font-size: .8rem; }
  .jy-grid { gap: 10px; justify-content: center; }
  .jy-char { min-width: 64px; }
  .jy-char-cn { font-size: 1.5rem; }
  .jy-char-expected, .jy-char-yours { font-size: .72rem; padding: 5px 10px; }
  .actions { padding: 0 32px 28px; gap: 12px; }
  .act-btn { padding: 16px; font-size: .88rem; border-radius: 16px; }
  .streak-badge { margin: 0 32px 20px; font-size: .78rem; padding: 10px 20px; }
}

@media (min-width: 1024px) {
  .score-card {
    max-width: 680px;
    display: grid;
    grid-template-columns: 1fr;
  }
  .score-inner {
    display: grid;
    grid-template-columns: 280px 1fr;
  }
  .score-top {
    border-radius: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 320px;
  }
  .phrase-section { padding: 28px 32px; display: flex; flex-direction: column; justify-content: center; }
  .jy-grid { gap: 12px; }
  .jy-char { min-width: 70px; }
  .jy-char-cn { font-size: 1.6rem; }
  .actions-row { padding: 0 32px 28px; }
}

/* Top band — changes color based on result */
.score-top {
  padding: 32px 24px 24px; text-align: center; position: relative; overflow: hidden;
  transition: background .4s;
}
.score-top.perfect { background: var(--for); }
.score-top.good { background: #1a3a2a; }
.score-top.try-again { background: #3a2020; }

/* Animated ring */
.ring-wrap {
  width: 140px; height: 140px; margin: 0 auto 16px; position: relative;
}
.ring-wrap svg {
  width: 100%; height: 100%;
}
.ring-bg {
  fill: none; stroke: rgba(255,255,255,.1); stroke-width: 8;
}
.ring-fill {
  fill: none; stroke-width: 8; stroke-linecap: round;
  transition: stroke-dashoffset 1s cubic-bezier(.4,0,.2,1), stroke .3s;
  transform: rotate(-90deg); transform-origin: center;
}
.ring-fill.perfect { stroke: var(--lime); }
.ring-fill.good { stroke: #7AAA00; }
.ring-fill.try-again { stroke: var(--coral); }

.score-number {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  font-size: 2.4rem; font-weight: 900; color: #fff;
  opacity: 0; transition: opacity .3s .6s;
}
.score-number.show { opacity: 1; }
.score-percent {
  font-size: 1rem; font-weight: 600; opacity: .5;
}

/* Result label */
.result-label {
  font-size: .85rem; font-weight: 800; letter-spacing: .5px;
  padding: 8px 20px; border-radius: 999px; display: inline-block;
  margin-top: 4px; opacity: 0; transform: translateY(10px);
  transition: all .3s .8s;
}
.result-label.show { opacity: 1; transform: translateY(0); }
.result-label.perfect { background: rgba(196,240,0,.15); color: var(--lime); }
.result-label.good { background: rgba(122,170,0,.15); color: #9dcc33; }
.result-label.try-again { background: rgba(240,90,58,.15); color: #ff7a5c; }

/* Particle explosion */
.particles {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  pointer-events: none; overflow: hidden;
}
.particle {
  position: absolute; border-radius: 50%;
  animation: particle-burst 1s cubic-bezier(.2,.8,.3,1) forwards;
  opacity: 0;
}
@keyframes particle-burst {
  0% { transform: translate(0,0) scale(0); opacity: 1; }
  50% { opacity: 1; }
  100% { opacity: 0; }
}

/* Phrase display */
.phrase-section {
  padding: 20px 24px;
}
.phrase-label {
  font-size: .65rem; font-weight: 700; color: var(--ink3);
  text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;
}
.phrase-cn {
  font-family: 'Noto Sans HK', sans-serif; font-size: 1.6rem;
  font-weight: 900; color: var(--ink); margin-bottom: 4px;
}
.phrase-jy {
  font-size: .82rem; color: var(--plum); font-weight: 600;
  font-style: italic; margin-bottom: 4px;
}
.phrase-en {
  font-size: .75rem; color: var(--ink3); margin-bottom: 16px;
}

/* Jyutping comparison grid */
.jy-grid {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px;
}
.jy-char {
  flex: 0 0 auto; text-align: center; min-width: 52px;
  opacity: 0; transform: translateY(8px);
  animation: jy-reveal .3s forwards;
}
@keyframes jy-reveal {
  to { opacity: 1; transform: translateY(0); }
}
.jy-char-cn {
  font-family: 'Noto Sans HK', sans-serif; font-size: 1.3rem;
  font-weight: 700; color: var(--ink); margin-bottom: 4px;
  cursor: pointer; transition: transform .1s;
}
.jy-char-cn:hover { transform: scale(1.1); }
.jy-char-cn:active { transform: scale(0.95); }
.jy-char-expected, .jy-char-yours {
  font-size: .68rem; font-weight: 700; padding: 4px 8px;
  border-radius: 8px; margin-bottom: 2px; cursor: pointer;
  transition: transform .1s, box-shadow .15s;
  position: relative;
}
.jy-char-expected:hover, .jy-char-yours:hover {
  transform: scale(1.05);
}
.jy-char-expected:active, .jy-char-yours:active {
  transform: scale(0.95);
}
.jy-char-expected::before, .jy-char-yours::before {
  content: '🔊 '; font-size: .55rem;
}
.jy-char-expected.playing, .jy-char-yours.playing {
  box-shadow: 0 0 0 2px var(--plum);
}
.jy-char-expected {
  background: rgba(143,106,232,.08); color: var(--plum);
}
.jy-char-yours.match {
  background: rgba(196,240,0,.12); color: var(--ld);
  border: 1.5px solid rgba(196,240,0,.3);
}
.jy-char-yours.mismatch {
  background: rgba(240,90,58,.1); color: var(--coral);
  border: 1.5px solid rgba(240,90,58,.25);
}
.jy-char-label {
  font-size: .55rem; color: var(--ink3); font-weight: 600;
  text-transform: uppercase; letter-spacing: .5px; margin-bottom: 2px;
}

/* Action buttons */
.actions {
  padding: 0 24px 24px; display: flex; gap: 10px;
}
.act-btn {
  flex: 1; padding: 14px; border-radius: 14px; border: none;
  font-size: .82rem; font-weight: 800; cursor: pointer;
  transition: transform .1s;
}
.act-btn:active { transform: scale(.97); }
.act-primary {
  background: var(--for); color: var(--lime);
}
.act-secondary {
  background: var(--st); color: var(--ink);
}

/* Streak badge */
.streak-badge {
  display: flex; align-items: center; gap: 6px; justify-content: center;
  padding: 8px 16px; margin: 0 24px 16px; border-radius: 12px;
  background: rgba(196,240,0,.08); border: 1px solid rgba(196,240,0,.15);
  font-size: .72rem; font-weight: 700; color: var(--ld);
  opacity: 0; transform: translateY(8px);
  transition: all .3s 1.2s;
}
.streak-badge.show { opacity: 1; transform: translateY(0); }

/* Screen shake for try-again */
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-6px); }
  40% { transform: translateX(6px); }
  60% { transform: translateX(-4px); }
  80% { transform: translateX(4px); }
}
.shake { animation: shake .4s .5s; }

/* Glow pulse for perfect */
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(196,240,0,0); }
  50% { box-shadow: 0 0 40px 10px rgba(196,240,0,.2); }
}
.glow { animation: glow-pulse 1.5s .5s; }
</style>
</head>
<body>

<div class="demo-bar">
  <button class="demo-btn active" onclick="showScore('perfect')">100% Perfect</button>
  <button class="demo-btn" onclick="showScore('good')">78% Good</button>
  <button class="demo-btn" onclick="showScore('try-again')">42% Try Again</button>
  <button class="demo-btn" onclick="showScore('close')">88% Almost</button>
</div>

<div class="score-card" id="score-card">
  <!-- Filled by JS -->
</div>

<script>
// Sound generation using Web Audio API
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSuccessSound() {
  // Ascending chime: C5 → E5 → G5 → C6
  const notes = [523.25, 659.25, 783.99, 1046.50];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, audioCtx.currentTime + i * 0.12);
    gain.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + i * 0.12 + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + i * 0.12 + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + i * 0.12);
    osc.stop(audioCtx.currentTime + i * 0.12 + 0.5);
  });
}

function playPerfectSound() {
  // Sparkly ascending arpeggio with harmonics
  const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc2.type = 'triangle';
    osc.frequency.value = freq;
    osc2.frequency.value = freq * 2;
    gain.gain.setValueAtTime(0, audioCtx.currentTime + i * 0.1);
    gain.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + i * 0.1 + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + i * 0.1 + 0.6);
    osc.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + i * 0.1);
    osc.stop(audioCtx.currentTime + i * 0.1 + 0.6);
    osc2.start(audioCtx.currentTime + i * 0.1);
    osc2.stop(audioCtx.currentTime + i * 0.1 + 0.6);
  });
}

function playTryAgainSound() {
  // Gentle descending two-note
  const notes = [392, 330];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, audioCtx.currentTime + i * 0.2);
    gain.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + i * 0.2 + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + i * 0.2 + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + i * 0.2);
    osc.stop(audioCtx.currentTime + i * 0.2 + 0.4);
  });
}

function playGoodSound() {
  // Pleasant two-note rise
  const notes = [440, 554.37];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, audioCtx.currentTime + i * 0.15);
    gain.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + i * 0.15 + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + i * 0.15 + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + i * 0.15);
    osc.stop(audioCtx.currentTime + i * 0.15 + 0.5);
  });
}

// Particle explosion
function createParticles(container, type) {
  const colors = type === 'perfect' ? ['#C4F000','#7AAA00','#fff','#8F6AE8']
    : type === 'good' ? ['#C4F000','#7AAA00','#9dcc33']
    : [];
  if (colors.length === 0) return;

  for (let i = 0; i < (type === 'perfect' ? 40 : 20); i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 8 + 4;
    const angle = (Math.PI * 2 * i) / (type === 'perfect' ? 40 : 20);
    const dist = Math.random() * 120 + 60;
    const color = colors[Math.floor(Math.random() * colors.length)];
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.background = color;
    p.style.left = '50%';
    p.style.top = '45%';
    p.style.animationDelay = (Math.random() * 0.3) + 's';
    p.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
    p.style.setProperty('--ty', Math.sin(angle) * dist + 'px');
    // Override animation with custom endpoint
    p.style.animation = 'none';
    p.offsetHeight; // trigger reflow
    p.style.animation = \`particle-fly \${0.6 + Math.random() * 0.4}s cubic-bezier(.2,.8,.3,1) \${Math.random() * 0.2}s forwards\`;
    container.appendChild(p);
    setTimeout(() => p.remove(), 1500);
  }

  // Add keyframes for this batch
  if (!document.getElementById('particle-fly-style')) {
    const style = document.createElement('style');
    style.id = 'particle-fly-style';
    style.textContent = \`
      @keyframes particle-fly {
        0% { transform: translate(-50%,-50%) scale(0); opacity: 1; }
        30% { opacity: 1; transform: translate(calc(-50% + var(--tx) * 0.5), calc(-50% + var(--ty) * 0.5)) scale(1); }
        100% { opacity: 0; transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0.3); }
      }
    \`;
    document.head.appendChild(style);
  }
}

// Jyutping-to-character TTS via Google Translate
let _ttsAudio = null;
function playCantoTTS(text) {
  if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
  const url = \`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=yue&q=\${encodeURIComponent(text)}\`;
  _ttsAudio = new Audio(url);
  _ttsAudio.play().catch(e => console.warn("TTS failed:", e));
  return _ttsAudio;
}

// Play a character's correct or "yours" pronunciation
// For "yours" we construct the character sound from what was heard
// Both use Google TTS with the Chinese character
function playExpected(cn, el) {
  document.querySelectorAll('.playing').forEach(e => e.classList.remove('playing'));
  el.classList.add('playing');
  const audio = playCantoTTS(cn);
  if (audio) audio.onended = () => el.classList.remove('playing');
  setTimeout(() => el.classList.remove('playing'), 2000);
}

// For "yours" — we need to approximate what was said
// Since jyutping like "go2" maps to a real character/sound, 
// we use a lookup of common jyutping→character for playback
const JY_TO_CHAR = {
  'bin2':'便','go2':'個','gung1':'公','si3':'試','gu2':'古','lei4':'嚟',
  'nei5':'你','hou2':'好','m4':'唔','goi1':'該','zou2':'早','san4':'晨',
  'sai2':'使','haak3':'客','hei3':'氣','zyu6':'住','hai2':'喺',
  'bin1':'邊','dou6':'度','ho2':'可','ji5':'以','zoi3':'再',
  'gong2':'講','jat1':'一','ci3':'次',
};

function playYours(jyutping, el) {
  document.querySelectorAll('.playing').forEach(e => e.classList.remove('playing'));
  el.classList.add('playing');
  // Try to find a character for this jyutping, otherwise just play the original
  const char = JY_TO_CHAR[jyutping];
  const audio = playCantoTTS(char || jyutping);
  if (audio) audio.onended = () => el.classList.remove('playing');
  setTimeout(() => el.classList.remove('playing'), 2000);
}

// Score scenarios
const scenarios = {
  perfect: {
    score: 100,
    type: 'perfect',
    label: 'Perfect pronunciation!',
    phrase: { cn: '唔使客氣', jy: 'm4 sai2 haak3 hei3', en: "You're welcome, no need to be polite" },
    chars: [
      { cn: '唔', expected: 'm4', yours: 'm4', match: true },
      { cn: '使', expected: 'sai2', yours: 'sai2', match: true },
      { cn: '客', expected: 'haak3', yours: 'haak3', match: true },
      { cn: '氣', expected: 'hei3', yours: 'hei3', match: true },
    ],
    streak: 5,
  },
  good: {
    score: 78,
    type: 'good',
    label: 'Good effort! Almost there.',
    phrase: { cn: '你住喺邊度', jy: 'nei5 zyu6 hai2 bin1 dou6', en: 'Where do you live?' },
    chars: [
      { cn: '你', expected: 'nei5', yours: 'nei5', match: true },
      { cn: '住', expected: 'zyu6', yours: 'zyu6', match: true },
      { cn: '喺', expected: 'hai2', yours: 'hai2', match: true },
      { cn: '邊', expected: 'bin1', yours: 'bin2', match: false },
      { cn: '度', expected: 'dou6', yours: 'dou6', match: true },
    ],
    streak: 0,
  },
  close: {
    score: 88,
    type: 'good',
    label: 'So close! Great tones.',
    phrase: { cn: '早晨', jy: 'zou2 san4', en: 'Good morning!' },
    chars: [
      { cn: '早', expected: 'zou2', yours: 'zou2', match: true },
      { cn: '晨', expected: 'san4', yours: 'san4', match: true },
    ],
    streak: 3,
  },
  'try-again': {
    score: 42,
    type: 'try-again',
    label: 'Keep practicing! You got this.',
    phrase: { cn: '可唔可以再講一次', jy: 'ho2 m4 ho2 ji5 zoi3 gong2 jat1 ci3', en: 'Can you say that again?' },
    chars: [
      { cn: '可', expected: 'ho2', yours: 'ho2', match: true },
      { cn: '唔', expected: 'm4', yours: 'm4', match: true },
      { cn: '可', expected: 'ho2', yours: 'go2', match: false },
      { cn: '以', expected: 'ji5', yours: 'ji5', match: true },
      { cn: '再', expected: 'zoi3', yours: 'zoi3', match: true },
      { cn: '講', expected: 'gong2', yours: 'gung1', match: false },
      { cn: '一', expected: 'jat1', yours: 'jat1', match: true },
      { cn: '次', expected: 'ci3', yours: 'si3', match: false },
    ],
    streak: 0,
  },
};

function showScore(key) {
  // Update demo buttons
  document.querySelectorAll('.demo-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');

  const s = scenarios[key];
  const card = document.getElementById('score-card');
  const circumference = 2 * Math.PI * 58;
  const offset = circumference - (s.score / 100) * circumference;

  card.innerHTML = \`
    <div class="score-inner">
      <div class="score-top \${s.type}" id="score-top">
        <div class="particles" id="particles"></div>
        <div class="ring-wrap">
          <svg viewBox="0 0 140 140">
            <circle class="ring-bg" cx="70" cy="70" r="58" />
            <circle class="ring-fill \${s.type}" cx="70" cy="70" r="58"
              stroke-dasharray="\${circumference}"
              stroke-dashoffset="\${circumference}"
              id="ring-fill" />
          </svg>
          <div class="score-number" id="score-num">
            <span id="score-val">0</span><span class="score-percent">%</span>
          </div>
        </div>
        <div class="result-label \${s.type}" id="result-label">\${s.label}</div>
      </div>

      <div>
        <div class="phrase-section">
          <div class="phrase-cn">\${s.phrase.cn}</div>
          <div class="phrase-jy">\${s.phrase.jy}</div>
          <div class="phrase-en">\${s.phrase.en}</div>

          <div class="phrase-label">Your pronunciation <span style="font-size:.55rem;font-weight:500;text-transform:none;letter-spacing:0;color:var(--ink3)">(tap to hear)</span></div>
          <div class="jy-grid" id="jy-grid">
            \${s.chars.map((c, i) => \`
              <div class="jy-char" style="animation-delay: \${0.8 + i * 0.1}s">
                <div class="jy-char-cn" onclick="playExpected('\${c.cn}', this)" title="Tap to hear">\${c.cn}</div>
                <div class="jy-char-label">expected</div>
                <div class="jy-char-expected" onclick="playExpected('\${c.cn}', this)" title="Tap to hear correct pronunciation">\${c.expected}</div>
                <div class="jy-char-label">yours</div>
                <div class="jy-char-yours \${c.match ? 'match' : 'mismatch'}" onclick="playYours('\${c.yours}', this)" title="Tap to hear what you said">\${c.yours}</div>
              </div>
            \`).join('')}
          </div>
        </div>

        \${s.streak > 0 ? \`<div class="streak-badge" id="streak-badge">🔥 \${s.streak} in a row!</div>\` : ''}

        <div class="actions">
          <button class="act-btn act-secondary" onclick="showScore('\${key}')">🔄 Try again</button>
          <button class="act-btn act-primary">\${s.score >= 70 ? '→ Next phrase' : '👂 Listen again'}</button>
        </div>
      </div>
    </div>
  \`;

  // Animate ring
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const ring = document.getElementById('ring-fill');
      ring.style.strokeDashoffset = offset;

      // Animate number count-up
      const numEl = document.getElementById('score-val');
      const scoreNum = document.getElementById('score-num');
      scoreNum.classList.add('show');
      let current = 0;
      const step = Math.max(1, Math.floor(s.score / 30));
      const counter = setInterval(() => {
        current = Math.min(current + step, s.score);
        numEl.textContent = current;
        if (current >= s.score) {
          clearInterval(counter);
          numEl.textContent = s.score;
        }
      }, 30);

      // Show label
      setTimeout(() => {
        document.getElementById('result-label').classList.add('show');
      }, 100);

      // Show streak badge
      if (s.streak > 0) {
        setTimeout(() => {
          const badge = document.getElementById('streak-badge');
          if (badge) badge.classList.add('show');
        }, 100);
      }

      // Sound + effects
      setTimeout(() => {
        if (s.type === 'perfect') {
          playPerfectSound();
          createParticles(document.getElementById('particles'), 'perfect');
          card.classList.add('glow');
          setTimeout(() => card.classList.remove('glow'), 2000);
        } else if (s.type === 'good' && s.score >= 70) {
          playGoodSound();
          createParticles(document.getElementById('particles'), 'good');
        } else {
          playTryAgainSound();
          card.classList.add('shake');
          setTimeout(() => card.classList.remove('shake'), 1000);
        }
      }, 700);
    });
  });
}

// Show perfect by default
showScore('perfect');
</script>
</body>
</html>
`;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Serve demo page on GET /demo
    if (request.method === "GET" && (path === "/demo" || path === "/demo/")) {
      return new Response(DEMO_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only (or GET /demo)" }), {
        status: 405, headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      });
    }

    try {
      if (path === "/tts") {
        const body = await request.json();
        body.api_key = env.CANTONESE_AI_KEY;
        const res = await fetch("https://cantonese.ai/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const contentType = res.headers.get("Content-Type") || "audio/wav";
        const audioData = await res.arrayBuffer();
        return new Response(audioData, {
          status: res.status,
          headers: { ...corsHeaders(request), "Content-Type": contentType },
        });
      }

      if (path === "/score") {
        const formData = await request.formData();
        const newForm = new FormData();
        newForm.append("api_key", env.CANTONESE_AI_KEY);
        newForm.append("text", formData.get("text"));
        newForm.append("language", formData.get("language") || "cantonese");
        newForm.append("audio", formData.get("audio"));
        const res = await fetch("https://cantonese.ai/api/score-pronunciation", {
          method: "POST",
          body: newForm,
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      if (path === "/elevenlabs/tts") {
        const body = await request.json();
        const voiceId = body.voice_id;
        delete body.voice_id;
        if (!voiceId) {
          return new Response(JSON.stringify({ error: "voice_id required" }), {
            status: 400, headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": env.ELEVENLABS_KEY },
          body: JSON.stringify({
            text: body.text,
            model_id: body.model_id || "eleven_multilingual_v2",
            voice_settings: body.voice_settings || { stability: 0.5, similarity_boost: 0.75, style: 0.0 },
          }),
        });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: "ElevenLabs error: " + res.status }), {
            status: res.status, headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const audioData = await res.arrayBuffer();
        return new Response(audioData, {
          status: 200, headers: { ...corsHeaders(request), "Content-Type": "audio/mpeg" },
        });
      }

      return new Response(JSON.stringify({ error: "Unknown endpoint", available: ["/tts", "/score", "/elevenlabs/tts", "GET /demo"] }), {
        status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      });
    }
  },
};
