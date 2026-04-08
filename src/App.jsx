import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { firebase, fbAuth, fbDb } from './firebase.js';
import { ensureUserProfile } from './profile.js';
import { Capacitor } from '@capacitor/core';
import { trackEvent } from './analytics.js';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { StatusBar, Style as StatusBarStyle } from '@capacitor/status-bar';

// ---- CAPACITOR SETUP ----
if (Capacitor.isNativePlatform()) {
  StatusBar.setStyle({ style: StatusBarStyle.Dark }).catch(() => {});
}

function hapticLight() {
  if (Capacitor.isNativePlatform()) {
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  }
}

// LANG_CONFIG is set by main.jsx before this module loads
// It's passed as a prop to avoid import order issues
let LANG_CONFIG = window.LANG_CONFIG;

// ============================================================
// SHADOWSPEAK — v3.9.5 with Firebase Auth + Firestore Sync
// ============================================================

export function setLangConfig(config) {
  LANG_CONFIG = config;
  window.LANG_CONFIG = config; // keep global for compatibility
}

// ---- OFFLINE DETECTION ----
let _isOnline = navigator.onLine;
const _onlineListeners = new Set();
function onOnlineChange(fn) { _onlineListeners.add(fn); return () => _onlineListeners.delete(fn); }
window.addEventListener("online", () => { _isOnline = true; _onlineListeners.forEach(fn => fn(true)); });
window.addEventListener("offline", () => { _isOnline = false; _onlineListeners.forEach(fn => fn(false)); });

// ---- SERVICE WORKER REGISTRATION ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const swBase = import.meta.env.BASE_URL || '/ShadowSpeak/';
    navigator.serviceWorker.register(swBase + "sw.js").then(reg => {
      console.log("SW registered:", reg.scope);
    }).catch(err => console.warn("SW registration failed:", err));
  });
}

// ---- AUDIO MANIFEST (maps text -> local MP3 path) ----
let _audioManifest = null;
let _audioManifestLoading = false;
async function loadAudioManifest() {
  if (_audioManifest) return _audioManifest;
  if (_audioManifestLoading) {
    // Wait for in-progress load
    return new Promise(resolve => {
      const check = setInterval(() => { if (_audioManifest) { clearInterval(check); resolve(_audioManifest); } }, 100);
      setTimeout(() => { clearInterval(check); resolve(null); }, 5000);
    });
  }
  _audioManifestLoading = true;
  try {
    const base = import.meta.env.BASE_URL || '/ShadowSpeak/';
    const res = await fetch(base + "audio/manifest.json");
    if (res.ok) {
      _audioManifest = await res.json();
      console.log("Audio manifest loaded");
    }
  } catch(e) { console.warn("Audio manifest not available:", e.message); }
  _audioManifestLoading = false;
  return _audioManifest;
}
// Start loading manifest immediately
loadAudioManifest();

// Play a local MP3 file, returns a Promise
function playLocalAudio(url) {
  return new Promise((resolve, reject) => {
    stopAudio();
    const audio = new Audio(url);
    _currentAudio = audio;
    if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume();
    audio.onended = () => { _currentAudio = null; resolve(); };
    audio.onerror = () => { _currentAudio = null; reject(new Error("Local audio failed: " + url)); };
    audio.play().catch(e => { _currentAudio = null; reject(e); });
  });
}

// Try to play from local manifest, returns true if successful
async function tryLocalAudio(text, section) {
  // section = LANG_CONFIG.audioManifestKey + ".cn" | LANG_CONFIG.audioManifestKey + ".en"
  const manifest = await loadAudioManifest();
  if (!manifest) return false;
  const [app, lang] = section.split(".");
  const path = manifest?.[app]?.[lang]?.[text];
  if (!path) return false;
  const audioBase = import.meta.env.BASE_URL || '/ShadowSpeak/';
  try {
    await playLocalAudio(audioBase + path);
    return true;
  } catch(e) {
    console.warn("Local audio playback failed, falling back to API:", e.message);
    return false;
  }
}

// Firestore helpers for progress sync
const PROGRESS_COLLECTION = LANG_CONFIG.firestoreCollection;
async function loadFromFirestore(uid) {
  try {
    const doc = await fbDb.collection(PROGRESS_COLLECTION).doc(uid).get();
    return doc.exists ? doc.data() : null;
  } catch(e) { console.warn("Firestore load failed, using local:", e); return null; }
}
async function saveToFirestore(uid, data) {
  try { await fbDb.collection(PROGRESS_COLLECTION).doc(uid).set(data, { merge: true }); }
  catch(e) { console.warn("Firestore save failed:", e); }
}
async function loadSettingsFromFirestore(uid) {
  try {
    const doc = await fbDb.collection("settings").doc(uid + LANG_CONFIG.settingsKeySuffix).get();
    return doc.exists ? doc.data() : null;
  } catch(e) { return null; }
}
async function saveSettingsToFirestore(uid, data) {
  try { await fbDb.collection("settings").doc(uid + LANG_CONFIG.settingsKeySuffix).set(data); }
  catch(e) { console.warn("Settings save failed:", e); }
}
// TTS proxy is configured via PROXY_URL constant below

// ---- UNITS (10 fixed + Life Sentences) ----

const UNITS = LANG_CONFIG.UNITS;

// Helper: get romanization from a phrase (jyut for Cantonese, pinyin for Mandarin)
function getRom(ph) {
  if (!ph) return "";
  return ph[LANG_CONFIG.romanizationKey] || ph.jyut || ph.pinyin || "";
}


const GLOSS_DATA = LANG_CONFIG.GLOSS_DATA;

const VOCAB_CATS = LANG_CONFIG.VOCAB_CATS;

const ALL_WORDS = LANG_CONFIG.ALL_WORDS;
const TIER_META = LANG_CONFIG.TIER_META;

// ---- TTS ----
let _cnVoice = null;
let _enVoice = null;

function findVoice() {
  if (!_cnVoice) {
    const v = speechSynthesis.getVoices();
    _cnVoice = v.find(x=>x.lang==="yue-HK")||v.find(x=>x.lang==="yue-Hant-HK")||v.find(x=>x.lang==="zh-HK"&&x.name.toLowerCase().includes("canton"))||v.find(x=>x.lang==="zh-HK")||null;
  }
  if (!_enVoice) {
    const v = speechSynthesis.getVoices();
    const enVoices = v.filter(x => x.lang.startsWith("en"));
    // Priority: friendly US female voices first, then Google, then any US, then anything
    // Explicitly avoid Daniel (British male) and other stuffy-sounding voices
    const tiers = [
      x => x.lang === "en-US" && /samantha|google.*female|google us/i.test(x.name),
      x => x.lang === "en-US" && /google/i.test(x.name),
      x => /samantha|ava|zoe|nicky|allison/i.test(x.name), // Apple female voices
      x => x.lang === "en-US" && /premium|enhanced|natural/i.test(x.name),
      x => x.lang === "en-US" && !/daniel|alex|fred|ralph/i.test(x.name), // any US, skip male
      x => x.lang === "en-US",
      x => x.lang === "en-AU", // Aussie over British
      x => true, // anything
    ];
    for (const test of tiers) {
      const match = enVoices.find(test);
      if (match) { _enVoice = match; break; }
    }
    if (!_enVoice) _enVoice = enVoices[0] || null;
  }
  return _cnVoice;
}
if(typeof window!=="undefined"&&"speechSynthesis"in window){speechSynthesis.onvoiceschanged=findVoice;findVoice();}

// ---- SAFARI AUDIO UNLOCK ----
// iOS Safari blocks audio unless it's initiated from a user gesture.
// We unlock the AudioContext on the very first tap by playing a silent buffer.
// After that, all subsequent audio (MiniMax, Google TTS, system) plays fine.
let _audioCtx = null;
let _audioUnlocked = false;

function unlockAudio() {
  if (_audioUnlocked) return;
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    // Play a silent buffer
    const buf = _audioCtx.createBuffer(1, 1, 22050);
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(_audioCtx.destination);
    src.start(0);
    // Also unlock HTML5 Audio
    const silentAudio = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=");
    silentAudio.play().then(() => { silentAudio.pause(); }).catch(()=>{});
    _audioUnlocked = true;
    console.log("Audio unlocked for Safari");
  } catch(e) { console.log("Audio unlock failed:", e); }
}

// Attach to first user interaction
if (typeof document !== "undefined") {
  const unlockEvents = ["touchstart", "touchend", "mousedown", "click"];
  const handleUnlock = () => {
    unlockAudio();
    unlockEvents.forEach(e => document.removeEventListener(e, handleUnlock, true));
  };
  unlockEvents.forEach(e => document.addEventListener(e, handleUnlock, true));
}

function speakAsync(text, lang, rate=0.85) {
  return new Promise(resolve => {
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = rate;
      if (lang === "yue-HK" || lang === "zh-HK") { if (_cnVoice) u.voice = _cnVoice; }
      else if (lang.startsWith("en")) { if (_enVoice) u.voice = _enVoice; u.pitch = 1.0; }
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.speak(u);
      setTimeout(resolve, Math.max(3000, text.length * 200));
    } else resolve();
  });
}

let _currentAudio = null;

function stopAudio() {
  unlockAudio();
  if (_currentAudio) { _currentAudio.pause(); _currentAudio.currentTime = 0; _currentAudio = null; }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---- API PROXY ----
const PROXY_URL = LANG_CONFIG.PROXY_URL;

// ---- ElevenLabs TTS (via proxy) ----

// Voice options — English only for Cantonese app
const EN_VOICES = LANG_CONFIG.EN_VOICES;
const DEFAULT_EN_VOICE = LANG_CONFIG.DEFAULT_EN_VOICE;

// Cantonese.ai voice options
const CN_VOICES = LANG_CONFIG.CN_VOICES;
const DEFAULT_CN_VOICE = LANG_CONFIG.DEFAULT_CN_VOICE;

let _activeEnVoiceId = DEFAULT_EN_VOICE;
let _activeCnVoiceId = DEFAULT_CN_VOICE;

// ---- TTS AUDIO CACHE ----
const _ttsCache = new Map();
const _preloading = new Set(); // track in-flight preloads to avoid duplicates

function _playCachedBlob(blob) {
  return new Promise((resolve, reject) => {
    stopAudio();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _currentAudio = audio;
    if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume();
    audio.onended = () => { _currentAudio = null; resolve(); };
    audio.onerror = () => { _currentAudio = null; reject(new Error("cached playback failed")); };
    audio.play().catch(e => { _currentAudio = null; reject(e); });
  });
}

// ---- PRELOAD: fetch audio into cache without playing it ----
async function _preloadCnAudio(text) {
  const cacheKey = `${LANG_CONFIG.id}:${_activeCnVoiceId}:${text}`;
  if (_ttsCache.has(cacheKey) || _preloading.has(cacheKey)) return;
  _preloading.add(cacheKey);
  try {
    // Try local manifest first
    const manifest = await loadAudioManifest();
    const localPath = manifest?.[LANG_CONFIG.audioManifestKey]?.cn?.[text];
    if (localPath) {
      const res = await fetch(localPath);
      if (res.ok) { _ttsCache.set(cacheKey, await res.blob()); _preloading.delete(cacheKey); return; }
    }
    // Fall back to APIs: cantonese.ai → ElevenLabs
    if (!_isOnline) { _preloading.delete(cacheKey); return; }
    try {
      const res = await fetch(`${PROXY_URL}/tts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language: "cantonese", speed: 1, output_extension: "mp3", voice_id: _activeCnVoiceId })
      });
      if (res.ok) { _ttsCache.set(cacheKey, await res.blob()); _preloading.delete(cacheKey); return; }
    } catch(e) { /* cantonese.ai preload failed */ }
    try {
      const res = await fetch(`${PROXY_URL}/elevenlabs/tts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice_id: _activeCnVoiceId, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0 } })
      });
      if (res.ok) _ttsCache.set(cacheKey, await res.blob());
    } catch(e) { /* ElevenLabs preload failed */ }
  } catch(e) { /* silent fail for preload */ }
  _preloading.delete(cacheKey);
}

async function _preloadEnAudio(text) {
  const cacheKey = `el:${_activeEnVoiceId}:${text}`;
  if (_ttsCache.has(cacheKey) || _preloading.has(cacheKey)) return;
  _preloading.add(cacheKey);
  try {
    const manifest = await loadAudioManifest();
    const localPath = manifest?.[LANG_CONFIG.audioManifestKey]?.en?.[text];
    if (localPath) {
      const res = await fetch(localPath);
      if (res.ok) { _ttsCache.set(cacheKey, await res.blob()); _preloading.delete(cacheKey); return; }
    }
    if (!_isOnline) { _preloading.delete(cacheKey); return; }
    const res = await fetch(`${PROXY_URL}/elevenlabs/tts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: _activeEnVoiceId, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0 } })
    });
    if (res.ok) _ttsCache.set(cacheKey, await res.blob());
  } catch(e) { /* silent fail */ }
  _preloading.delete(cacheKey);
}

// Preload all phrases for a unit (both CN and EN) in background
function preloadUnitAudio(phrases) {
  if (!phrases || phrases.length === 0) return;
  // Stagger requests slightly to avoid burst
  phrases.forEach((ph, i) => {
    setTimeout(() => _preloadCnAudio(ph.cn), i * 500);
    setTimeout(() => _preloadEnAudio(ph.en), i * 500 + 250);
  });
}

// ---- cantonese.ai TTS (for phrases 5+ chars) ----
function cantoneseAiTTS(text) {
  const cacheKey = `${LANG_CONFIG.id}:${_activeCnVoiceId}:${text}`;
  if (_ttsCache.has(cacheKey)) return _playCachedBlob(_ttsCache.get(cacheKey));
  return new Promise((resolve, reject) => {
    stopAudio();
    fetch(`${PROXY_URL}/tts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: "cantonese", speed: 1, output_extension: "mp3", voice_id: _activeCnVoiceId })
    })
    .then(res => { if (!res.ok) throw new Error("cantonese.ai " + res.status); return res.blob(); })
    .then(blob => {
      _ttsCache.set(cacheKey, blob);
      _playCachedBlob(blob).then(resolve).catch(reject);
    }).catch(reject);
  });
}

function elevenLabsTTS(text, lang) {
  const voiceId = (lang && lang !== "en") ? _activeCnVoiceId : _activeEnVoiceId;
  const cacheKey = `el:${voiceId}:${text}`;
  if (_ttsCache.has(cacheKey)) return _playCachedBlob(_ttsCache.get(cacheKey));
  return new Promise((resolve, reject) => {
    stopAudio();
    fetch(`${PROXY_URL}/elevenlabs/tts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: voiceId, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0 } })
    })
    .then(res => { if (!res.ok) throw new Error("ElevenLabs " + res.status); return res.blob(); })
    .then(blob => {
      _ttsCache.set(cacheKey, blob);
      _playCachedBlob(blob).then(resolve).catch(reject);
    }).catch(reject);
  });
}

function googleTTS(text, lang) {
  return new Promise((resolve, reject) => {
    stopAudio();
    const tl = lang === "yue-HK" ? "yue" : "en-us";
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${tl}&q=${encodeURIComponent(text)}`;
    const audio = new Audio(url);
    _currentAudio = audio;
    if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume();
    audio.onended = () => { _currentAudio = null; resolve(); };
    audio.onerror = () => { _currentAudio = null; reject(new Error("Google TTS failed")); };
    audio.play().catch(e => { _currentAudio = null; reject(e); });
  });
}

// Smart speak: try local MP3 first, then cantonese.ai for 5+ CJK, then Google TTS
function countCJK(text) { return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length; }

async function speak(text){
  stopAudio();
  // 1. Try local pre-generated audio
  if (await tryLocalAudio(text, LANG_CONFIG.audioManifestKey + ".cn")) return;
  // 2. Offline? Can't call API
  if (!_isOnline) { console.warn("Offline: no local audio for", text); return; }
  // 3. Online fallbacks based on language
  if (LANG_CONFIG.ttsProvider === "cantonese-ai") {
    try { await cantoneseAiTTS(text); return; } catch(e) { console.warn("cantonese.ai failed:", e.message); }
    try { await googleTTS(text, "yue-HK"); return; } catch(e) { console.warn("Google TTS failed:", e.message); }
    try { await elevenLabsTTS(text, "yue-HK"); return; } catch(e) { console.warn("ElevenLabs failed:", e.message); }
    return speakAsync(text, "yue-HK", 0.85);
  } else {
    try { await elevenLabsTTS(text, "cmn-CN"); return; } catch(e) { console.warn("ElevenLabs failed:", e.message); }
    try { await googleTTS(text, "cmn-CN"); return; } catch(e) {}
    return speakAsync(text, "cmn-CN", 0.85);
  }
}

async function speakEnglish(text) {
  stopAudio();
  // 1. Try local pre-generated audio
  if (await tryLocalAudio(text, LANG_CONFIG.audioManifestKey + ".en")) return;
  // 2. Offline? Can't call API
  if (!_isOnline) { console.warn("Offline: no local EN audio for", text); return; }
  // 3. Online fallbacks
  try { await elevenLabsTTS(text, "en"); return; } catch(e) { console.warn("ElevenLabs EN failed:", e.message); }
  try { await googleTTS(text, "en"); return; } catch(e) {}
  return speakAsync(text, "en-US", 1.0);
}

async function speakPhrase(item) {
  await speakEnglish(item.en);
  await new Promise(r => setTimeout(r, 800));
  await speak(item.cn);
}

// ---- Pronunciation Scoring via cantonese.ai ----
async function scorePronunciation(audioBlob, text, language = "cantonese") {
  if (!_isOnline) throw new Error("OFFLINE");
  const formData = new FormData();
  formData.append("text", text);
  formData.append("language", language);
  formData.append("audio", audioBlob, "recording.webm");
  const res = await fetch(`${PROXY_URL}/score`, { method: "POST", body: formData });
  if (!res.ok) throw new Error("Scoring failed: " + res.status);
  return res.json();
}

// ---- Offline-aware recording: check connectivity before mic access ----
const _origStartRecording = null; // placeholder

// Audio recording helpers — keeps mic stream alive to avoid repeated permission prompts
let _mediaRecorder = null;
let _audioChunks = [];
let _micStream = null;

async function getMicStream() {
  if (_micStream && _micStream.active) return _micStream;
  _micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return _micStream;
}

async function startRecording() {
  const stream = await getMicStream();
  _audioChunks = [];
  _mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  _mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _audioChunks.push(e.data); };
  _mediaRecorder.start();
  return true;
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!_mediaRecorder || _mediaRecorder.state === "inactive") { resolve(null); return; }
    _mediaRecorder.onstop = () => {
      const blob = new Blob(_audioChunks, { type: "audio/webm" });
      // Don't stop tracks — keep stream alive for next recording
      resolve(blob);
    };
    _mediaRecorder.stop();
  });
}

function releaseMicStream() {
  if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
}

// Sound effects for score feedback
function playScoreSound(type) {
  try {
    const ax = new (window.AudioContext || window.webkitAudioContext)();
    if (type === "perfect") {
      [523.25,659.25,783.99,1046.50,1318.51].forEach((f,i) => {
        const o=ax.createOscillator(),o2=ax.createOscillator(),g=ax.createGain();
        o.type="sine";o2.type="triangle";o.frequency.value=f;o2.frequency.value=f*2;
        g.gain.setValueAtTime(0,ax.currentTime+i*.1);g.gain.linearRampToValueAtTime(.12,ax.currentTime+i*.1+.04);
        g.gain.exponentialRampToValueAtTime(.001,ax.currentTime+i*.1+.6);
        o.connect(g);o2.connect(g);g.connect(ax.destination);
        o.start(ax.currentTime+i*.1);o.stop(ax.currentTime+i*.1+.6);o2.start(ax.currentTime+i*.1);o2.stop(ax.currentTime+i*.1+.6);
      });
    } else if (type === "good") {
      [440,554.37].forEach((f,i) => {
        const o=ax.createOscillator(),g=ax.createGain();o.type="sine";o.frequency.value=f;
        g.gain.setValueAtTime(0,ax.currentTime+i*.15);g.gain.linearRampToValueAtTime(.12,ax.currentTime+i*.15+.05);
        g.gain.exponentialRampToValueAtTime(.001,ax.currentTime+i*.15+.5);
        o.connect(g).connect(ax.destination);o.start(ax.currentTime+i*.15);o.stop(ax.currentTime+i*.15+.5);
      });
    } else {
      [392,330].forEach((f,i) => {
        const o=ax.createOscillator(),g=ax.createGain();o.type="sine";o.frequency.value=f;
        g.gain.setValueAtTime(0,ax.currentTime+i*.2);g.gain.linearRampToValueAtTime(.1,ax.currentTime+i*.2+.05);
        g.gain.exponentialRampToValueAtTime(.001,ax.currentTime+i*.2+.4);
        o.connect(g).connect(ax.destination);o.start(ax.currentTime+i*.2);o.stop(ax.currentTime+i*.2+.4);
      });
    }
  } catch(e) {}
}

// ---- Spaced Repetition helpers ----
function getDueItems(progress) {
  const now = Date.now();
  const due = [];
  const phrases = progress.phrases || {};
  const phraseTimestamps = progress.phraseTs || {};
  UNITS.forEach(u => {
    u.phrases.forEach((p, i) => {
      const key = `${u.id}-${i}`;
      if (phrases[key]) {
        const ts = phraseTimestamps[key] || 0;
        const age = now - ts;
        const dayMs = 86400000;
        // Day 1-7: review daily. Week 2-4: every 3 days. Month 2+: weekly
        let interval;
        if (age < 7 * dayMs) interval = dayMs;
        else if (age < 28 * dayMs) interval = 3 * dayMs;
        else interval = 7 * dayMs;
        const lastReview = progress.lastReview?.[key] || ts;
        if (now - lastReview >= interval) due.push({ ...p, unitId: u.id, unitTitle: u.title, phraseIdx: i, key });
      }
    });
  });
  return due;
}

function getNewItems(progress) {
  const fresh = [];
  UNITS.forEach(u => {
    u.phrases.forEach((p, i) => {
      const key = `${u.id}-${i}`;
      if (!(progress.phrases || {})[key]) fresh.push({ ...p, unitId: u.id, unitTitle: u.title, phraseIdx: i, key });
    });
  });
  return fresh.slice(0, 10); // suggest 10 new per day
}

// ---- JYUTPING TONE MARKS ----
// Renders jyutping with visual tone contour lines instead of numbers
// Cantonese tones: 1=high level, 2=high rising, 3=mid level, 4=low falling, 5=low rising, 6=low level
const TONE_PATHS = {
  "1": "M0,2 L12,2",        // high level ˉ
  "2": "M0,10 L12,2",       // high rising ˊ
  "3": "M0,7 L12,7",        // mid level ˉ (mid)
  "4": "M0,4 L12,12",       // low falling ˋ
  "5": "M0,12 L12,6",       // low rising ˊ (low start)
  "6": "M0,12 L12,12",      // low level ˉ (low)
};

function ToneMark({ tone }) {
  const path = TONE_PATHS[tone];
  if (!path) return null;
  return React.createElement("svg", {
    width: 12, height: 14, viewBox: "0 0 12 14",
    style: { verticalAlign: "middle", opacity: 0.65, flexShrink: 0 }
  }, React.createElement("path", {
    d: path, stroke: "currentColor", strokeWidth: 2, fill: "none", strokeLinecap: "round"
  }));
}

function JyutpingTone({ text, className, style }) {
  if (!text) return null;
  const syllables = text.replace(/[，,!！?？。]/g, "").trim().split(/\s+/);
  return React.createElement("span", {
    className: className || "",
    style: { display: "inline-flex", flexWrap: "wrap", gap: "1px 8px", alignItems: "baseline", ...style }
  }, syllables.map((syl, i) => {
    const toneMatch = syl.match(/^([a-z]+)(\d)$/i);
    if (!toneMatch) return React.createElement("span", { key: i }, syl);
    const base = toneMatch[1];
    const tone = toneMatch[2];
    return React.createElement("span", {
      key: i,
      style: { display: "inline-flex", alignItems: "center", gap: 0 }
    },
      React.createElement("span", null, base + tone),
      React.createElement(ToneMark, { tone })
    );
  }));
}

// ---- STYLES ----
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;0,9..40,900;1,9..40,400&family=Noto+Sans+HK:wght@400;700;900&display=swap');
:root{--cream:#F5F2EE;--wh:#fff;--st:#EDE8E0;--st2:#E0DAD0;--ink:#2C2C2C;--ink2:#5A554F;--ink3:#7A756E;--lime:#C4F000;--ld:#7AAA00;--for:#1F3329;--navy:#1A1F3D;--navy-l:#242B52;--cor:#F05A3A;--plum:#8F6AE8;}
*{box-sizing:border-box;margin:0;padding:0}body,button,input,select,textarea{font-family:'DM Sans',-apple-system,sans-serif}
.ca{background:var(--cream);min-height:100vh;color:var(--ink);-webkit-font-smoothing:antialiased}
@keyframes slideDown{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}

/* Bottom nav — mobile only */
.bn{position:fixed;bottom:0;left:0;right:0;background:var(--wh);border-top:1px solid var(--st2);display:flex;z-index:100;padding-bottom:env(safe-area-inset-bottom)}
.bb{flex:1 1 33.33%;display:flex;flex-direction:column;align-items:center;gap:2px;padding:10px 2px 8px;border:none;background:0;color:var(--ink3);font-size:12px;font-weight:700;cursor:pointer;position:relative;min-height:56px}
.bb.on{color:var(--for)}.bb.on .bi{color:var(--ld)}
.bb.on::before{content:'';position:absolute;top:0;left:25%;right:25%;height:2.5px;background:var(--lime);border-radius:0 0 2px 2px}
.bi{font-size:20px;line-height:1}

/* Top nav — desktop only */
.tn{display:none}

.hdr{background:var(--for);padding:12px 16px;display:flex;align-items:center;justify-content:space-between}
.hdr-l{display:flex;align-items:center;gap:8px}
.hm{width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#DE2910}
.hm svg{width:22px;height:22px}
.ht{font-size:.92rem;font-weight:900;color:#fff}
.ha{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;cursor:pointer;border:2px solid var(--lime)}

.mc{padding:14px 14px 80px;max-width:700px;margin:0 auto}
.sl{font-size:.68rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--ink3);margin:16px 0 6px}.sl:first-child{margin-top:0}
.pt{font-size:1.2rem;font-weight:900;margin-bottom:2px}.ps{font-size:.78rem;color:var(--ink3);margin-bottom:10px}

/* ===== DESKTOP (768px+) ===== */
@media(min-width:768px){
  .bn{display:none}
  .tn{display:flex;align-items:center;gap:4px;margin-left:24px}
  .tn-btn{background:none;border:none;color:rgba(255,255,255,.5);font-size:.82rem;font-weight:700;cursor:pointer;padding:8px 14px;border-radius:8px;transition:all .15s;display:flex;align-items:center;gap:5px}
  .tn-btn:hover{background:rgba(255,255,255,.08);color:rgba(255,255,255,.8)}
  .tn-btn.on{background:rgba(196,240,0,.12);color:var(--lime)}
  .tn-icon{font-size:1rem}
  .hdr{padding:12px 28px}
  .hdr-l{gap:10px}
  .ht{font-size:1rem}
  .ha{width:32px;height:32px;font-size:11px}
  .mc{padding:28px 28px 40px;max-width:1060px}
  .sl{font-size:.62rem;margin:18px 0 8px}
  .pt{font-size:1.4rem;margin-bottom:3px}
  .ps{font-size:.78rem;margin-bottom:14px}
  .card{padding:16px 18px;margin-bottom:8px;border-radius:14px}
  .ph-en{font-size:1rem;margin-bottom:3px}
  .ph-jy{font-size:1rem;margin-bottom:4px}
  .ph-cn{font-size:.82rem;margin-bottom:8px}
  .ph-ft{gap:8px}
  .pbtn{width:32px;height:32px;font-size:12px}
  .rpt-btn{font-size:.65rem!important;width:auto!important;height:auto!important}
  .tg{font-size:.58rem}
  .mkb{font-size:.65rem;padding:5px 12px}
  .usel{font-size:.88rem;padding:12px 14px;border-radius:11px;margin-bottom:12px}
  .ug{grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px}
  .uc{padding:14px 16px;border-radius:13px}
  .uc-n{font-size:.58rem}
  .uc-ti{font-size:.88rem;margin-bottom:3px}
  .uc-sc{font-size:.66rem;margin-bottom:6px}
  .acc-ti{font-size:.88rem}
  .acc-ct{font-size:.7rem}
  .wg{grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
  .wc{padding:10px 12px}
  .wc-en{font-size:.78rem}
  .wc-jy{font-size:.66rem}
  .wc-cn{font-size:.66rem}
  .set-card{padding:16px;margin-bottom:10px}
  .set-nm{font-size:.88rem}
  .set-inp{font-size:.82rem;width:70px}
  .quiz-body{padding:32px}
  .quiz-prompt{font-size:1.6rem}
  .quiz-sub{font-size:.88rem}
  .quiz-reveal-btn{font-size:.95rem;padding:14px 36px}
  .quiz-answer{padding:22px;border-radius:16px}
  .quiz-ans-jy{font-size:1rem}
  .quiz-ans-cn{font-size:.92rem}
  .quiz-ans-en{font-size:1.05rem}
  .quiz-g-btn{padding:12px 24px;font-size:.85rem}
  .quiz-score{font-size:.75rem}
  .qs-card{padding:22px;border-radius:16px}
  .qs-ti{font-size:1rem}
  .qs-sub{font-size:.75rem}
  .sh-en{font-size:1.6rem}
  .sh-jy{font-size:1.2rem}
  .sh-cn{font-size:1.2rem}
  .sh-cl{font-size:.88rem;padding:10px 20px}
  .sh-tg-b{font-size:.82rem;padding:10px 18px}
  .sh-tg{font-size:.7rem}
  .sh-ct{font-size:.82rem}
}

/* Card styles */
.card{background:var(--wh);border-radius:11px;padding:11px 12px;border:1px solid var(--st);margin-bottom:5px}
.card.kn{border-color:var(--ld);background:#FAFFF0}

/* Phrase card - EN+Jyut primary */
.ph-en{font-size:.88rem;font-weight:700;color:var(--ink);margin-bottom:2px;line-height:1.3}
.ph-jy{font-size:.88rem;font-style:italic;color:var(--plum);margin-bottom:4px;font-weight:600}
.ph-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')};font-size:.72rem;color:var(--ink3);margin-bottom:6px}
.ph-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pbtn{width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.play-btn{background:var(--st);color:var(--ink)}.rpt-btn{background:none;color:var(--ink2);font-size:.72rem;font-weight:700;width:auto;height:auto;border-radius:0;padding:4px 0;text-decoration:none;min-height:36px;display:inline-flex;align-items:center}
.tg{font-size:.68rem;font-weight:600;color:var(--ink3);padding:0;border-radius:0;font-style:italic;background:none}
.mkb{margin-left:auto;font-size:.72rem;font-weight:800;border:none;border-radius:999px;padding:8px 14px;cursor:pointer;min-height:36px}
.mkb.un{background:var(--st);color:var(--ink2)}.mkb.kn{background:var(--lime);color:var(--for)}

/* Unit selector */
.usel{width:100%;padding:12px 14px;border-radius:10px;border:1.5px solid var(--st);background:var(--wh);font-size:.82rem;font-weight:700;color:var(--ink);cursor:pointer;margin-bottom:10px;-webkit-appearance:none;appearance:none;min-height:44px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%236B6560' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}

/* Shadow overlay */
.sho{position:fixed;inset:0;background:var(--for);z-index:200;display:flex;flex-direction:column}
.sh-hd{padding:10px 14px;display:flex;align-items:center;justify-content:space-between}
.sh-cl{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:999px;padding:8px 16px;font-size:.75rem;font-weight:700;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;gap:5px}
.sh-bar{height:2px;background:rgba(255,255,255,.1);margin:0 14px;border-radius:2px;overflow:hidden}.sh-bf{height:100%;background:var(--lime);border-radius:2px;transition:width .3s}
.sh-bd{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px;text-align:center}
.sh-tg{font-size:.68rem;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:rgba(255,255,255,.4);margin-bottom:8px}
.sh-en{font-size:1.3rem;font-weight:800;color:#fff;margin-bottom:6px;line-height:1.2}
.sh-jy{font-size:1.05rem;font-weight:600;font-style:italic;color:var(--lime);margin-bottom:6px}
.sh-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')};font-size:1.05rem;font-weight:600;color:rgba(255,255,255,.65);margin-bottom:14px}.sh-cn.hid{opacity:0}
.sh-peek{border:2px dashed rgba(255,255,255,.15);border-radius:12px;padding:14px 28px;margin-bottom:14px;cursor:pointer;text-align:center}
.sh-peek-text{font-size:.72rem;font-weight:700;color:rgba(255,255,255,.25)}
.sh-ctx{font-size:.68rem;font-weight:700;color:rgba(255,255,255,.3);margin-bottom:10px;letter-spacing:.3px}
.sh-cue{display:flex;align-items:center;gap:6px;background:rgba(196,240,0,.08);border:1px solid rgba(196,240,0,.15);border-radius:999px;padding:8px 16px}
.sh-cd{width:6px;height:6px;border-radius:50%;background:var(--lime);flex-shrink:0}
.sh-cd.on{animation:pulse 1.2s ease-in-out infinite}.sh-cd.off{background:rgba(255,255,255,.15);animation:none}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
.sh-ct{font-size:.75rem;font-weight:800;color:var(--lime)}.sh-ct.wt{color:rgba(255,255,255,.3)}

.sh-ctrl{padding:14px 16px;padding-bottom:max(14px,env(safe-area-inset-bottom))}
.sh-r1{display:flex;align-items:flex-start;justify-content:center;gap:16px;margin-bottom:10px}
.sc-b{width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,.08);border:1.5px solid rgba(255,255,255,.12);cursor:pointer;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.7);font-size:18px;flex-shrink:0}
.sc-p{width:60px;height:60px;border-radius:50%;background:var(--lime);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--for);font-size:22px;font-weight:900;flex-shrink:0}
.sc-mk{width:48px;height:48px;border-radius:50%;background:rgba(196,240,0,.12);border:1px solid rgba(196,240,0,.2);color:var(--lime);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sc-mk.dn{opacity:.4}
.sc-wrap{display:flex;flex-direction:column;align-items:center;gap:4px}
.sc-lbl{font-size:.62rem;font-weight:700;color:rgba(255,255,255,.4);text-align:center}
.sh-r2{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap}
.sh-tg-b{padding:10px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:0;color:rgba(255,255,255,.4);font-size:.72rem;font-weight:700;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;justify-content:center}
.sh-tg-b.on{background:rgba(196,240,0,.1);border-color:rgba(196,240,0,.25);color:var(--lime)}

/* Lesson mode - navy background */
.sho.navy{background:var(--navy)}

/* Lesson intro screen */
.lesson-intro{flex:1;display:flex;flex-direction:column;align-items:center;text-align:center;padding:24px 24px 40px;overflow-y:auto}
.li-emoji{font-size:2.5rem;margin-bottom:16px}
.li-title{font-size:1.8rem;font-weight:900;color:#fff;line-height:1.2;margin-bottom:12px}
.li-sub{font-size:1rem;color:rgba(255,255,255,.65);line-height:1.6;margin-bottom:28px;max-width:340px}
.li-roadmap{width:100%;max-width:380px;margin-bottom:28px}
.rm-item{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.rm-item:last-child{border-bottom:none}
.rm-icon{font-size:1.4rem;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rm-icon.warmup{background:rgba(255,160,60,.12)}.rm-icon.learn{background:rgba(100,200,255,.12)}.rm-icon.drill{background:rgba(196,240,0,.12)}.rm-icon.review{background:rgba(180,130,255,.12)}.rm-icon.quiz{background:rgba(255,200,60,.12)}.rm-icon.wind{background:rgba(150,200,255,.12)}
.rm-text{flex:1;text-align:left}
.rm-name{font-size:.92rem;font-weight:800;color:#fff}
.rm-desc{font-size:.78rem;color:rgba(255,255,255,.5);margin-top:2px;line-height:1.4}
.rm-dur{font-size:.78rem;font-weight:900;color:var(--lime);flex-shrink:0}
.li-go{background:var(--lime);color:var(--navy);border:none;border-radius:14px;padding:16px 48px;font-size:1.05rem;font-weight:900;cursor:pointer;font-family:inherit;box-shadow:0 4px 20px rgba(196,240,0,.25);transition:transform .1s;margin-bottom:16px}
.li-go:active{transform:scale(.95)}
.li-tip{display:flex;align-items:flex-start;gap:8px;background:rgba(196,240,0,.06);border:1px solid rgba(196,240,0,.12);border-radius:12px;padding:12px 16px;max-width:360px;text-align:left}
.li-tip-emoji{font-size:1.1rem;flex-shrink:0}
.li-tip-text{font-size:.82rem;font-weight:600;color:rgba(255,255,255,.55);line-height:1.5}
.li-tip-text strong{color:rgba(255,255,255,.8);font-weight:800}

/* Phase transition cards */
.phase-trans{position:fixed;inset:0;z-index:210;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 28px}
.phase-trans.navy{background:var(--navy)}
.pt-icon{font-size:3.5rem;margin-bottom:20px;animation:ptBounce .6s ease-out}
@keyframes ptBounce{0%{transform:scale(0.5);opacity:0}60%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
.pt-name{font-size:1.6rem;font-weight:900;color:#fff;margin-bottom:10px}
.pt-desc{font-size:1rem;color:rgba(255,255,255,.6);line-height:1.6;max-width:320px;margin-bottom:20px}
.voice-coach{display:inline-flex;align-items:center;gap:8px;background:rgba(196,240,0,.08);border:1px solid rgba(196,240,0,.15);border-radius:999px;padding:10px 20px;margin-bottom:20px}
.vc-waves{display:flex;align-items:center;gap:2px;height:16px}
.vc-bar{width:3px;border-radius:2px;background:var(--lime);animation:wave 1s ease-in-out infinite}
.vc-bar:nth-child(1){height:6px;animation-delay:0s}.vc-bar:nth-child(2){height:12px;animation-delay:.15s}.vc-bar:nth-child(3){height:8px;animation-delay:.3s}.vc-bar:nth-child(4){height:14px;animation-delay:.1s}.vc-bar:nth-child(5){height:6px;animation-delay:.25s}
@keyframes wave{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.4)}}
.vc-text{font-size:.78rem;font-weight:700;color:var(--lime)}
.pt-skip{background:none;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.4);border-radius:999px;padding:10px 24px;font-size:.78rem;font-weight:700;cursor:pointer;font-family:inherit}

/* In-lesson coaching cues */
.coach-inline{margin:8px 16px 0;padding:10px 14px;background:rgba(196,240,0,.05);border:1px solid rgba(196,240,0,.1);border-radius:10px;display:flex;align-items:center;gap:8px;justify-content:center}
.ci-emoji{font-size:.9rem}
.ci-text{font-size:.75rem;font-weight:700;color:rgba(255,255,255,.5)}
.ci-text strong{color:rgba(255,255,255,.75)}

/* Listen / Say it out loud cue pill */
.cue-pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:11px 24px;transition:all .3s}
.cue-pill.listen{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}
.cue-pill.speak{background:rgba(196,240,0,.1);border:1px solid rgba(196,240,0,.2)}
.cue-pill-emoji{font-size:1.15rem;line-height:1}
.cue-pill-text{font-size:.82rem;font-weight:800}
.cue-pill.listen .cue-pill-text{color:rgba(255,255,255,.4)}
.cue-pill.speak .cue-pill-text{color:var(--lime)}
.cue-pill-dot{width:6px;height:6px;border-radius:50%;animation:pulse 1.2s ease-in-out infinite}
.cue-pill.listen .cue-pill-dot{background:rgba(255,255,255,.25)}
.cue-pill.speak .cue-pill-dot{background:var(--lime)}

/* Lesson transport controls */
.l-ctrl{padding:16px 20px 0;padding-bottom:max(16px,env(safe-area-inset-bottom));background:rgba(0,0,0,.15);border-top:1px solid rgba(255,255,255,.06)}
.l-transport{display:flex;align-items:center;justify-content:center;gap:20px;margin-bottom:14px}
.lt-wrap{display:flex;flex-direction:column;align-items:center;gap:4px}
.lt-btn{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;font-family:inherit;transition:transform .1s}
.lt-btn:active{transform:scale(.9)}
.lt-btn.sec{background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.1);color:rgba(255,255,255,.6)}
.lt-btn.pri{width:64px;height:64px;background:var(--lime);color:var(--navy);font-size:24px;font-weight:900;box-shadow:0 4px 16px rgba(196,240,0,.2)}
.lt-lbl{font-size:.6rem;font-weight:700;color:rgba(255,255,255,.3)}
.l-know-row{display:flex;justify-content:center;margin-bottom:14px}
.l-know-btn{display:flex;align-items:center;gap:8px;padding:12px 28px;border-radius:999px;background:rgba(196,240,0,.15);border:2px solid var(--lime);color:var(--lime);font-family:'DM Sans',sans-serif;font-size:.85rem;font-weight:900;cursor:pointer;min-height:56px;transition:all .15s;box-shadow:0 2px 8px rgba(196,240,0,.2)}.l-know-btn:active{transform:scale(.96);background:rgba(196,240,0,.25)}
.l-divider{height:1px;background:rgba(255,255,255,.06);margin-bottom:12px}
.l-row-label{font-size:.58rem;font-weight:800;color:rgba(255,255,255,.2);text-transform:uppercase;letter-spacing:1.2px;text-align:center;margin-bottom:6px}
.l-pill-row{display:flex;align-items:center;justify-content:center;gap:6px}
.l-pill-btn{padding:10px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:none;color:rgba(255,255,255,.35);font-family:'DM Sans',sans-serif;font-size:.72rem;font-weight:700;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;justify-content:center}
.l-pill-btn.on{background:rgba(196,240,0,.1);border-color:rgba(196,240,0,.25);color:var(--lime)}
.l-speed{margin-bottom:8px}
.l-jyut-toggle{display:flex;justify-content:center;margin-bottom:8px}

/* Phase bar toned down (#18) */
.l-phase-bar{display:flex;padding:6px 16px 2px;opacity:.4}
.l-pb-item{text-align:center}
.l-pb-icon{font-size:.55rem;font-weight:700}
.l-pb-label{font-size:.48rem;font-weight:600;line-height:1.1;margin-top:1px}

/* Enlarged word cards (#19) */
.drill-word-card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 18px;text-align:center;min-width:70px;cursor:pointer;transition:background .15s}
.drill-word-card:active{background:rgba(255,255,255,.12)}
.dwc-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')},sans-serif;font-size:1.4rem;font-weight:700;color:#fff}
.dwc-jy{font-size:.85rem;font-style:italic;color:var(--lime);margin-top:4px}
.dwc-en{font-size:.75rem;color:rgba(255,255,255,.45);margin-top:3px}

/* Vocab playlist bar redesign (#20) */
.pl-bar-v2{background:rgba(20,20,20,.95);border-radius:16px;padding:12px 14px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.06);position:relative}
.pl-v2-play{width:44px;height:44px;border-radius:50%;background:var(--lime);border:none;color:var(--navy);font-size:18px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.pl-v2-info{flex:1;min-width:0}
.pl-v2-en{font-size:.78rem;font-weight:600;color:rgba(255,255,255,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-v2-jy{font-size:.72rem;font-style:italic;color:var(--lime);margin-top:1px}
.pl-v2-counter{font-size:.68rem;color:rgba(255,255,255,.4);font-weight:700;margin-top:3px}
.pl-v2-prog{height:2px;background:rgba(255,255,255,.08);border-radius:1px;margin-top:4px}
.pl-v2-prog-fill{height:100%;background:var(--lime);border-radius:1px;transition:width .3s}
.pl-v2-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')},sans-serif;font-size:2rem;font-weight:900;color:#fff;flex-shrink:0;line-height:1}
.pl-v2-close{position:absolute;top:6px;right:8px;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.5);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.pl-v2-speeds{display:flex;align-items:center;gap:4px;margin-top:4px}
.pl-v2-speed-label{font-size:.55rem;font-weight:800;color:rgba(255,255,255,.2);text-transform:uppercase;letter-spacing:.5px;margin-right:2px}

@media(min-width:420px){
  .l-transport{gap:28px}
  .lt-btn{width:56px;height:56px}
  .lt-btn.pri{width:68px;height:68px}
}

/* Completion popup */
.comp-ov{position:fixed;inset:0;background:rgba(31,51,41,.96);z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;animation:fi .3s}
@keyframes fi{from{opacity:0}to{opacity:1}}
.comp-em{font-size:3rem;margin-bottom:12px}.comp-t{font-size:1.2rem;font-weight:900;color:#fff;margin-bottom:3px}
.comp-s{font-size:.72rem;color:rgba(255,255,255,.45);margin-bottom:20px}
.comp-btn{background:var(--lime);color:var(--for);border:none;border-radius:10px;padding:12px 24px;font-size:.8rem;font-weight:900;cursor:pointer;min-height:48px}

/* Vocab accordion */
.acc{margin-bottom:5px}
.acc-hd{background:var(--wh);border-radius:10px;padding:12px 14px;border:1px solid var(--st);display:flex;align-items:center;justify-content:space-between;cursor:pointer;min-height:56px}
.acc-hd.open{border-radius:10px 10px 0 0;border-bottom-color:transparent}
.acc-ti{font-size:.82rem;font-weight:800}.acc-ct{font-size:.72rem;color:var(--ink3);font-weight:700}
.acc-chv{font-size:12px;color:var(--ink3);transition:transform .2s}.acc-chv.open{transform:rotate(180deg)}
.acc-bd{background:var(--wh);border:1px solid var(--st);border-top:0;border-radius:0 0 10px 10px;padding:10px}
.wg{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:5px}
.wc{background:var(--cream);border-radius:8px;padding:10px 10px;position:relative}
.wc.kn{background:#F0FFEA}
.wc-en{font-size:.78rem;font-weight:700;color:var(--ink);margin-bottom:1px}.wc-jy{font-size:.68rem;font-style:italic;color:var(--plum)}
.wc-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')};font-size:.68rem;color:var(--ink3)}
.wc-ft{display:flex;align-items:center;justify-content:space-between;margin-top:5px}
.wc-pl{width:44px;height:44px;border-radius:50%;background:var(--st);border:none;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;color:var(--ink)}
.wc-ik{font-size:.62rem;font-weight:800;border:none;border-radius:999px;padding:6px 10px;cursor:pointer;min-height:32px}
.wc-ik.un{background:var(--st);color:var(--ink2)}.wc-ik.kn{background:var(--lime);color:var(--for)}

/* Tier cards */
.tc{background:var(--wh);border-radius:10px;padding:12px 14px;border:1px solid var(--st);margin-bottom:6px}
.tc-h{display:flex;justify-content:space-between;margin-bottom:5px}.tc-l{font-size:.82rem;font-weight:900}.tc-c{font-size:.72rem;font-weight:700;color:var(--ink3)}
.tc-bar{height:5px;background:var(--st);border-radius:999px;overflow:hidden;margin-bottom:2px}.tc-bf{height:100%;border-radius:999px;transition:width .3s}

/* Tier tabs */
.tt{display:flex;gap:4px;margin:10px 0}
.ttb{flex:1;padding:10px;border-radius:10px;border:1.5px solid var(--st);background:var(--wh);cursor:pointer;text-align:center;min-height:56px}
.ttb.on{border-color:var(--for);background:#F5FFF0}
.ttb-l{font-size:.75rem;font-weight:800}.ttb-s{font-size:.62rem;color:var(--ink3)}

/* Unit 10 */
.u10-bx{background:var(--for);border-radius:12px;padding:14px;margin-bottom:12px}
.u10-lb{font-size:.68rem;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:rgba(255,255,255,.4);margin-bottom:4px}
.u10-ti{font-size:.95rem;font-weight:900;color:#fff;margin-bottom:10px}
.u10-inp{width:100%;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:10px 12px;font-size:.82rem;color:#fff;outline:none;font-family:inherit;margin-bottom:6px;min-height:44px}
.u10-inp::placeholder{color:rgba(255,255,255,.45)}
.u10-row{display:flex;gap:6px;margin-bottom:6px}
.u10-sv{background:var(--lime);color:var(--for);border:none;border-radius:8px;padding:10px 16px;font-size:.78rem;font-weight:900;cursor:pointer;min-height:44px}
.u10-help{font-size:.72rem;color:rgba(255,255,255,.55);line-height:1.5;margin-top:5px}
.u10-help a{color:var(--lime);text-decoration:none}

/* Today coach */
.coach-card{background:var(--for);border-radius:12px;padding:14px;margin-bottom:8px}
.coach-ti{font-size:.88rem;font-weight:900;color:#fff;margin-bottom:5px}
.coach-sub{font-size:.72rem;color:rgba(255,255,255,.45);margin-bottom:10px}
.coach-btn{background:var(--lime);color:var(--for);border:none;border-radius:999px;padding:12px 18px;font-size:.78rem;font-weight:900;cursor:pointer;min-height:56px}
.coach-list{margin-top:8px}
.coach-item{background:rgba(255,255,255,.06);border-radius:8px;padding:10px 12px;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between}
.ci-en{font-size:.78rem;font-weight:600;color:rgba(255,255,255,.8)}.ci-unit{font-size:.62rem;color:rgba(255,255,255,.35)}

/* Audio playlist indicator */
.playlist-bar{background:var(--for);border-radius:10px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px}
.pl-btn{width:40px;height:40px;border-radius:50%;background:var(--lime);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--for);font-size:14px;font-weight:900;flex-shrink:0}
.pl-info{flex:1}.pl-ti{font-size:.78rem;font-weight:800;color:#fff}.pl-sub{font-size:.68rem;color:rgba(255,255,255,.45)}
.pl-stop{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:999px;padding:10px 14px;font-size:.72rem;font-weight:700;cursor:pointer;min-height:44px}

/* Playlist builder */
.plb-ov{position:fixed;inset:0;background:var(--cream);z-index:200;display:flex;flex-direction:column}
.plb-hd{background:var(--for);padding:12px 14px;display:flex;align-items:center;justify-content:space-between}
.plb-cl{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:999px;padding:10px 14px;font-size:.75rem;font-weight:700;cursor:pointer;min-height:44px}
.plb-ti{font-size:.92rem;font-weight:900;color:#fff}
.plb-play{background:var(--lime);color:var(--for);border:none;border-radius:999px;padding:10px 16px;font-size:.78rem;font-weight:900;cursor:pointer;min-height:44px}
.plb-play:disabled{opacity:.4}
.plb-body{flex:1;overflow-y:auto;padding:14px}
.plb-sec{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:var(--ink3);margin:12px 0 6px}
.plb-unit{background:var(--wh);border-radius:10px;padding:12px 14px;border:1px solid var(--st);margin-bottom:5px;display:flex;align-items:center;gap:10px;cursor:pointer;min-height:48px}
.plb-unit.sel{border-color:var(--ld);background:#FAFFF0}
.plb-chk{width:22px;height:22px;border-radius:5px;border:2px solid var(--st2);display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}
.plb-unit.sel .plb-chk{background:var(--lime);border-color:var(--lime);color:var(--for)}
.plb-nm{font-size:.82rem;font-weight:700;flex:1}.plb-ct{font-size:.72rem;color:var(--ink3)}
.plb-phrase{background:var(--wh);border-radius:8px;padding:10px 12px;border:1px solid var(--st);margin-bottom:4px;display:flex;align-items:center;gap:8px;cursor:pointer;min-height:44px}
.plb-phrase.sel{border-color:var(--ld);background:#FAFFF0}
.plb-ph-chk{width:18px;height:18px;border-radius:4px;border:1.5px solid var(--st2);display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0}
.plb-phrase.sel .plb-ph-chk{background:var(--lime);border-color:var(--lime);color:var(--for)}
.plb-ph-en{font-size:.78rem;font-weight:600;flex:1}
.plb-summary{background:var(--for);padding:12px 16px;display:flex;align-items:center;justify-content:space-between}
.plb-sum-txt{font-size:.78rem;color:rgba(255,255,255,.7);font-weight:700}
.plb-sum-n{color:var(--lime);font-weight:900}

/* Settings */
.set-card{background:var(--wh);border-radius:10px;padding:14px;border:1px solid var(--st);margin-bottom:8px}
.set-lb{font-size:.72rem;font-weight:800;color:var(--ink3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px}
.set-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.set-av{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0}
.set-nm{font-size:.82rem;font-weight:800;flex:1}
.set-inp{width:60px;padding:8px 10px;border-radius:6px;border:1.5px solid var(--st);font-size:.78rem;font-weight:700;text-align:center;outline:none;min-height:40px}

/* Profile picker */
.pkr{background:var(--for);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px}
.pkr-t{font-size:1.2rem;font-weight:900;color:#fff;margin-bottom:3px;text-align:center}
.pkr-s{font-size:.78rem;color:rgba(255,255,255,.45);margin-bottom:22px;text-align:center}
.pkr-g{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;width:100%;max-width:320px}
@media(min-width:480px){.pkr-g{grid-template-columns:repeat(4,1fr);max-width:500px}}
.pkr-c{background:rgba(255,255,255,.06);border-radius:14px;padding:18px 10px;text-align:center;cursor:pointer;border:2px solid transparent;min-height:80px}
.pkr-c:active{transform:scale(.97)}
.pkr-av{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:900;margin:0 auto 8px}
.pkr-nm{font-size:.82rem;font-weight:900;color:#fff}

/* Unit grid */
.ug{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.uc{background:var(--wh);border-radius:12px;padding:12px 12px;border:1px solid var(--st);cursor:pointer}
.uc:active{transform:scale(.98)}.uc.dn{border-color:var(--ld)}
.uc-top{display:flex;justify-content:space-between;margin-bottom:3px}
.uc-n{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:var(--ink3)}
.ubg{font-size:.58rem;font-weight:800;padding:2px 7px;border-radius:999px}
.ubg.dn{background:var(--lime);color:var(--for)}.ubg.pr{background:var(--st);color:var(--ink2)}.ubg.nw{background:var(--st);color:var(--ink3)}
.uc-ti{font-size:.82rem;font-weight:900;margin-bottom:2px}
.uc-sc{font-size:.68rem;color:var(--ink3);margin-bottom:5px;line-height:1.3}
.bt{height:2px;background:var(--st);border-radius:999px;overflow:hidden}.bf{height:100%;border-radius:999px;background:var(--lime);transition:width .3s}
/* Search */
.search-results{background:var(--wh);border:1px solid var(--st);border-radius:12px;margin-top:6px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.08)}
.search-result{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--st);cursor:pointer}
.search-result:last-child{border-bottom:none}
.search-result:active{background:var(--cream)}
.search-badge{font-size:.6rem;font-weight:800;padding:3px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.5px}

/* Home header with album art gradient */
.home-hdr{position:relative;overflow:hidden;padding:48px 20px 0}
.home-hdr::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,#1F3329 0%,#2a5a3a 40%,#1A1F3D 100%);opacity:.9}
.home-hdr::after{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 80% 20%,rgba(196,240,0,.12) 0%,transparent 50%),radial-gradient(ellipse at 20% 80%,rgba(143,106,232,.08) 0%,transparent 50%)}
.home-hdr-top{display:flex;justify-content:space-between;align-items:center;position:relative;z-index:1;margin-bottom:20px}
.home-hdr-left{display:flex;align-items:center;gap:10px}
.home-hdr-title{font-size:20px;font-weight:700;color:#fff}
.home-hdr-title span{color:var(--lime)}
.home-hdr-lang{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,.4);font-weight:600}
.home-hdr-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#E8A040,#E06040);border:2px solid var(--lime);overflow:hidden}
.home-hdr-avatar img{width:100%;height:100%;object-fit:cover}
.home-greeting{position:relative;z-index:1;padding-bottom:20px}
.greeting-text{font-size:24px;font-weight:700;color:#fff;margin-bottom:4px}
.greeting-sub{font-size:13px;color:rgba(255,255,255,.7);margin-bottom:16px}
.stats-row{display:flex;gap:10px;margin-bottom:16px}
.stat-item{display:flex;flex-direction:column;align-items:center;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.08);flex:1}
.stat-num{font-size:16px;font-weight:700;color:var(--lime)}
.stat-label{font-size:9px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.5px;margin-top:1px;text-align:center;line-height:1.2}
.start-btn{width:100%;padding:16px;border-radius:14px;border:none;background:var(--lime);color:#111;font-family:'DM Sans',sans-serif;font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 16px rgba(196,240,0,.25);min-height:56px}

/* Search bar */
.home-search{width:100%;background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.06);border-radius:10px;padding:12px 16px 12px 40px;font-size:14px;color:var(--ink);outline:none;font-family:inherit;min-height:48px}
.home-search::placeholder{color:var(--ink3)}
.search-wrap{position:relative;margin:12px 16px 14px}
.search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);pointer-events:none}

/* My Library card */
.lib-card{margin:0 16px 16px;padding:18px 20px;border-radius:14px;background:var(--wh);box-shadow:0 2px 12px rgba(0,0,0,.06);display:flex;align-items:center;gap:16px;cursor:pointer;transition:transform .15s}
.lib-card:active{transform:translateY(-2px)}
.lib-card-icon{width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,#1F3329,#2a5a3a);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.lib-card-info{flex:1}
.lib-card-title{font-size:15px;font-weight:700;color:var(--ink);margin-bottom:2px}
.lib-card-sub{font-size:12px;color:var(--ink3)}

/* Section headers */
.sec-hdr{display:flex;justify-content:space-between;align-items:baseline;padding:8px 20px 12px;margin-top:8px}
.sec-title{font-size:21px;font-weight:700;color:var(--ink)}
.sec-link{font-size:12px;font-weight:600;color:var(--for);cursor:pointer}

/* Most Recent grid */
.recent-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 16px 20px}
.recent-card{display:flex;align-items:center;gap:10px;background:var(--wh);border-radius:6px;overflow:hidden;height:56px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.06);transition:background .15s}
.recent-card:active{background:#f0ede6}
.recent-card-art{width:56px;height:56px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;position:relative}
.recent-card-art img{width:100%;height:100%;object-fit:cover}
.recent-card-name{font-size:13px;font-weight:600;color:var(--ink);line-height:1.3;padding-right:8px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}

/* Continue Learning shelf */
.cont-scroll{display:flex;gap:14px;overflow-x:auto;padding:0 20px 24px;scroll-snap-type:x mandatory;scrollbar-width:none}
.cont-scroll::-webkit-scrollbar{display:none}
.cont-card{flex:0 0 170px;scroll-snap-align:start;border-radius:12px;background:var(--wh);overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);cursor:pointer;transition:transform .15s}
.cont-card:active{transform:scale(.98)}
.cont-art{height:150px;display:flex;align-items:flex-end;justify-content:space-between;padding:12px 14px;position:relative;overflow:hidden}
.cont-art img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cont-art::after{content:'';position:absolute;inset:0;background:linear-gradient(0deg,rgba(0,0,0,.5) 0%,rgba(0,0,0,.05) 50%);pointer-events:none}
.cont-art .topic-label{font-size:13px;font-weight:700;color:rgba(255,255,255,.95);text-shadow:0 1px 4px rgba(0,0,0,.4);z-index:1;position:relative;line-height:1.2}
.cont-art .play-circle{width:40px;height:40px;border-radius:50%;background:var(--lime);display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:1;position:relative;color:#111}
.cont-info{padding:10px 12px 12px}
.cont-name{font-size:13px;font-weight:600;color:var(--ink);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cont-meta{font-size:11px;color:var(--ink3);margin-bottom:6px}
.cont-pbar{height:3px;background:rgba(0,0,0,.06);border-radius:3px;overflow:hidden}
.cont-pbar-fill{height:100%;background:var(--lime);border-radius:3px}

/* 2-row topic grid */
.topics-wrap{padding:0 16px 24px;overflow-x:auto;scrollbar-width:none}
.topics-wrap::-webkit-scrollbar{display:none}
.topics-grid{display:grid;grid-template-rows:1fr 1fr;grid-auto-flow:column;grid-auto-columns:140px;gap:10px}
.t-card{border-radius:10px;overflow:hidden;cursor:pointer;transition:transform .15s;background:var(--wh);box-shadow:0 1px 6px rgba(0,0,0,.05)}
.t-card:active{transform:scale(.97)}
.t-card .t-art{height:100px;position:relative;overflow:hidden}
.t-card .t-art img{width:100%;height:100%;object-fit:cover}
.t-card .t-art .t-num{position:absolute;top:6px;right:8px;font-size:9px;font-weight:600;color:rgba(255,255,255,.7);background:rgba(0,0,0,.35);padding:2px 6px;border-radius:4px;z-index:1}
.t-card .t-info{padding:8px 10px 10px}
.t-card .t-name{font-size:12px;font-weight:600;color:var(--ink);margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t-card .t-meta{font-size:10px;color:var(--ink3)}

/* Lesson/Topic View header */
.lesson-hdr{position:relative;overflow:hidden;padding:48px 20px 20px}
.lesson-hdr::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,#1F3329 0%,#2a5a3a 50%,#1A3D3D 100%)}
.lesson-hdr::after{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 75% 25%,rgba(196,240,0,.1) 0%,transparent 50%)}
.lesson-hdr-top{display:flex;align-items:center;justify-content:space-between;position:relative;z-index:1;margin-bottom:16px}
.lesson-back{font-size:14px;color:rgba(255,255,255,.7);background:none;border:none;font-family:inherit;cursor:pointer;min-height:44px;display:flex;align-items:center}
.lesson-stats-badge{font-size:11px;color:var(--lime);font-weight:600}
.lesson-hero{position:relative;z-index:1;display:flex;align-items:center;gap:16px}
.lesson-art{width:80px;height:80px;border-radius:12px;overflow:hidden;flex-shrink:0;position:relative}
.lesson-art img{width:100%;height:100%;object-fit:cover}
.lesson-meta{flex:1}
.lesson-meta-title{font-size:18px;font-weight:700;color:#fff;margin-bottom:2px}
.lesson-meta-sub{font-size:12px;color:rgba(255,255,255,.7);margin-bottom:4px}
.lesson-meta-progress{font-size:11px;color:var(--lime);font-weight:600}

/* Controls row */
.ctrl-row{display:flex;align-items:center;gap:10px;padding:14px 16px 8px;border-bottom:1px solid rgba(0,0,0,.06)}
.play-all-btn{width:48px;height:48px;border-radius:50%;background:var(--for);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 2px 8px rgba(31,51,41,.3);min-height:48px}
.shuffle-btn{font-size:12px;color:var(--ink3);background:none;border:none;font-family:inherit;display:flex;align-items:center;gap:4px;cursor:pointer;min-height:44px}
.filter-chip{margin-left:auto;font-size:11px;padding:5px 12px;border-radius:999px;background:var(--wh);border:1px solid rgba(0,0,0,.08);color:var(--ink2);font-weight:500;cursor:pointer;min-height:36px;display:inline-flex;align-items:center}

/* Phrase items */
.ph-item{padding:12px 16px;border-bottom:1px solid rgba(0,0,0,.05);cursor:pointer;transition:background .2s}
.ph-item:active{background:rgba(0,0,0,.02)}
.ph-item.expanded{background:rgba(31,51,41,.06);border-left:3px solid var(--for);padding-left:13px}
.ph-row{display:flex;align-items:flex-start;gap:10px}
.ph-play{width:32px;height:32px;border-radius:50%;background:var(--for);border:none;display:flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;flex-shrink:0;margin-top:2px;font-size:10px}
.ph-text{flex:1;min-width:0}
.ph-eng{font-size:15px;font-weight:600;color:var(--ink);margin-bottom:3px;display:flex;justify-content:space-between;align-items:center}
.ph-chev{width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.04);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--ink3);transition:transform .2s,background .2s;flex-shrink:0;margin-left:8px}
.ph-item.expanded .ph-chev{transform:rotate(180deg);background:rgba(31,51,41,.1);color:var(--for)}
.ph-jyut{font-size:12px;color:var(--plum);font-weight:500;margin-bottom:2px}
.ph-chi{font-size:13px;color:var(--ink2)}
.ph-detail{max-height:0;overflow:hidden;transition:max-height .3s ease,padding .3s ease;padding:0}
.ph-item.expanded .ph-detail{max-height:400px;padding:12px 0 4px}
.ph-context{font-size:11px;color:var(--ink3);font-style:italic;margin-bottom:10px}
.gloss-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.gloss-chip{display:flex;flex-direction:column;align-items:center;padding:8px 12px;border-radius:10px;background:var(--wh);border:1px solid rgba(0,0,0,.06);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.gloss-chip:active{border-color:var(--for);box-shadow:0 2px 8px rgba(31,51,41,.1)}
.gloss-chi{font-size:16px;font-weight:700;color:var(--ink)}
.gloss-jyut{font-size:10px;color:var(--plum);font-weight:500}
.gloss-eng{font-size:9px;color:var(--ink3);margin-bottom:6px}
.gloss-actions{display:flex;gap:4px}
.gloss-action{width:24px;height:24px;border-radius:6px;border:1px solid rgba(0,0,0,.08);background:rgba(0,0,0,.02);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--ink2);cursor:pointer;transition:all .15s}
.gloss-action:active{background:var(--for);color:#fff;border-color:var(--for)}
.ph-actions{display:flex;gap:6px}
.ph-action-btn{flex:1;padding:10px 0;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,0,0,.1);background:var(--wh);color:var(--ink);transition:all .15s;min-height:44px}
.ph-action-btn:active{border-color:var(--for);color:var(--for)}
.ph-action-btn.shadow-btn{background:var(--for);color:#fff;border-color:var(--for)}
`;

// ============================================================
// COMPONENTS
// ============================================================

// HK Flag (bauhinia flower simplified)
const HKFlag = () => (
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <circle cx="50" cy="50" r="50" fill="#DE2910"/>
    <g transform="translate(50,50)" fill="#fff">
      {[0,72,144,216,288].map((a,i)=>(
        <g key={i} transform={`rotate(${a})`}>
          <ellipse cx="0" cy="-18" rx="6" ry="16" />
        </g>
      ))}
      <circle cx="0" cy="0" r="4" fill="#DE2910"/>
    </g>
  </svg>
);

// ---- QUIZ STYLES (added to CSS) ----
const QUIZ_CSS = `
.quiz-ov{position:fixed;inset:0;background:var(--cream);z-index:200;display:flex;flex-direction:column}
.quiz-hd{background:var(--for);padding:12px 14px;display:flex;align-items:center;justify-content:space-between}
.quiz-cl{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:999px;padding:10px 14px;font-size:.75rem;font-weight:700;cursor:pointer;min-height:44px}
.quiz-ti{font-size:.88rem;font-weight:900;color:#fff}
.quiz-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
.quiz-prompt{font-size:1.5rem;font-weight:800;color:var(--ink);margin-bottom:14px;line-height:1.3}
.quiz-sub{font-size:.85rem;color:var(--ink2);margin-bottom:22px;font-weight:600}
.quiz-reveal-btn{background:var(--lime);color:var(--for);border:none;border-radius:12px;padding:14px 28px;font-size:.85rem;font-weight:900;cursor:pointer;margin-bottom:14px;min-height:48px}
.quiz-answer{background:var(--wh);border-radius:14px;padding:20px;border:1px solid var(--st);margin-bottom:16px;width:100%;max-width:440px}
.quiz-ans-en{font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:4px}
.quiz-ans-jy{font-size:.95rem;font-style:italic;color:var(--plum);margin-bottom:4px}
.quiz-ans-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')};font-size:.88rem;color:var(--ink2)}
.quiz-grade{display:flex;gap:8px;justify-content:center;margin-top:14px}
.quiz-g-btn{padding:12px 22px;border-radius:10px;font-size:.82rem;font-weight:800;cursor:pointer;border:none;min-height:44px}
.quiz-g-yes{background:var(--lime);color:var(--for)}
.quiz-g-almost{background:var(--st);color:var(--ink2)}
.quiz-g-no{background:var(--cor);color:#fff}
.quiz-score{font-size:.78rem;color:var(--ink2);margin-top:14px;font-weight:600}
.quiz-play-btn{width:52px;height:52px;border-radius:50%;background:var(--for);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--lime);font-size:20px;margin-bottom:16px}
.quiz-input{width:100%;max-width:440px;padding:14px;border-radius:10px;border:1.5px solid var(--st);font-size:.88rem;font-weight:600;text-align:center;outline:none;margin-bottom:12px}
.quiz-input:focus{border-color:var(--plum)}
.quiz-setup{padding:20px}
.qs-card{background:var(--wh);border-radius:14px;padding:20px;border:1px solid var(--st);margin-bottom:10px;cursor:pointer;text-align:center}
.qs-card:hover{border-color:var(--ld);background:#FAFFF0}
.qs-card.on{border-color:var(--ld);background:#FAFFF0}
.qs-ti{font-size:1.1rem;font-weight:900;margin-bottom:4px}
.qs-sub{font-size:.82rem;color:var(--ink2);line-height:1.4}

/* Learning mode: Reading — Chinese characters prominent, jyutping secondary */
.reading-mode .ph-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')};font-size:1.3rem;font-weight:700;color:var(--ink);margin-bottom:4px;order:-1}
.reading-mode .ph-jy{font-size:.68rem;color:var(--plum);margin-bottom:2px;order:0}
.reading-mode .ph-en{font-size:.72rem;color:var(--ink3);margin-bottom:6px;order:1}
.reading-mode .sh-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')};font-size:1.8rem;font-weight:900;color:#fff;margin-bottom:8px;opacity:1}
.reading-mode .sh-cn.hid{opacity:0}
.reading-mode .sh-jy{font-size:.82rem;color:var(--lime);margin-bottom:4px}
.reading-mode .sh-en{font-size:.78rem;font-weight:600;color:rgba(255,255,255,.5);margin-bottom:4px}
.reading-mode .wc-cn{font-family:${LANG_CONFIG.fontFamily.replace(/'/g, '')};font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:2px;order:-1}
.reading-mode .wc-jy{font-size:.58rem;color:var(--plum);order:0}
.reading-mode .wc-en{font-size:.62rem;color:var(--ink3);order:1}
.reading-mode .wc{display:flex;flex-direction:column}
.reading-mode .card{display:flex;flex-direction:column}
@media(min-width:768px){
  .reading-mode .ph-cn{font-size:1.5rem}
  .reading-mode .sh-cn{font-size:2.2rem}
  .reading-mode .wc-cn{font-size:1.1rem}
}

/* Playlist view (legacy kept for PhraseCard compat) */
.playlist-header{background:linear-gradient(160deg, #1F3329 0%, #2a4535 100%);border-radius:20px;padding:20px;margin-bottom:0;position:relative;overflow:hidden}
.playlist-header::after{content:'';position:absolute;top:-50%;right:-30%;width:200px;height:200px;background:radial-gradient(circle,rgba(196,240,0,.06) 0%,transparent 70%);pointer-events:none}
.action-bar{position:sticky;top:0;z-index:50;background:var(--wh);padding:12px 0;display:flex;align-items:center;gap:10px;border-bottom:1px solid transparent;transition:border-color .2s}
.action-bar.scrolled{border-bottom-color:var(--st);box-shadow:0 2px 8px rgba(0,0,0,.04)}
.action-pill{background:none;border:1.5px solid var(--st);border-radius:999px;padding:10px 16px;font-size:.75rem;font-weight:700;color:var(--ink);cursor:pointer;min-height:44px;display:inline-flex;align-items:center;gap:6px;transition:all .15s}
.action-pill:active{background:var(--cream)}
.action-pill.on{background:rgba(196,240,0,.1);border-color:var(--lime);color:var(--for)}
.track{background:var(--wh);border:1px solid var(--st);border-radius:14px;padding:14px;margin-bottom:8px;transition:all .2s}
.track.known{background:rgba(196,240,0,.04);border-color:rgba(196,240,0,.2)}
.track-expand{max-height:0;overflow:hidden;transition:max-height .3s ease}
.track-expand.open{max-height:600px}
.track-chevron{transition:transform .2s;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:.8rem;color:var(--ink3);width:32px;height:32px;border-radius:50%;flex-shrink:0}
.track-chevron:active{background:var(--cream)}
.track-chevron.open{transform:rotate(180deg)}
.bottom-sheet-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:flex-end;justify-content:center;animation:bsOverIn .2s ease}
@keyframes bsOverIn{from{opacity:0}to{opacity:1}}
.bottom-sheet{background:var(--wh);border-radius:20px 20px 0 0;padding:20px;width:100%;max-width:500px;max-height:70vh;animation:bsSlideUp .25s ease}
@keyframes bsSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.bottom-sheet-handle{width:40px;height:4px;background:var(--st);border-radius:2px;margin:0 auto 16px}
.bottom-sheet-opt{width:100%;padding:14px 0;border:none;background:none;font-size:.85rem;font-weight:700;color:var(--ink);cursor:pointer;text-align:left;display:flex;align-items:center;gap:10px;min-height:48px;border-bottom:1px solid var(--st)}
.bottom-sheet-opt:last-child{border-bottom:none}
.bottom-sheet-opt:active{background:var(--cream)}
.track-play-btn{width:40px;height:40px;border-radius:50%;border:none;background:var(--for);color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:transform .1s}
.track-play-btn:active{transform:scale(.92)}
.track-know-btn{border:1.5px solid var(--lime);border-radius:999px;padding:8px 14px;font-size:.7rem;font-weight:800;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;gap:4px;transition:all .15s;background:none;color:var(--for);white-space:nowrap}
.track-know-btn.known{background:var(--lime);color:var(--for);border-color:var(--lime)}
.track-know-btn:active{transform:scale(.95)}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes celebPop{0%{transform:scale(0);opacity:0}50%{transform:scale(1.2)}100%{transform:scale(1);opacity:1}}
@keyframes confettiFall{0%{transform:translateY(-20px) rotate(0deg);opacity:1}100%{transform:translateY(200px) rotate(720deg);opacity:0}}
`;

// ---- QUIZ COMPONENTS ----
function QuizTab({ progress, upd }) {
  const [mode, setMode] = useState(null);
  const [quizItems, setQuizItems] = useState([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState({ right: 0, almost: 0, wrong: 0 });
  const [done, setDone] = useState(false);
  const [dictAnswer, setDictAnswer] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [scoreResult, setScoreResult] = useState(null);
  const [picking, setPicking] = useState(false);
  const [selectedUnits, setSelectedUnits] = useState(new Set());
  const [source, setSource] = useState("known");
  const [pronScores, setPronScores] = useState([]);

  const knownPhrases = useMemo(() => {
    const items = [];
    UNITS.forEach(u => { u.phrases.forEach((p, i) => { const key = `${u.id}-${i}`; if ((progress.phrases || {})[key]) items.push({ ...p, unitId: u.id, phraseIdx: i, key }); }); });
    return items;
  }, [progress]);

  const getUnitPhrases = () => {
    const items = [];
    UNITS.forEach(u => { if (selectedUnits.has(u.id)) u.phrases.forEach((p, i) => items.push({ ...p, unitId: u.id, phraseIdx: i, key: `${u.id}-${i}` })); });
    return items;
  };

  const startQuiz = (m, src) => {
    let pool = src === "units" ? getUnitPhrases() : src === "all" ? UNITS.flatMap(u => u.phrases.map((p, i) => ({ ...p, unitId: u.id, phraseIdx: i, key: `${u.id}-${i}` }))) : knownPhrases;
    setQuizItems([...pool].sort(() => Math.random() - 0.5).slice(0, 20));
    setMode(m); setSource(src); setIdx(0); setRevealed(false); setScore({ right: 0, almost: 0, wrong: 0 }); setDone(false); setDictAnswer(""); setPicking(false); setScoreResult(null); setPronScores([]);
  };

  const grade = (result) => {
    const item = quizItems[idx];
    if (result === "wrong" && source === "known") upd(`phrases.${item.key}`, false);
    setScore(prev => ({ ...prev, [result]: prev[result] + 1 }));
    setRevealed(false); setDictAnswer(""); setScoreResult(null);
    if (idx + 1 >= quizItems.length) setDone(true); else setIdx(i => i + 1);
  };

  const pronNext = () => {
    if (scoreResult) setPronScores(prev => [...prev, scoreResult.score]);
    setScoreResult(null); setIsRecording(false); setScoring(false);
    if (idx + 1 >= quizItems.length) setDone(true); else setIdx(i => i + 1);
  };
  const pronSkip = () => {
    setPronScores(prev => [...prev, null]);
    setScoreResult(null); setIsRecording(false); setScoring(false);
    if (idx + 1 >= quizItems.length) setDone(true); else setIdx(i => i + 1);
  };

  const toggleUnit = (id) => { setSelectedUnits(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); };

  const qStartTest = async () => { stopAudio(); try { const ok = await startRecording(); if (ok) setIsRecording(true); } catch(e) { console.warn("Mic error:", e); } };
  const qStopTest = async () => {
    setIsRecording(false); setScoring(true);
    const blob = await stopRecording(); const ph = quizItems[idx];
    if (blob && ph) {
      try {
        const result = await scorePronunciation(blob, ph.cn, LANG_CONFIG.id);
        let chars = [];
        if (result.expectedJyutping && result.transcribedJyutping) {
          const expSyls = result.expectedJyutping.trim().split(/\s+/); const yourSyls = result.transcribedJyutping.trim().split(/\s+/); const cnChars = ph.cn.replace(/[，,。！？!?\s]/g, "").split("");
          for (let i = 0; i < Math.max(expSyls.length, cnChars.length); i++) chars.push({ cn: cnChars[i] || "", e: expSyls[i] || "", y: yourSyls[i] || "", m: expSyls[i] === yourSyls[i] ? 1 : 0 });
        }
        setScoreResult({ score: result.score, passed: result.passed, chars, phrase: ph });
      } catch(e) { console.error("Scoring error:", e); setScoreResult(null); }
    }
    setScoring(false);
  };

  if (picking) {
    const unitCount = selectedUnits.size; const phraseCount = getUnitPhrases().length;
    const topicIcons = {1:"👋",2:"🤝",3:"🚕",4:"☕",5:"🍜",6:"🛍",7:"🏫",8:"🏠",9:"🕐",10:"❤️",11:"🍻",12:"🌧",13:"💰",14:"💪",15:"😤",16:"📱",17:"🥺",18:"🔢",19:"🎉",20:"🌇"};
    return (<div className="mc">
      <div className="pt">Pick units to practise 🎙</div>
      <div className="ps">Tap the units you want in your pronunciation quiz.</div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,margin:"16px 0"}}>
        {UNITS.map(u=>{
          const k=u.phrases.filter((_,i)=>(progress.phrases||{})[`${u.id}-${i}`]).length;
          const pct=Math.round(k/u.phrases.length*100);
          const isSel=selectedUnits.has(u.id);
          return (
            <div key={u.id} onClick={()=>toggleUnit(u.id)} style={{
              background:isSel?"rgba(196,240,0,.1)":"var(--wh)",
              borderRadius:12,padding:"14px 12px 10px",
              border:isSel?"2px solid var(--lime)":"1px solid var(--st)",
              cursor:"pointer",transition:"all .15s",
            }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:"1.3rem"}}>{isSel?"✅":topicIcons[u.id]||"📖"}</span>
                <span style={{fontSize:".72rem",fontWeight:800,color:isSel?"var(--ld)":"var(--ink3)"}}>{k}/{u.phrases.length}</span>
              </div>
              <div style={{fontSize:".82rem",fontWeight:800,color:isSel?"var(--for)":"var(--ink)",lineHeight:1.2,marginBottom:5}}>{u.title}</div>
              <div style={{height:4,background:"var(--st)",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:isSel?"var(--lime)":"var(--st2)",borderRadius:2,transition:"width .3s"}} /></div>
            </div>
          );
        })}
      </div>

      <div style={{display:"flex",gap:6,margin:"8px 0"}}>
        <button onClick={()=>setSelectedUnits(new Set(UNITS.map(u=>u.id)))} style={{flex:1,padding:"10px",borderRadius:10,border:"1.5px solid var(--st)",background:"var(--wh)",fontSize:".72rem",fontWeight:700,color:"var(--ink)",cursor:"pointer"}}>Select all</button>
        <button onClick={()=>setSelectedUnits(new Set())} style={{flex:1,padding:"10px",borderRadius:10,border:"1.5px solid var(--st)",background:"var(--wh)",fontSize:".72rem",fontWeight:700,color:"var(--ink)",cursor:"pointer"}}>Clear</button>
      </div>

      {unitCount > 0 && (<div style={{textAlign:"center",margin:"16px 0"}}>
        <div style={{fontSize:".75rem",color:"var(--ink2)",marginBottom:10,fontWeight:600}}>{unitCount} unit{unitCount>1?"s":""} selected, {phraseCount} phrases</div>
        <button onClick={()=>startQuiz("pronunciation","units")} style={{padding:"16px 32px",borderRadius:14,border:"none",background:"var(--lime)",color:"var(--for)",fontSize:".88rem",fontWeight:900,cursor:"pointer",width:"100%"}}>🎙 Start with {Math.min(phraseCount,20)} phrases</button>
      </div>)}
      <button onClick={()=>setPicking(false)} style={{display:"block",margin:"14px auto 0",background:"none",border:"none",cursor:"pointer",fontSize:".75rem",fontWeight:600,color:"var(--ink2)"}}>← Back</button>
    </div>);
  }

  if (!mode) {
    const hasEnough = knownPhrases.length >= 3;
    return (<div className="mc">
      <div className="pt">Test yourself 🎯</div>
      <div className="ps">Three ways to practise. Pick the one that fits your mood!</div>

      <div className="qs-card" onClick={()=>hasEnough&&startQuiz("speaking","known")} style={{opacity:hasEnough?1:.4,pointerEvents:hasEnough?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <div style={{fontSize:"1.6rem"}}>🧠</div>
          <div><div className="qs-ti">Recall Quiz</div><div style={{fontSize:".62rem",color:"var(--ink3)",fontWeight:600}}>From your {knownPhrases.length} known phrases</div></div>
        </div>
        <div className="qs-sub">See the English and try to remember the Cantonese. Good for building memory. You grade yourself.</div>
      </div>

      <div className="qs-card" onClick={()=>hasEnough&&startQuiz("listening","known")} style={{opacity:hasEnough?1:.4,pointerEvents:hasEnough?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <div style={{fontSize:"1.6rem"}}>👂</div>
          <div><div className="qs-ti">Listening Quiz</div><div style={{fontSize:".62rem",color:"var(--ink3)",fontWeight:600}}>From your {knownPhrases.length} known phrases</div></div>
        </div>
        <div className="qs-sub">Hear the Cantonese and type what it means in English. Trains your ear to catch real speech.</div>
      </div>

      {!hasEnough && <div style={{fontSize:".72rem",color:"var(--ink2)",textAlign:"center",margin:"6px 0 10px",fontWeight:600}}>Mark at least 3 phrases as known in Phrases to unlock the quizzes above 💪</div>}

      <div style={{borderTop:"1.5px solid var(--st)",margin:"14px 0"}} />

      <div className="qs-card" onClick={()=>setPicking(true)} style={{border:"2px solid var(--lime)",background:"rgba(196,240,0,.04)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <div style={{fontSize:"1.6rem"}}>🎙</div>
          <div><div className="qs-ti">Pronunciation Quiz</div><div style={{fontSize:".62rem",color:"var(--ld)",fontWeight:700}}>Pick any units, no experience needed</div></div>
        </div>
        <div className="qs-sub">Pick which units to practise, then record yourself saying each phrase out loud. The AI scores your pronunciation and shows you which sounds you nailed and which need work.</div>
      </div>
    </div>);
  }

  if (done) {
    if (mode === "pronunciation") {
      const scored = pronScores.filter(s => s !== null); const avg = scored.length ? Math.round(scored.reduce((a,b)=>a+b,0)/scored.length) : 0;
      return (<div className="comp-ov">
        <div className="comp-em">{avg >= 80 ? "🌟" : avg >= 60 ? "💪" : "📝"}</div>
        <div className="comp-t">{avg >= 80 ? "Amazing pronunciation!" : avg >= 60 ? "Getting there!" : "Good practice!"}</div>
        <div className="comp-s">Average score: {avg}% across {scored.length} phrase{scored.length!==1?"s":""}{pronScores.length-scored.length>0?` (${pronScores.length-scored.length} skipped)`:""}</div>
        <button className="comp-btn" onClick={() => setMode(null)}>Done</button>
      </div>);
    }
    const total = score.right + score.almost + score.wrong; const pct = total ? Math.round(score.right / total * 100) : 0;
    return (<div className="comp-ov">
      <div className="comp-em">{pct >= 80 ? "🌟" : pct >= 50 ? "💪" : "📝"}</div>
      <div className="comp-t">{pct >= 80 ? "Amazing work!" : pct >= 50 ? "Great effort!" : "Good practice!"}</div>
      <div className="comp-s">{score.right}/{total} correct · {score.wrong > 0 ? `${score.wrong} sent back for more practice` : "nothing sent back!"}</div>
      <div style={{display:"flex",gap:10,marginBottom:16}}>
        <div style={{background:"rgba(196,240,0,.15)",borderRadius:10,padding:"10px 16px",textAlign:"center"}}><div style={{fontSize:"1.2rem",fontWeight:900,color:"var(--lime)"}}>{score.right}</div><div style={{fontSize:".52rem",color:"rgba(255,255,255,.4)",fontWeight:700}}>Got it</div></div>
        <div style={{background:"rgba(255,255,255,.06)",borderRadius:10,padding:"10px 16px",textAlign:"center"}}><div style={{fontSize:"1.2rem",fontWeight:900,color:"#fff"}}>{score.almost}</div><div style={{fontSize:".52rem",color:"rgba(255,255,255,.4)",fontWeight:700}}>Almost</div></div>
        <div style={{background:"rgba(240,90,58,.15)",borderRadius:10,padding:"10px 16px",textAlign:"center"}}><div style={{fontSize:"1.2rem",fontWeight:900,color:"var(--cor)"}}>{score.wrong}</div><div style={{fontSize:".52rem",color:"rgba(255,255,255,.4)",fontWeight:700}}>Review</div></div>
      </div>
      <button className="comp-btn" onClick={() => setMode(null)}>Done</button>
    </div>);
  }

  const item = quizItems[idx];

  if (mode === "pronunciation") {
    return (<div className="quiz-ov">
      <div className="quiz-hd">
        <button className="quiz-cl" onClick={()=>{setMode(null);setScoreResult(null);}}>✕ End</button>
        <div className="quiz-ti">🎙 Pronunciation</div>
        <div style={{fontSize:".65rem",color:"rgba(255,255,255,.4)"}}>{idx+1}/{quizItems.length}</div>
      </div>
      <div className="quiz-body">
        <div className="quiz-sub" style={{marginBottom:4}}>Say this out loud in Cantonese:</div>
        <div className="quiz-prompt" style={{marginBottom:6}}>{item.en}</div>
        <div style={{marginBottom:4}}>
          <div style={{fontSize:".95rem",fontStyle:"italic",color:"var(--plum)",fontWeight:600}}><JyutpingTone text={item.jyut} /></div>
          <div style={{fontFamily:"${LANG_CONFIG.fontFamily.replace(/'/g, '')}",fontSize:".88rem",color:"var(--ink2)",marginTop:2}}>{item.cn}</div>
        </div>
        <button style={{marginBottom:14,background:"var(--for)",border:"none",borderRadius:999,padding:"8px 16px",fontSize:".68rem",cursor:"pointer",color:"var(--lime)",fontWeight:700}} onClick={()=>speak(item.cn)}>▶ Listen first</button>
        <div style={{width:"100%",maxWidth:440}}>
          {!isRecording && !scoring && !scoreResult ? (
            <RecordBtn onClick={qStartTest} label="🎙 Record yourself" />
          ) : scoring ? (
            <div style={{width:"100%",padding:"16px",borderRadius:14,background:"rgba(0,0,0,.04)",textAlign:"center"}}><div style={{fontSize:".82rem",fontWeight:700,color:"var(--ink2)"}}>Scoring...</div></div>
          ) : isRecording ? (
            <button onClick={qStopTest} style={{width:"100%",padding:"16px",borderRadius:14,border:"none",background:"#e74c3c",color:"#fff",fontSize:".88rem",fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,animation:"pulse 1s ease-in-out infinite"}}>⏹ Stop and score</button>
          ) : null}
        </div>
        {!scoreResult && !isRecording && !scoring && (<button onClick={pronSkip} style={{marginTop:10,background:"none",border:"none",cursor:"pointer",fontSize:".72rem",fontWeight:600,color:"var(--ink3)"}}>Skip →</button>)}
        <div style={{fontSize:".65rem",color:"var(--ink3)",marginTop:10}}>{idx+1} of {quizItems.length}</div>
      </div>
      {scoreResult && <PronunciationScore score={scoreResult.score} chars={scoreResult.chars} phrase={scoreResult.phrase} onRetry={()=>{setScoreResult(null);qStartTest();}} onNext={pronNext} onClose={pronNext} />}
    </div>);
  }

  if (mode === "speaking") {
    return (<div className="quiz-ov">
      <div className="quiz-hd">
        <button className="quiz-cl" onClick={()=>setMode(null)}>✕ End</button>
        <div className="quiz-ti">🧠 Recall</div>
        <div style={{fontSize:".65rem",color:"rgba(255,255,255,.4)"}}>{idx+1}/{quizItems.length}</div>
      </div>
      <div className="quiz-body">
        <div className="quiz-sub">What's this in Cantonese?</div>
        <div className="quiz-prompt">{item.en}</div>
        {!revealed ? (<button className="quiz-reveal-btn" onClick={()=>setRevealed(true)}>Reveal answer</button>) : (<>
          <div className="quiz-answer">
            <div className="quiz-ans-jy"><JyutpingTone text={item.jyut} /></div>
            <div className="quiz-ans-cn">{item.cn}</div>
            <button style={{marginTop:8,background:"var(--for)",border:"none",borderRadius:999,padding:"8px 16px",fontSize:".68rem",cursor:"pointer",color:"var(--lime)",fontWeight:700}} onClick={()=>speak(item.cn)}>▶ Listen</button>
          </div>
          <div style={{fontSize:".68rem",color:"var(--ink3)",marginBottom:8}}>How did you do?</div>
          <div className="quiz-grade">
            <button className="quiz-g-btn quiz-g-yes" onClick={()=>grade("right")}>✓ Got it</button>
            <button className="quiz-g-btn quiz-g-almost" onClick={()=>grade("almost")}>~ Almost</button>
            <button className="quiz-g-btn quiz-g-no" onClick={()=>grade("wrong")}>✗ Nope</button>
          </div>
        </>)}
        <div className="quiz-score">{score.right} correct · {score.wrong} sent back</div>
      </div>
    </div>);
  }

  if (mode === "listening") {
    return (<div className="quiz-ov">
      <div className="quiz-hd">
        <button className="quiz-cl" onClick={()=>setMode(null)}>✕ End</button>
        <div className="quiz-ti">👂 Listening</div>
        <div style={{fontSize:".65rem",color:"rgba(255,255,255,.4)"}}>{idx+1}/{quizItems.length}</div>
      </div>
      <div className="quiz-body">
        <div className="quiz-sub">Listen carefully, then type what it means:</div>
        <button className="quiz-play-btn" onClick={()=>speak(item.cn)}>▶</button>
        {!revealed ? (<>
          <input className="quiz-input" placeholder="Type the English meaning..." value={dictAnswer} onChange={e=>setDictAnswer(e.target.value)} onKeyDown={e=>e.key==="Enter"&&setRevealed(true)} />
          <button className="quiz-reveal-btn" onClick={()=>setRevealed(true)}>Check my answer</button>
        </>) : (<>
          <div className="quiz-answer">
            <div className="quiz-ans-en">{item.en}</div>
            <div className="quiz-ans-jy"><JyutpingTone text={item.jyut} /></div>
            <div className="quiz-ans-cn">{item.cn}</div>
            {dictAnswer && <div style={{marginTop:8,fontSize:".72rem",color:"var(--ink2)",padding:"6px 10px",background:"var(--cream)",borderRadius:8}}>Your answer: "{dictAnswer}"</div>}
          </div>
          <div style={{fontSize:".68rem",color:"var(--ink3)",marginBottom:8}}>Were you close?</div>
          <div className="quiz-grade">
            <button className="quiz-g-btn quiz-g-yes" onClick={()=>grade("right")}>✓ Got it</button>
            <button className="quiz-g-btn quiz-g-almost" onClick={()=>grade("almost")}>~ Almost</button>
            <button className="quiz-g-btn quiz-g-no" onClick={()=>grade("wrong")}>✗ Nope</button>
          </div>
        </>)}
        <div className="quiz-score">{score.right} correct · {score.wrong} sent back</div>
      </div>
    </div>);
  }

  return null;
}

// ---- OFFLINE HOOK ----
function useIsOnline() {
  const [online, setOnline] = useState(_isOnline);
  useEffect(() => {
    const unsub = onOnlineChange(setOnline);
    return unsub;
  }, []);
  return online;
}

// ---- OFFLINE BANNER COMPONENT ----
function OfflineBanner() {
  const isOnline = useIsOnline();
  if (isOnline) return null;
  return (
    <div style={{
      position:"fixed",top:0,left:0,right:0,zIndex:9999,
      display:"flex",alignItems:"center",justifyContent:"center",gap:6,
      padding:"6px 16px",
      background:"rgba(44,44,44,.92)",backdropFilter:"blur(8px)",
      borderBottom:"1px solid rgba(255,255,255,.08)",
      animation:"slideDown .3s ease"
    }}>
      <div style={{width:6,height:6,borderRadius:"50%",background:"#F05A3A",flexShrink:0}}></div>
      <span style={{fontSize:".68rem",fontWeight:700,color:"rgba(255,255,255,.8)",letterSpacing:".3px"}}>Offline mode</span>
    </div>
  );
}

// ---- OFFLINE-AWARE RECORD BUTTON ----
// Wraps any record action: if offline, shows a message instead of the button
function RecordBtn({ onClick, label, style }) {
  const isOnline = useIsOnline();
  if (!isOnline) {
    return (
      <div style={{width:"100%",padding:"14px 16px",borderRadius:14,background:"rgba(0,0,0,.04)",textAlign:"center",border:"1.5px dashed var(--st2)"}}>
        <div style={{fontSize:".75rem",fontWeight:700,color:"var(--ink3)"}}>Go online to test your pronunciation</div>
        <div style={{fontSize:".62rem",color:"var(--ink3)",marginTop:4}}>Recording requires an internet connection for scoring</div>
      </div>
    );
  }
  return <button onClick={onClick} style={style || {width:"100%",padding:"16px",borderRadius:14,border:"none",background:"var(--for)",color:"#fff",fontSize:".88rem",fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>{label || "🎙 Record yourself"}</button>;
}

// Free units — these are accessible without premium
const FREE_UNIT_IDS = [1, 2, 5];

// ---- PREMIUM GATE ----
function PremiumGate({ onClose, onUnlock, user }) {
  const [showPromo, setShowPromo] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [promoStatus, setPromoStatus] = useState(null); // null | "checking" | "success" | "error"

  useEffect(() => { trackEvent('paywall_shown'); }, []);

  const handlePromo = async () => {
    if (!promoCode.trim()) return;
    trackEvent('promo_code_entered', { code: promoCode.trim() });
    setPromoStatus("checking");
    try {
      const doc = await fbDb.collection("config").doc("promoCodes").get();
      if (doc.exists) {
        const codes = doc.data().codes || [];
        const match = codes.find(c => c.code.toUpperCase() === promoCode.trim().toUpperCase() && c.active);
        if (match) {
          // Set premium in user profile
          await fbDb.collection("users").doc(user.uid).update({
            isPremium: true,
            premiumSince: new Date(),
            premiumTier: "promo",
            promoCodeUsed: match.code,
          });
          setPromoStatus("success");
          hapticLight();
          trackEvent('promo_code_redeemed', { code: match.code });
          setTimeout(() => onUnlock(), 1500);
          return;
        }
      }
      setPromoStatus("error");
    } catch (e) {
      console.warn("Promo check failed:", e);
      setPromoStatus("error");
    }
  };

  const handlePricingClick = (tier) => {
    console.log("Payment clicked:", tier);
    // Toast — payment integration placeholder
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:16,backdropFilter:"blur(4px)"}}>
      <div style={{background:"#fff",borderRadius:20,maxWidth:420,width:"100%",maxHeight:"90vh",overflow:"auto",padding:"28px 24px",position:"relative"}}>
        <button onClick={()=>{trackEvent('paywall_dismissed');onClose();}} style={{position:"absolute",top:12,right:12,background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#7A756E",padding:8,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        <div style={{textAlign:"center",marginBottom:20}}>
          <div style={{fontSize:32,marginBottom:8}}>🔓</div>
          <div style={{fontSize:22,fontWeight:900,color:"#1F3329",marginBottom:4}}>Unlock ShadowSpeak Premium</div>
          <div style={{fontSize:14,color:"#7A756E",lineHeight:1.5}}>Full curriculum. All languages. Pronunciation scoring.</div>
        </div>

        {/* Pricing cards */}
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
          <button onClick={()=>handlePricingClick("monthly")} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 18px",borderRadius:14,border:"1.5px solid #EDE8E0",background:"#fff",cursor:"pointer",fontFamily:"inherit"}}>
            <div style={{textAlign:"left"}}>
              <div style={{fontSize:15,fontWeight:800,color:"#1F3329"}}>Monthly</div>
              <div style={{fontSize:12,color:"#7A756E"}}>Cancel anytime</div>
            </div>
            <div style={{fontSize:18,fontWeight:900,color:"#1F3329"}}>HKD 98<span style={{fontSize:12,fontWeight:600,color:"#7A756E"}}>/mo</span></div>
          </button>

          <button onClick={()=>handlePricingClick("annual")} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 18px",borderRadius:14,border:"2px solid #C4F000",background:"rgba(196,240,0,.08)",cursor:"pointer",fontFamily:"inherit",position:"relative"}}>
            <div style={{position:"absolute",top:-10,left:16,background:"#C4F000",color:"#1F3329",fontSize:11,fontWeight:800,padding:"3px 10px",borderRadius:999}}>Best value — Save 49%</div>
            <div style={{textAlign:"left"}}>
              <div style={{fontSize:15,fontWeight:800,color:"#1F3329"}}>Annual</div>
              <div style={{fontSize:12,color:"#7A756E"}}>HKD 50/month effective</div>
            </div>
            <div style={{fontSize:18,fontWeight:900,color:"#1F3329"}}>HKD 598<span style={{fontSize:12,fontWeight:600,color:"#7A756E"}}>/yr</span></div>
          </button>

          <button onClick={()=>handlePricingClick("lifetime")} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 18px",borderRadius:14,border:"1.5px solid #EDE8E0",background:"#fff",cursor:"pointer",fontFamily:"inherit"}}>
            <div style={{textAlign:"left"}}>
              <div style={{fontSize:15,fontWeight:800,color:"#1F3329"}}>Lifetime</div>
              <div style={{fontSize:12,color:"#7A756E"}}>Pay once, learn forever</div>
            </div>
            <div style={{fontSize:18,fontWeight:900,color:"#1F3329"}}>HKD 1,280</div>
          </button>
        </div>

        <div style={{textAlign:"center",fontSize:12,color:"#7A756E",marginBottom:16}}>Payment integration coming soon.</div>

        {/* Promo code */}
        <div style={{borderTop:"1px solid #EDE8E0",paddingTop:14}}>
          <button onClick={()=>setShowPromo(!showPromo)} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,fontWeight:700,color:"#5A554F",padding:0}}>
            {showPromo ? "Hide promo code" : "Have a promo code?"}
          </button>
          {showPromo && (
            <div style={{display:"flex",gap:8,marginTop:10}}>
              <input value={promoCode} onChange={e=>setPromoCode(e.target.value)} placeholder="Enter code" style={{flex:1,padding:"10px 14px",borderRadius:10,border:"1.5px solid #EDE8E0",fontSize:14,fontFamily:"inherit",outline:"none",minHeight:44}} onKeyDown={e=>e.key==="Enter"&&handlePromo()} />
              <button onClick={handlePromo} disabled={promoStatus==="checking"} style={{padding:"10px 18px",borderRadius:10,border:"none",background:"#1F3329",color:"#C4F000",fontSize:14,fontWeight:700,cursor:"pointer",minHeight:44,minWidth:44}}>{promoStatus==="checking"?"...":"Apply"}</button>
            </div>
          )}
          {promoStatus==="success"&&<div style={{marginTop:8,fontSize:13,fontWeight:700,color:"#27ae60"}}>Unlocked. Welcome to ShadowSpeak Premium.</div>}
          {promoStatus==="error"&&<div style={{marginTop:8,fontSize:13,fontWeight:700,color:"#e74c3c"}}>Code not recognised.</div>}
        </div>

        {/* Coming soon languages */}
        <div style={{marginTop:20,textAlign:"center"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#7A756E",marginBottom:8}}>More languages coming to ShadowSpeak Premium</div>
          <div style={{display:"flex",justifyContent:"center",gap:16}}>
            <span style={{fontSize:24,opacity:.4}}>🇯🇵</span>
            <span style={{fontSize:24,opacity:.4}}>🇰🇷</span>
            <span style={{fontSize:24,opacity:.4}}>🇹🇭</span>
          </div>
          <div style={{fontSize:11,color:"#AEA9A3",marginTop:4}}>Japanese, Korean, Thai</div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tab, setTab] = useState("home");
  const [selUnit, setSelUnit] = useState(null);
  const [progress, setProgress] = useState({ phrases:{}, vocab:{}, unit10:[], phraseTs:{}, lastReview:{}, lessonLog:[], quizCount:0 });
  const [settings, setSettings] = useState({});
  const [popup, setPopup] = useState(null);
  const [playlist, setPlaylist] = useState(null);
  const [profileMenu, setProfileMenu] = useState(false);
  const [library, setLibrary] = useState([]);
  const [isPremium, setIsPremium] = useState(false);
  const [showPremiumGate, setShowPremiumGate] = useState(false);
  const [quickCheck, setQuickCheck] = useState(null);
  const [practiceMode, setPracticeMode] = useState(null);
  const [practiceCount, setPracticeCount] = useState(parseInt(localStorage.getItem(LANG_CONFIG.id + '-practice-count') || '0'));
  const [recentTopics, setRecentTopics] = useState(JSON.parse(localStorage.getItem(LANG_CONFIG.id + '-recent-topics') || '[]'));
  const saveTimer = useRef(null);

  // Inject CSS + track app open
  useEffect(() => {
    const s = document.createElement("style"); s.textContent = CSS + QUIZ_CSS; document.head.appendChild(s);
    localStorage.setItem('shadowspeak-last-lang', LANG_CONFIG.id);
    trackEvent('app_open');
    return () => document.head.removeChild(s);
  }, []);

  // Firebase auth listener
  useEffect(() => {
    const unsub = fbAuth.onAuthStateChanged(u => {
      setUser(u);
      window._ssUser = u; // for analytics
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  // Load progress from Firestore when user signs in
  useEffect(() => {
    if (!user) return;
    (async () => {
      // Ensure user profile exists and update lastActiveAt
      const profile = await ensureUserProfile(user);
      if (profile?.isPremium) setIsPremium(true);

      // Try Firestore first, fall back to localStorage
      const cloud = await loadFromFirestore(user.uid);
      if (cloud) {
        setProgress({ phrases:cloud.phrases||{}, vocab:cloud.vocab||{}, unit10:cloud.unit10||[], phraseTs:cloud.phraseTs||{}, lastReview:cloud.lastReview||{}, lessonLog:cloud.lessonLog||[], quizCount:cloud.quizCount||0 });
      } else {
        // Migrate from old localStorage if exists
        const oldProfile = localStorage.getItem(`${LANG_CONFIG.id}-profile`);
        if (oldProfile) {
          const d = JSON.parse(localStorage.getItem(`${LANG_CONFIG.localStoragePrefix}${oldProfile}`)||"{}");
          const migrated = { phrases:d.phrases||{}, vocab:d.vocab||{}, unit10:d.unit10||[], phraseTs:d.phraseTs||{}, lastReview:d.lastReview||{}, lessonLog:d.lessonLog||[], quizCount:d.quizCount||0 };
          setProgress(migrated);
          saveToFirestore(user.uid, migrated); // migrate up to cloud
        }
      }
      const cloudSettings = await loadSettingsFromFirestore(user.uid);
      const ls = JSON.parse(localStorage.getItem(LANG_CONFIG.localStorageSettingsKey)||"{}");
      if (cloudSettings) {
        // Merge: if localStorage says onboarding done but cloud doesn't, trust localStorage
        if (ls.onboardingDone && !cloudSettings.onboardingDone) {
          cloudSettings.onboardingDone = true;
          saveSettingsToFirestore(user.uid, cloudSettings);
        }
        setSettings(cloudSettings);
        localStorage.setItem(LANG_CONFIG.localStorageSettingsKey, JSON.stringify(cloudSettings));
        _activeEnVoiceId = cloudSettings.enVoice || DEFAULT_EN_VOICE;
        _activeCnVoiceId = cloudSettings.cnVoice || DEFAULT_CN_VOICE;
      } else if (ls.onboardingDone) {
        // Cloud failed but localStorage has completed onboarding — use it
        setSettings(ls);
        _activeEnVoiceId = ls.enVoice || DEFAULT_EN_VOICE;
        _activeCnVoiceId = ls.cnVoice || DEFAULT_CN_VOICE;
      } else {
        const defaults = { learnMode: ls.learnMode||"speaking", enVoice: DEFAULT_EN_VOICE, cnVoice: DEFAULT_CN_VOICE, defaultSpeed: "normal", onboardingDone: false };
        setSettings(defaults);
        _activeEnVoiceId = DEFAULT_EN_VOICE;
        _activeCnVoiceId = DEFAULT_CN_VOICE;
      }
    })();
  }, [user]);

  // Debounced save: localStorage immediately, Firestore after 2s idle
  const save = useCallback((updated) => {
    if (!user) return;
    localStorage.setItem(`${LANG_CONFIG.localStoragePrefix}${user.uid}`, JSON.stringify(updated));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveToFirestore(user.uid, updated), 2000);
  }, [user]);

  const upd = useCallback((path, value) => {
    setProgress(prev => {
      const u = { ...prev };
      const p = path.split(".");
      if (p.length === 1) u[p[0]] = value;
      else u[p[0]] = { ...u[p[0]], [p[1]]: value };
      if (p[0] === "phrases" && value === true) {
        u.phraseTs = { ...u.phraseTs, [p[1]]: Date.now() };
      }
      save(u);
      const vk = Object.keys(u.vocab||{}).filter(k=>u.vocab[k]).length;
      const tw = ALL_WORDS.length;
      if(vk===Math.min(200,tw)&&!localStorage.getItem("ms1")){localStorage.setItem("ms1","1");setTimeout(()=>setPopup({e:"🎊",t:"Tier 1 Complete!",s:"You can survive HK!"}),300);}
      return u;
    });
  }, [save]);

  const markReviewed = useCallback((key) => {
    setProgress(prev => {
      const u = { ...prev, lastReview: { ...prev.lastReview, [key]: Date.now() } };
      save(u); return u;
    });
  }, [save]);

  const updSettings = useCallback((path, val) => {
    setSettings(prev => {
      const u = { ...prev }; const p = path.split(".");
      if (p.length === 1) u[p[0]] = val; else u[p[0]] = { ...u[p[0]], [p[1]]: val };
      if (path === "enVoice") _activeEnVoiceId = val;
      if (path === "cnVoice") _activeCnVoiceId = val;
      localStorage.setItem(LANG_CONFIG.localStorageSettingsKey, JSON.stringify(u));
      if (user) saveSettingsToFirestore(user.uid, u);
      return u;
    });
  }, [user]);

  // Audio playlist
  const [showPlBuilder, setShowPlBuilder] = useState(false);
  const plActive = useRef(false);
  useEffect(() => {
    if (!playlist || !playlist.playing) { plActive.current = false; return; }
    plActive.current = true;
    const item = playlist.items[playlist.idx];
    if (!item) { setPlaylist(null); setPopup({ e:"🎵", t:"Playlist complete!", s:`Reviewed ${playlist.items.length} items` }); return; }
    const gapMs = { slow: 2500, normal: 1500, fast: 700 }[playlist.speed || "normal"];
    let cancelled = false;
    (async () => {
      await speakPhrase(item);
      await new Promise(r => setTimeout(r, gapMs));
      if (!cancelled && plActive.current) setPlaylist(prev => prev ? { ...prev, idx: prev.idx + 1 } : null);
    })();
    return () => { cancelled = true; if("speechSynthesis"in window) speechSynthesis.cancel(); };
  }, [playlist?.idx, playlist?.playing, playlist?.speed]);

  const startPlaylist = useCallback((items, title) => {
    setPlaylist({ items, title, idx: 0, playing: true, speed: "normal" });
  }, []);

  // Loading state
  if (authLoading) return <div className="ca"><div className="pkr"><div style={{color:"var(--lime)",fontSize:"1rem",fontWeight:900}}>Loading...</div></div></div>;

  // Not signed in: redirect to landing page
  if (!user) { window.location.href = "index.html"; return null; }

  const profile = user.uid;
  const displayName = user.displayName || "Learner";
  const photoURL = user.photoURL;
  const vk = Object.keys(progress.vocab||{}).filter(k=>progress.vocab[k]).length;

  // Voice onboarding — show once on first visit (skip if offline or returning user)
  const isReturningUser = (progress.lessonLog||[]).length > 0 || Object.keys(progress.phrases||{}).length > 0 || Object.keys(progress.vocab||{}).length > 0;
  if (settings.onboardingDone === false && !isReturningUser) {
    if (!_isOnline) {
      // Skip onboarding offline, use defaults
      updSettings("enVoice", DEFAULT_EN_VOICE);
      updSettings("cnVoice", DEFAULT_CN_VOICE);
      updSettings("onboardingDone", true);
    } else {
      return <VoiceOnboarding onComplete={(enVoice, cnVoice) => {
        const newSettings = { ...settings, enVoice, cnVoice, onboardingDone: true };
        setSettings(newSettings);
        _activeEnVoiceId = enVoice;
        _activeCnVoiceId = cnVoice;
        localStorage.setItem(LANG_CONFIG.localStorageSettingsKey, JSON.stringify(newSettings));
        if (user) saveSettingsToFirestore(user.uid, newSettings);
      }} />;
    }
  } else if (settings.onboardingDone === false && isReturningUser) {
    // Returning user on new device — skip onboarding, use defaults, persist
    updSettings("onboardingDone", true);
  }

  return (
    <div className={`ca ${settings.learnMode === "reading" ? "reading-mode" : ""}`}>
      <OfflineBanner />
      <div className="hdr">
        <div className="hdr-l">
          <div className="hm" style={{background:"var(--for)",borderRadius:8}}>
            <span style={{fontSize:"1rem"}}>🗣</span>
          </div>
          <div>
            <div className="ht">Shadow<span style={{color:"var(--lime)"}}>Speak</span></div>
            <div style={{fontSize:".62rem",fontWeight:800,color:"var(--lime)",letterSpacing:".5px",marginTop:-1}}>{LANG_CONFIG.flag} {LANG_CONFIG.name.toUpperCase()}</div>
          </div>
          <div className="tn">
            {[{id:"home",icon:"🏠",l:"Home"},{id:"library",icon:"📚",l:"My Library"},{id:"practice",icon:"🧠",l:"Practice"}].map(t=>
              <button key={t.id} className={`tn-btn ${tab===t.id?"on":""}`} onClick={()=>setTab(t.id)}><span className="tn-icon">{t.icon}</span>{t.l}</button>
            )}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{position:"relative"}}>
            {photoURL ? (
              <img src={photoURL} referrerPolicy="no-referrer" style={{width:36,height:36,borderRadius:"50%",border:"2px solid var(--lime)",cursor:"pointer"}} onClick={()=>setProfileMenu(v=>!v)} title={displayName} />
            ) : (
              <div className="ha" style={{background:"var(--lime)",color:"var(--for)",cursor:"pointer"}} onClick={()=>setProfileMenu(v=>!v)}>{displayName[0]}</div>
            )}
            {profileMenu && <>
              <div style={{position:"fixed",inset:0,zIndex:998}} onClick={()=>setProfileMenu(false)} />
              <div style={{position:"absolute",right:0,top:"calc(100% + 8px)",background:"var(--wh)",border:"1.5px solid var(--st)",borderRadius:14,padding:"10px 0",minWidth:220,zIndex:999,boxShadow:"0 8px 32px rgba(0,0,0,.15)"}}>
                <div style={{padding:"8px 16px",borderBottom:"1px solid var(--st)"}}>
                  <div style={{fontSize:".78rem",fontWeight:800,color:"var(--ink)"}}>{displayName}</div>
                  <div style={{fontSize:".62rem",color:"var(--ink2)"}}>{user.email}</div>
                </div>
                <button onClick={()=>{setProfileMenu(false);localStorage.setItem('shadowspeak-lang', LANG_CONFIG.switchTo.lang); window.location.reload();}} style={{width:"100%",padding:"14px 16px",background:"none",border:"none",cursor:"pointer",fontSize:".82rem",fontWeight:700,color:"var(--ink)",textAlign:"left",display:"flex",alignItems:"center",gap:10,minHeight:48}}>{LANG_CONFIG.switchTo.flag} {LANG_CONFIG.switchTo.label}</button>
                <button onClick={()=>{setProfileMenu(false);setTab("settings");}} style={{width:"100%",padding:"14px 16px",background:"none",border:"none",cursor:"pointer",fontSize:".82rem",fontWeight:700,color:"var(--ink)",textAlign:"left",display:"flex",alignItems:"center",gap:10,minHeight:48}}>⚙️ Settings</button>
                <button onClick={()=>{setProfileMenu(false);window.location.href="index.html";}} style={{width:"100%",padding:"14px 16px",background:"none",border:"none",cursor:"pointer",fontSize:".82rem",fontWeight:700,color:"var(--ink)",textAlign:"left",display:"flex",alignItems:"center",gap:10,minHeight:48}}>🏠 Back to home</button>
                <div style={{borderTop:"1px solid var(--st)",margin:"2px 0"}} />
                <button onClick={()=>{fbAuth.signOut();window.location.href="index.html";}} style={{width:"100%",padding:"14px 16px",background:"none",border:"none",cursor:"pointer",fontSize:".82rem",fontWeight:700,color:"#e74c3c",textAlign:"left",display:"flex",alignItems:"center",gap:10,minHeight:48}}>🚪 Sign out</button>
              </div>
            </>}
          </div>
        </div>
      </div>

      {tab==="home"&&<HomeTab profile={displayName} progress={progress} upd={upd} settings={settings} setTab={setTab} recentTopics={recentTopics} setRecentTopics={setRecentTopics} practiceCount={practiceCount} library={library} selUnit={selUnit} setSelUnit={setSelUnit} markReviewed={markReviewed} startPlaylist={startPlaylist} openPlBuilder={()=>setShowPlBuilder(true)} isPremium={isPremium} setShowPremiumGate={setShowPremiumGate} />}
      {tab==="library"&&<LibraryTab library={library} setLibrary={setLibrary} progress={progress} upd={upd} settings={settings} />}
      {tab==="practice"&&<PracticeTab progress={progress} upd={upd} settings={settings} library={library} practiceCount={practiceCount} setPracticeCount={setPracticeCount} />}
      {tab==="settings"&&<SettingsTab settings={settings} updSettings={updSettings} isPremium={isPremium} setShowPremiumGate={setShowPremiumGate} />}

      {/* Playlist builder overlay */}
      {showPlBuilder && <PlaylistBuilder onClose={()=>setShowPlBuilder(false)} onPlay={(items,title)=>{setShowPlBuilder(false);startPlaylist(items,title);}} progress={progress} />}

      {/* Playlist bar — redesigned (#20) */}
      {playlist && <div style={{position:"fixed",bottom:54,left:0,right:0,zIndex:110,padding:"0 10px"}}><div className="pl-bar-v2">
        <button className="pl-v2-close" onClick={()=>{setPlaylist(null);if("speechSynthesis"in window)speechSynthesis.cancel();}}>✕</button>
        <button className="pl-v2-play" onClick={()=>setPlaylist(p=>p?{...p,playing:!p.playing}:null)}>{playlist.playing?"⏸":"▶"}</button>
        <div className="pl-v2-info">
          <div className="pl-v2-en">{playlist.items[playlist.idx]?.en || "..."}</div>
          {playlist.items[playlist.idx]?.jyut && <div className="pl-v2-jy"><JyutpingTone text={playlist.items[playlist.idx].jyut} /></div>}
          <div className="pl-v2-counter">Word {playlist.idx+1} of {playlist.items.length}</div>
          <div className="pl-v2-prog"><div className="pl-v2-prog-fill" style={{width:`${((playlist.idx+1)/playlist.items.length)*100}%`}} /></div>
          <div className="pl-v2-speeds">
            <span className="pl-v2-speed-label">Speed</span>
            {[{k:"slow",l:"🐢"},{k:"normal",l:"Normal"},{k:"fast",l:"🐇"}].map(s=>
              <button key={s.k} style={{padding:"4px 10px",borderRadius:999,border:playlist.speed===s.k?"1px solid var(--lime)":"1px solid rgba(255,255,255,.1)",background:playlist.speed===s.k?"rgba(196,240,0,.12)":"transparent",color:playlist.speed===s.k?"var(--lime)":"rgba(255,255,255,.4)",fontSize:".62rem",fontWeight:700,cursor:"pointer"}} onClick={()=>setPlaylist(p=>p?{...p,speed:s.k}:null)}>{s.l}</button>
            )}
          </div>
        </div>
        {playlist.items[playlist.idx]?.cn && <div className="pl-v2-cn">{playlist.items[playlist.idx].cn}</div>}
      </div></div>}

      <div className="bn">
        {[{id:"home",icon:"🏠",l:"Home"},{id:"library",icon:"📚",l:"My Library",badge:(progress.unit10||[]).filter(x=>!x.known).length||0},{id:"practice",icon:"🧠",l:"Practice"}].map(t=>
          <button key={t.id} className={`bb ${tab===t.id?"on":""}`} onClick={()=>setTab(t.id)} style={{flex:"1 1 33.33%"}}><span className="bi">{t.icon}</span>{t.l}{t.badge>0&&<span style={{position:"absolute",top:4,right:"calc(50% - 18px)",background:"var(--cor,#e74c3c)",color:"#fff",fontSize:".55rem",fontWeight:900,borderRadius:999,minWidth:16,height:16,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 4px"}}>{t.badge}</span>}</button>
        )}
      </div>

      {popup&&<div className="comp-ov" onClick={()=>setPopup(null)}><div className="comp-em">{popup.e}</div><div className="comp-t">{popup.t}</div><div className="comp-s">{popup.s}</div><button className="comp-btn" onClick={()=>setPopup(null)}>Continue</button></div>}
      {showPremiumGate&&<PremiumGate user={user} onClose={()=>setShowPremiumGate(false)} onUnlock={()=>{setIsPremium(true);setShowPremiumGate(false);setPopup({e:"🎉",t:"Welcome to Premium!",s:"All units and features are now unlocked."});}} />}
    </div>
  );
}

// ---- BADGES ----
const BADGE_DEFS = LANG_CONFIG.BADGE_DEFS;

function getStats(progress) {
  const known = Object.keys(progress.phrases||{}).filter(k=>(progress.phrases||{})[k]).length;
  const lessonLog = progress.lessonLog || [];
  const streak = calcStreak(lessonLog);
  const totalMins = lessonLog.reduce((s,l) => s + (l.mins||30), 0);
  const unitsDone = UNITS.filter(u => u.phrases.every((_,i) => (progress.phrases||{})[`${u.id}-${i}`])).length;
  const quizzes = progress.quizCount || 0;
  return { known, streak, totalMins, unitsDone, quizzes, lessonLog };
}

function calcStreak(log) {
  if (!log.length) return 0;
  const today = new Date();
  const todayStr = today.toDateString();
  const dates = [...new Set(log.map(l => new Date(l.date).toDateString()))].sort((a,b) => new Date(b)-new Date(a));

  // Must have done a lesson today or on the last weekday
  const lastLesson = new Date(dates[0]);
  const daysSinceLast = Math.round((today - lastLesson) / 86400000);
  // Allow gap: if today is Monday, last lesson on Friday = okay (3 days gap)
  // If today is a weekday and last lesson was yesterday = okay
  // Skip weekends in the gap check
  function weekdaysBetween(d1, d2) {
    let count = 0;
    const start = new Date(Math.min(d1, d2));
    const end = new Date(Math.max(d1, d2));
    const cur = new Date(start);
    cur.setDate(cur.getDate() + 1);
    while (cur < end) {
      const day = cur.getDay();
      if (day !== 0 && day !== 6) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  if (dates[0] !== todayStr) {
    const gap = weekdaysBetween(lastLesson, today);
    if (gap > 1) return 0; // missed a weekday
  }

  let streak = 1;
  for (let i = 1; i < dates.length; i++) {
    const gap = weekdaysBetween(new Date(dates[i]), new Date(dates[i-1]));
    if (gap <= 1) streak++;
    else break;
  }
  return streak;
}

function didLessonToday(progress) {
  const log = progress.lessonLog || [];
  const today = new Date().toDateString();
  return log.some(l => new Date(l.date).toDateString() === today);
}

// ---- LESSON ENGINE ----
// ---- SHARED AUTO-GLOSS HELPER ----
function getAutoGloss(ph) {
  if (!ph || !ph.cn) return [];
  if (GLOSS_DATA[ph.cn]) return GLOSS_DATA[ph.cn];
  const cn = (ph.cn||"").replace(/[，。！？、「」]/g, "").trim();
  const jy = (getRom(ph)||"").replace(/[，,]/g, " ").replace(/\s+/g," ").trim();
  const jyParts = jy.split(" ").filter(Boolean);
  const chars = [...cn].filter(c => c.trim());
  const result = [];
  let ci = 0, ji = 0;
  while (ci < chars.length) {
    if (ci + 1 < chars.length && ji + 1 < jyParts.length) {
      result.push({ cn: chars[ci] + chars[ci+1], jy: jyParts[ji] + " " + jyParts[ji+1], en: "" });
      ci += 2; ji += 2;
    } else {
      result.push({ cn: chars[ci] || "", jy: jyParts[ji] || "", en: "" });
      ci++; ji++;
    }
  }
  return result;
}

// ---- DRILL VIEW (3-round repeat) ----
function DrillView({ item, items, innerIdx, safeIdx, showJyut }) {
  if (!item) return <div className="sh-bd"><div style={{color:"rgba(255,255,255,.4)"}}>Preparing drill...</div></div>;
  const passNum = items.length ? Math.floor(innerIdx / items.length) : 0;
  const round = passNum % 3;
  const gloss = getAutoGloss(item);

  return (
    <div className="sh-bd">
      {round === 1 && gloss.length > 0 && gloss.some(g=>g.en) ? (
        <>
          <div className="sh-en" style={{fontSize:"1rem",marginBottom:14,opacity:.5}}>{item.en}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center",margin:"0 0 16px"}}>
            {gloss.filter(g=>g.cn).map((g,i) => (
              <div key={i} className="drill-word-card" onClick={()=>speak(g.cn)}>
                <div className="dwc-cn">{g.cn}</div>
                {showJyut && <div className="dwc-jy"><JyutpingTone text={g.jy} /></div>}
                {g.en && <div className="dwc-en">{g.en}</div>}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="sh-en">{item.en}</div>
          {showJyut && <div className="sh-jy"><JyutpingTone text={item.jyut} /></div>}
          <div className="sh-cn">{item.cn}</div>
          {round === 2 && gloss.length > 0 && (
            <div style={{display:"flex",flexWrap:"wrap",gap:2,margin:"6px 0",padding:4,background:"rgba(255,255,255,.04)",borderRadius:6,justifyContent:"center"}}>
              {gloss.filter(g=>g.cn).map((g,i) => (
                <div key={i} style={{textAlign:"center",padding:"1px 3px"}}>
                  <div style={{fontSize:".65rem",color:"rgba(255,255,255,.35)"}}>{g.en}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div style={{fontSize:".68rem",color:"rgba(255,255,255,.3)",marginTop:6}}>Phrase {safeIdx+1}/{items.length}</div>
    </div>
  );
}

function LessonMode({ progress, upd, profile, settings, onComplete, onQuit }) {
  // Restore lesson state from sessionStorage if available
  const saved = useMemo(() => {
    try { const s = sessionStorage.getItem(`${LANG_CONFIG.id}-lesson`); return s ? JSON.parse(s) : null; } catch(e) { return null; }
  }, []);
  const [showIntro, setShowIntro] = useState(!saved);
  const [phase, setPhase] = useState(saved?.phase || 0);
  const [timeLeft, setTimeLeft] = useState(saved?.timeLeft ?? 30*60);
  const [phaseTimeLeft, setPhaseTimeLeft] = useState(saved?.phaseTimeLeft ?? 3*60);
  const [paused, setPaused] = useState(false);
  const [phaseData, setPhaseData] = useState(null);
  const [innerIdx, setInnerIdx] = useState(saved?.innerIdx || 0);
  const [shadowPhase, setShadowPhase] = useState("play");
  const [drillPass, setDrillPass] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [quizScore, setQuizScore] = useState(saved?.quizScore || {right:0,wrong:0});
  const [lessonDone, setLessonDone] = useState(false);
  const [speed, setSpeed] = useState(settings?.defaultSpeed || "normal");
  const [showJyut, setShowJyut] = useState(true);
  const [showTransition, setShowTransition] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [scoreResult, setScoreResult] = useState(null);
  const timerRef = useRef(null);
  const shadowTimer = useRef(null);

  // Save lesson state to sessionStorage on every change
  useEffect(() => {
    if (!lessonDone && !showIntro) {
      sessionStorage.setItem(`${LANG_CONFIG.id}-lesson`, JSON.stringify({ phase, timeLeft, phaseTimeLeft, innerIdx, quizScore }));
    }
  }, [phase, timeLeft, phaseTimeLeft, innerIdx, quizScore, lessonDone, showIntro]);

  const phaseDurations = [3*60, 7*60, 8*60, 5*60, 5*60, 2*60];
  const phaseInfo = [
    { name: "Warm-up", short: "Warm-up", icon: "🔥", desc: "Shadow recent phrases", coach: "Listen and say them out loud. No pressure.", transDesc: "Let's ease in. These are phrases you've seen before. Listen and say them out loud. No pressure." },
    { name: "New Phrases", short: "Learn", icon: "🆕", desc: "Hear English, try Cantonese, hear answer", coach: "You'll hear the English first, then the Cantonese. Say each one out loud.", transDesc: "Time for something new. You'll hear the English, then try to say it in Cantonese. Each new phrase expands what you can say in the real world." },
    { name: "Repeat Drill", short: "Drill", icon: "🗣", desc: "Repeat after me", coach: "Listen to the whole phrase, then say it out loud.", transDesc: "Repeat each phrase out loud three times. First the whole thing, then broken into words, then back together again." },
    { name: "Mix & Review", short: "Review", icon: "🔁", desc: "Old + new shuffled", coach: "Old and new mixed together. Say each one out loud.", transDesc: "Old and new phrases mixed together. Say each one out loud. This is where your brain starts connecting everything." },
    { name: "Quiz", short: "Quiz", icon: "📝", desc: "Prove you know it", coach: "See the English and try to say it in Cantonese out loud.", transDesc: "See the English and try to say it out loud in Cantonese. Testing yourself makes the memory stronger." },
    { name: "Cool-down", short: "Wind down", icon: "🎧", desc: "One last listen", coach: "One last gentle listen. Let the sounds settle.", transDesc: "One last gentle listen. Let the sounds settle into your memory while you relax." },
  ];

  // Coaching cues per drill pass
  const drillCoach = [
    {emoji:"🎯", text:"Listen to the whole phrase, then say it out loud"},
    {emoji:"🔍", text:"Say it out loud. See how the words fit together and what each one means."},
    {emoji:"🧩", text:"Put it all together. Say the whole phrase out loud."},
  ];

  const speedGaps = { slow:[4000,4500], normal:[2800,3200], fast:[1500,1800] };

  useEffect(() => {
    const due = getDueItems(progress).slice(0, 10);
    const newP = getNewItems(progress).slice(0, 5);
    const lifePriority = (progress.unit10||[]).filter(s=>s.cn&&s.cn!=="(add characters)"&&!s.known).slice(0,5).map(s=>({en:s.en,jyut:s.jyut,cn:s.cn,tag:s.tag,unitId:11,key:"life"}));
    const lifeOther = (progress.unit10||[]).filter(s=>s.cn&&s.cn!=="(add characters)"&&s.known).slice(0,2).map(s=>({en:s.en,jyut:s.jyut,cn:s.cn,tag:s.tag,unitId:11,key:"life"}));
    const newWithLife = [...lifePriority, ...newP, ...lifeOther].slice(0,7);
    const mixItems = [...newWithLife, ...due.slice(0,5)].sort(()=>Math.random()-0.5);
    const quizItems = Object.keys(progress.phrases||{}).filter(k=>(progress.phrases||{})[k]).map(k=>{
      const [uid,pi] = k.split("-").map(Number);
      const u = UNITS.find(x=>x.id===uid);
      return u?.phrases[pi] ? {...u.phrases[pi],key:k,unitId:uid,phraseIdx:pi} : null;
    }).filter(Boolean).sort(()=>Math.random()-0.5).slice(0,10);
    setPhaseData({ warmup: due.length?due:newWithLife, newPhrases: newWithLife, drill: newWithLife, mix: mixItems, quiz: quizItems, cooldown: newWithLife });
    // Preload all audio for this lesson
    const allItems = [...new Map([...due, ...newWithLife, ...mixItems, ...quizItems].filter(Boolean).map(p=>[p.cn,p])).values()];
    preloadUnitAudio(allItems);
  }, []);

  // Countdown timers
  useEffect(() => {
    if (paused || lessonDone || showIntro || showTransition) return;
    timerRef.current = setInterval(() => {
      setTimeLeft(t => { if(t<=1){setLessonDone(true);hapticLight();trackEvent('lesson_completed');sessionStorage.removeItem(`${LANG_CONFIG.id}-lesson`);return 0;} return t-1; });
      setPhaseTimeLeft(t => { if(t<=1){advancePhase();return 0;} return t-1; });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [paused, lessonDone, phase, showIntro, showTransition]);

  // Shadow/drill auto-advance (phases 0,1,2,3,5 — not 4 which is quiz)
  useEffect(() => {
    if (paused || lessonDone || phase === 4 || showIntro || showTransition) return;
    if (!phaseData) return;
    clearTimeout(shadowTimer.current);
    const items = getPhaseItems();
    if (!items || items.length===0) return;
    const safeIdx = innerIdx % items.length;
    const [playGap, shadowGap] = speedGaps[speed];

    if (phase === 1) {
      if (shadowPhase === "play") {
        shadowTimer.current = setTimeout(() => setShadowPhase("answer"), playGap + 1000);
      } else if (shadowPhase === "answer") {
        speak(items[safeIdx].cn);
        shadowTimer.current = setTimeout(() => setShadowPhase("shadow"), playGap);
      } else {
        shadowTimer.current = setTimeout(() => {
          setInnerIdx(i => i + 1);
          setShadowPhase("play");
        }, shadowGap);
      }
    } else if (phase === 2) {
      if (shadowPhase === "play") {
        speak(items[safeIdx].cn);
        shadowTimer.current = setTimeout(() => setShadowPhase("shadow"), playGap);
      } else {
        shadowTimer.current = setTimeout(() => {
          setInnerIdx(i => i + 1);
          setShadowPhase("play");
        }, shadowGap);
      }
    } else {
      if (shadowPhase === "play") {
        speak(items[safeIdx].cn);
        shadowTimer.current = setTimeout(() => setShadowPhase("shadow"), playGap);
      } else {
        shadowTimer.current = setTimeout(() => {
          setInnerIdx(i => i + 1);
          setShadowPhase("play");
        }, shadowGap);
      }
    }
    return () => clearTimeout(shadowTimer.current);
  }, [phase, innerIdx, shadowPhase, paused, lessonDone, phaseData, speed, showIntro, showTransition]);

  function getPhaseItems() {
    if (!phaseData) return [];
    switch(phase) {
      case 0: return phaseData.warmup;
      case 1: return phaseData.newPhrases;
      case 2: return phaseData.drill;
      case 3: return phaseData.mix;
      case 4: return phaseData.quiz;
      case 5: return phaseData.cooldown;
      default: return [];
    }
  }

  const advancePhase = useCallback(() => {
    if (phase >= 5) { setLessonDone(true); hapticLight(); trackEvent('lesson_completed'); sessionStorage.removeItem(`${LANG_CONFIG.id}-lesson`); return; }
    const next = phase + 1;
    // Show phase transition card
    setShowTransition(true);
    const cp = phaseInfo[next];
    // Voice coaching via TTS
    speakEnglish(cp.transDesc + " Remember, say it out loud!");
    setTimeout(() => {
      setShowTransition(false);
      setPhase(next);
      setPhaseTimeLeft(phaseDurations[next] || 120);
      setInnerIdx(0); setShadowPhase("play"); setRevealed(false); setDrillPass(0);
    }, 3000);
  }, [phase]);

  const skipTransition = () => {
    stopAudio();
    setShowTransition(false);
    const next = phase + 1;
    setPhase(next);
    setPhaseTimeLeft(phaseDurations[next] || 120);
    setInnerIdx(0); setShadowPhase("play"); setRevealed(false); setDrillPass(0);
  };

  const handleQuizGrade = (result) => {
    const items = phaseData.quiz;
    if (!items.length) return;
    const item = items[innerIdx % items.length];
    if (result==="wrong" && item?.key && item.key!=="life") upd(`phrases.${item.key}`, false);
    setQuizScore(prev=>({...prev,[result]:(prev[result]||0)+1}));
    setRevealed(false);
    if (innerIdx+1 < items.length) setInnerIdx(i=>i+1);
  };

  // Pronunciation scoring in quiz phase
  const quizStartTest = async () => {
    setPaused(true);
    stopAudio();
    try { const ok = await startRecording(); if (ok) setIsRecording(true); } catch(e) { console.warn("Mic error:", e); }
  };
  const quizStopTest = async () => {
    setIsRecording(false);
    setScoring(true);
    const blob = await stopRecording();
    const items = getPhaseItems();
    const safeIdx = innerIdx % (items?.length || 1);
    const ph = items?.[safeIdx];
    if (blob && ph) {
      try {
        const result = await scorePronunciation(blob, ph.cn, LANG_CONFIG.id);
        let chars = [];
        if (result.expectedJyutping && result.transcribedJyutping) {
          const expSyls = result.expectedJyutping.trim().split(/\s+/);
          const yourSyls = result.transcribedJyutping.trim().split(/\s+/);
          const cnChars = ph.cn.replace(/[，,。！？!?\s]/g, "").split("");
          for (let i = 0; i < Math.max(expSyls.length, cnChars.length); i++) {
            chars.push({ cn: cnChars[i] || "", e: expSyls[i] || "", y: yourSyls[i] || "", m: expSyls[i] === yourSyls[i] ? 1 : 0 });
          }
        }
        setScoreResult({ score: result.score, passed: result.passed, chars, phrase: ph });
      } catch(e) {
        console.error("Quiz scoring error:", e);
        setScoreResult(null);
      }
    }
    setScoring(false);
  };

  // Mark known in Review/Quiz only (#17)
  const markKnownInLesson = () => {
    const items = getPhaseItems();
    if (!items?.length) return;
    const safeIdx = innerIdx % items.length;
    const item = items[safeIdx];
    if (item?.key) upd(`phrases.${item.key}`, true);
  };

  if (!phaseData) return <div className="sho navy" style={{alignItems:"center",justifyContent:"center"}}><div style={{color:"var(--lime)",fontSize:"1rem",fontWeight:900}}>Preparing lesson...</div></div>;

  // ===== INTRO SCREEN (#13) =====
  if (showIntro) {
    return (
      <div className="sho navy" style={{overflow:"auto"}}>
        <div className="lesson-intro">
          <div className="li-emoji">🎯</div>
          <div className="li-title">30 minutes of<br/>speaking practice.</div>
          <div className="li-sub">You'll listen to real Cantonese phrases, then say them <strong>out loud</strong>. This is called <strong>shadowing</strong>. It trains your ear to hear the sounds and your mouth to make them. Each lesson has 6 short sections:</div>

          <div className="li-roadmap">
            {phaseInfo.map((p,i) => (
              <div key={i} className="rm-item">
                <div className={`rm-icon ${["warmup","learn","drill","review","quiz","wind"][i]}`}>{p.icon}</div>
                <div className="rm-text">
                  <div className="rm-name">{p.short}</div>
                  <div className="rm-desc">{p.transDesc}</div>
                </div>
                <div className="rm-dur">{Math.floor(phaseDurations[i]/60)} min</div>
              </div>
            ))}
          </div>

          <button className="li-go" onClick={()=>{setShowIntro(false);trackEvent('lesson_started');setShowTransition(true);speakEnglish(phaseInfo[0].transDesc+" Remember, say it out loud!");setTimeout(()=>{setShowTransition(false);},3000);}}>Let's go 💪</button>

          <div className="li-tip">
            <span className="li-tip-emoji">💡</span>
            <div className="li-tip-text"><strong>Say it out loud.</strong> Even whispering is 3× more effective than just listening. Your mouth needs to learn the shapes.</div>
          </div>
        </div>
      </div>
    );
  }

  // ===== PHASE TRANSITION CARD (#14) =====
  if (showTransition) {
    const nextPhase = Math.min(phase + 1, 5);
    const tp = phase === 0 && !saved ? phaseInfo[0] : phaseInfo[nextPhase];
    return (
      <div className="phase-trans navy">
        <div className="pt-icon">{tp.icon}</div>
        <div className="pt-name">{tp.short}</div>
        <div className="pt-desc">{tp.transDesc}</div>
        <div className="voice-coach">
          <div className="vc-waves">
            <div className="vc-bar" /><div className="vc-bar" /><div className="vc-bar" /><div className="vc-bar" /><div className="vc-bar" />
          </div>
          <span className="vc-text">"Remember, say it out loud!"</span>
        </div>
        <button className="pt-skip" onClick={skipTransition}>Skip →</button>
      </div>
    );
  }

  const totalAfter = (progress.lessonLog||[]).length + 1;
  const inBlock = totalAfter % 10 || 10; // 1-10 within current block of 10
  const nextReward = Math.ceil(totalAfter / 10) * 10;
  const atReward = inBlock === 10;

  if (lessonDone) {
    const totalPhrases = UNITS.reduce((s,u)=>s+u.phrases.length,0);
    const totalAll = totalPhrases + ALL_WORDS.length;
    const knownCount = Object.values(progress.phrases||{}).filter(Boolean).length;
    const pctTrail = Math.min(100, Math.round((knownCount / totalAll) * 100));
    const progressMsg = totalAfter <= 3 ? "You're just getting started. Every session builds the foundation." :
      totalAfter <= 10 ? "Your brain is forming new pathways with every repetition." :
      totalAfter <= 25 ? "You're past the hardest part. The habit is taking root." :
      "You're deep in it now. Cantonese is becoming part of you.";

    return (
      <div style={{position:"fixed",inset:0,background:"linear-gradient(180deg, #0D2818 0%, #1A3A2A 40%, #0D2818 100%)",zIndex:300,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,textAlign:"center",animation:"fi .3s",overflow:"auto"}}>
        {/* Radial glows */}
        <div style={{position:"absolute",top:"-20%",left:"-10%",width:"120%",height:"60%",background:"radial-gradient(ellipse at center, rgba(196,240,0,.08) 0%, transparent 70%)",pointerEvents:"none"}} />
        <div style={{position:"absolute",bottom:"-10%",right:"-10%",width:"80%",height:"40%",background:"radial-gradient(ellipse at center, rgba(196,240,0,.05) 0%, transparent 70%)",pointerEvents:"none"}} />

        {/* Pulsing glow line at top */}
        <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg, transparent, var(--lime), transparent)",animation:"pulseGlow 2s ease-in-out infinite"}} />

        {/* Headline */}
        <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:"1.6rem",fontWeight:900,color:"#fff",lineHeight:1.2,marginBottom:4,position:"relative"}}>
          {atReward ? <>{nextReward} Lessons!</> : <>Lesson complete!</>}
        </div>
        <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:"1rem",fontWeight:400,marginBottom:16,position:"relative"}}>
          <span style={{background:"linear-gradient(90deg, var(--lime), #9FE870)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{totalPhrases} phrases + {ALL_WORDS.length} vocab words in Cantonese</span>
        </div>

        {/* Trail progress bar with glowing dot */}
        <div style={{width:"100%",maxWidth:300,marginBottom:16,position:"relative"}}>
          <div style={{height:6,background:"rgba(255,255,255,.08)",borderRadius:3,overflow:"visible",position:"relative"}}>
            <div style={{height:"100%",borderRadius:3,background:"linear-gradient(90deg, var(--lime), #9FE870)",width:`${pctTrail}%`,transition:"width .8s ease-out",position:"relative"}}>
              {/* Shimmer animation */}
              <div style={{position:"absolute",inset:0,borderRadius:3,background:"linear-gradient(90deg, transparent 0%, rgba(255,255,255,.3) 50%, transparent 100%)",animation:"shimmer 2s ease-in-out infinite"}} />
            </div>
            {/* Glowing dot */}
            <div style={{position:"absolute",top:"50%",left:`${pctTrail}%`,transform:"translate(-50%,-50%)",width:14,height:14,borderRadius:"50%",background:"var(--lime)",boxShadow:"0 0 12px rgba(196,240,0,.6), 0 0 24px rgba(196,240,0,.3)",border:"2px solid #fff"}} />
          </div>
          <div style={{fontSize:".68rem",color:"rgba(255,255,255,.4)",marginTop:8}}>{pctTrail}% of total content covered</div>
        </div>

        {/* Stats chips — frosted glass style */}
        <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",justifyContent:"center"}}>
          <div style={{background:"rgba(255,255,255,.06)",backdropFilter:"blur(8px)",borderRadius:12,padding:"10px 16px",textAlign:"center",border:"1px solid rgba(255,255,255,.1)"}}>
            <div style={{fontSize:"1.1rem",fontWeight:900,color:"var(--lime)"}}>{phaseData.newPhrases.length}</div>
            <div style={{fontSize:".62rem",color:"rgba(255,255,255,.4)",fontWeight:700}}>Phrases</div>
          </div>
          <div style={{background:"rgba(255,255,255,.06)",backdropFilter:"blur(8px)",borderRadius:12,padding:"10px 16px",textAlign:"center",border:"1px solid rgba(255,255,255,.1)"}}>
            <div style={{fontSize:"1.1rem",fontWeight:900,color:"#fff"}}>{quizScore.right||0}</div>
            <div style={{fontSize:".62rem",color:"rgba(255,255,255,.4)",fontWeight:700}}>Quiz correct</div>
          </div>
          <div style={{background:"rgba(255,255,255,.06)",backdropFilter:"blur(8px)",borderRadius:12,padding:"10px 16px",textAlign:"center",border:"1px solid rgba(255,255,255,.1)"}}>
            <div style={{fontSize:"1.1rem",fontWeight:900,color:"var(--lime)"}}>{totalAfter}</div>
            <div style={{fontSize:".62rem",color:"rgba(255,255,255,.4)",fontWeight:700}}>Total lessons</div>
          </div>
        </div>

        {/* Progress message */}
        <div style={{fontSize:".78rem",color:"rgba(255,255,255,.5)",marginBottom:16,maxWidth:280,lineHeight:1.5}}>{progressMsg}</div>

        {/* Nudge cards */}
        <div style={{display:"flex",gap:8,marginBottom:20,maxWidth:320,width:"100%"}}>
          <div style={{flex:1,background:"rgba(196,240,0,.06)",border:"1px solid rgba(196,240,0,.12)",borderRadius:12,padding:"12px 10px",textAlign:"center"}}>
            <div style={{fontSize:".9rem",fontWeight:900,color:"var(--lime)"}}>30 min</div>
            <div style={{fontSize:".62rem",color:"rgba(255,255,255,.35)",fontWeight:600,lineHeight:1.3,marginTop:2}}>Rewires your brain</div>
          </div>
          <div style={{flex:1,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,padding:"12px 10px",textAlign:"center"}}>
            <div style={{fontSize:".9rem",fontWeight:900,color:"#fff"}}>85M</div>
            <div style={{fontSize:".62rem",color:"rgba(255,255,255,.35)",fontWeight:600,lineHeight:1.3,marginTop:2}}>Cantonese speakers</div>
          </div>
        </div>

        <style>{`
          @keyframes pulseGlow { 0%,100% { opacity:.4; } 50% { opacity:1; } }
          @keyframes shimmer { 0% { transform:translateX(-100%); } 100% { transform:translateX(200%); } }
          @keyframes popIn { 0% { transform: scale(0.5); } 50% { transform: scale(1.3); } 100% { transform: scale(1); } }
        `}</style>

        <div style={{display:"flex",gap:8}}>
          <button className="comp-btn" onClick={onComplete}>Done 💪</button>
          <button className="comp-btn" style={{background:"rgba(255,255,255,.1)",color:"#fff"}} onClick={()=>{sessionStorage.removeItem(`${LANG_CONFIG.id}-lesson`);setLessonDone(false);setPhase(0);setTimeLeft(30*60);setPhaseTimeLeft(phaseDurations[0]);setInnerIdx(0);setShadowPhase("play");setQuizScore({right:0,wrong:0});}}>Another lesson 🔁</button>
        </div>
      </div>
    );
  }

  const mm = String(Math.floor(timeLeft/60)).padStart(2,"0");
  const ss = String(timeLeft%60).padStart(2,"0");
  const pmm = String(Math.floor(phaseTimeLeft/60)).padStart(2,"0");
  const pss = String(phaseTimeLeft%60).padStart(2,"0");
  const cp = phaseInfo[phase];
  const items = getPhaseItems();
  const safeIdx = items?.length ? innerIdx % items.length : 0;
  const item = items?.[safeIdx];
  const passNum = items?.length ? Math.floor(innerIdx / items.length) : 0;
  const round = passNum % 3;

  // Determine if "I know this now" should show (#17)
  const showKnowBtn = phase === 3 || phase === 4; // Review and Quiz only

  return (
    <div className="sho navy">
      {/* Header bar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px"}}>
        <button style={{width:40,height:40,borderRadius:"50%",background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.1)",color:"rgba(255,255,255,.6)",fontSize:15,fontFamily:"inherit",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onQuit}>✕</button>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:"1.2rem",fontWeight:900,color:"var(--lime)",fontVariantNumeric:"tabular-nums",lineHeight:1}}>{mm}:{ss}</div>
          <div style={{fontSize:".65rem",fontWeight:700,color:"rgba(255,255,255,.4)",marginTop:2}}>{cp.icon} {cp.short}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:".72rem",fontWeight:700,color:"rgba(255,255,255,.45)"}}>Phrase {safeIdx+1} of {items?.length||0}</div>
        </div>
      </div>

      {/* Continuous progress bar */}
      <div style={{height:3,background:"rgba(255,255,255,.08)",margin:"0 16px",borderRadius:2}}>
        <div style={{height:"100%",background:"var(--lime)",borderRadius:2,width:`${Math.max(0,Math.min(100,((30*60-timeLeft)/(30*60))*100))}%`,transition:"width .5s"}} />
      </div>

      {/* Phase bar — toned down (#18) */}
      <div className="l-phase-bar">
        {phaseInfo.map((p,i)=>(
          <div key={i} className="l-pb-item" style={{flex:phaseDurations[i]}}>
            <div className="l-pb-icon" style={{color:i<phase?"var(--lime)":i===phase?"rgba(255,255,255,.7)":"rgba(255,255,255,.2)"}}>{i<phase?"✓":p.icon}</div>
            <div className="l-pb-label" style={{color:i<phase?"rgba(196,240,0,.4)":i===phase?"rgba(255,255,255,.6)":"rgba(255,255,255,.18)",fontWeight:i===phase?700:600}}>{p.short}</div>
          </div>
        ))}
      </div>

      {/* In-lesson coaching cue (#15) */}
      {phase !== 4 && item && (
        <div className="coach-inline">
          <span className="ci-emoji">{phase===2?drillCoach[round]?.emoji||"🎯":"🎯"}</span>
          <span className="ci-text"><strong>{phase===2?(drillCoach[round]?.text||cp.coach):cp.coach}</strong></span>
        </div>
      )}

      {phase === 1 ? (
        /* New Learning */
        <div className="sh-bd">
          {item ? (<>
            <div className="sh-en">{item.en}</div>
            {shadowPhase !== "play" && showJyut && <div className="sh-jy"><JyutpingTone text={item.jyut} /></div>}
            {shadowPhase !== "play" && <div className="sh-cn">{item.cn}</div>}
            {/* Cue pill (#16) */}
            <div className={`cue-pill ${shadowPhase==="shadow"?"speak":"listen"}`}>
              <span className="cue-pill-emoji">{shadowPhase==="shadow"?"🗣️":"👂"}</span>
              <div className="cue-pill-dot" />
              <span className="cue-pill-text">{shadowPhase==="shadow"?"Say it out loud!":"Listen"}</span>
            </div>
            <div style={{fontSize:".68rem",color:"rgba(255,255,255,.2)",marginTop:6}}>Phrase {safeIdx+1} of {items.length}</div>
          </>) : <div style={{color:"rgba(255,255,255,.4)"}}>Preparing...</div>}
        </div>
      ) : phase === 2 ? (
        /* Repeat Drill with enlarged word cards (#19) */
        <DrillView item={item} items={items} innerIdx={innerIdx} safeIdx={safeIdx} showJyut={showJyut} />
      ) : phase === 4 ? (
        /* Quiz */
        <div className="quiz-body" style={{background:"var(--navy)"}}>
          {item && innerIdx < items.length ? (<>
            <div className="quiz-sub">Say this in Cantonese:</div>
            <div className="quiz-prompt">{item.en}</div>
            {!revealed ? (
              <button className="quiz-reveal-btn" onClick={()=>setRevealed(true)}>Reveal answer</button>
            ) : (<>
              <div className="quiz-answer">
                <div className="quiz-ans-jy"><JyutpingTone text={item.jyut} /></div>
                <div className="quiz-ans-cn">{item.cn}</div>
                <button style={{marginTop:6,background:"var(--st)",border:"none",borderRadius:999,padding:"8px 12px",fontSize:".72rem",cursor:"pointer"}} onClick={()=>speak(item.cn)}>▶ Listen</button>
              </div>
              {/* Pronunciation scoring in quiz */}
              <div style={{width:"100%",maxWidth:440,marginBottom:10}}>
                {!isRecording && !scoring ? (
                  <RecordBtn onClick={quizStartTest} label="🎙 Test your pronunciation" style={{width:"100%",padding:"12px",borderRadius:12,border:"2px solid var(--lime)",background:"rgba(196,240,0,.08)",color:"var(--lime)",fontSize:".78rem",fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}} />
                ) : scoring ? (
                  <div style={{width:"100%",padding:"12px",borderRadius:12,background:"rgba(255,255,255,.06)",textAlign:"center"}}>
                    <div style={{fontSize:".75rem",fontWeight:700,color:"rgba(255,255,255,.5)"}}>Scoring your pronunciation...</div>
                  </div>
                ) : (
                  <button onClick={quizStopTest} style={{width:"100%",padding:"12px",borderRadius:12,border:"2px solid #e74c3c",background:"rgba(231,76,60,.12)",color:"#ff7a5c",fontSize:".78rem",fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,animation:"pulse 1s ease-in-out infinite"}}>
                    ⏹ Stop recording & score
                  </button>
                )}
              </div>
              <div className="quiz-grade">
                <button className="quiz-g-btn quiz-g-yes" onClick={()=>handleQuizGrade("right")}>✓ Got it</button>
                <button className="quiz-g-btn quiz-g-no" onClick={()=>handleQuizGrade("wrong")}>✗ Nope</button>
              </div>
            </>)}
            <div style={{fontSize:".68rem",color:"rgba(255,255,255,.3)",marginTop:6}}>{innerIdx+1} of {items.length}</div>
          </>) : (
            <div style={{color:"rgba(255,255,255,.4)",fontSize:".78rem",padding:20}}>Quiz done! {pmm}:{pss} until next phase</div>
          )}
        </div>
      ) : (
        /* Standard shadow (warmup, mix, cooldown) */
        <div className="sh-bd">
          {item ? (<>
            <div className="sh-tg">{item.tag || cp.name}</div>
            <div className="sh-en">{item.en}</div>
            {showJyut && <div className="sh-jy"><JyutpingTone text={item.jyut} /></div>}
            <div className="sh-cn">{item.cn}</div>
            {/* Cue pill (#16) */}
            <div className={`cue-pill ${shadowPhase==="shadow"?"speak":"listen"}`}>
              <span className="cue-pill-emoji">{shadowPhase==="shadow"?"🗣️":"👂"}</span>
              <div className="cue-pill-dot" />
              <span className="cue-pill-text">{shadowPhase==="shadow"?"Say it out loud!":"Listen"}</span>
            </div>
            <div style={{fontSize:".68rem",color:"rgba(255,255,255,.25)",marginTop:8}}>Phrase {safeIdx+1}/{items.length} · looping</div>
          </>) : <div style={{color:"rgba(255,255,255,.4)"}}>Preparing...</div>}
        </div>
      )}

      {/* Controls area (#17) — transport + conditional know btn + speed + jyutping toggle */}
      {phase !== 4 && (
        <div className="l-ctrl">
          <div className="l-transport">
            <div className="lt-wrap">
              <button className="lt-btn sec" onClick={()=>{clearTimeout(shadowTimer.current);setShadowPhase("play");}}>↻</button>
              <span className="lt-lbl">Replay</span>
            </div>
            <div className="lt-wrap">
              <button className="lt-btn pri" onClick={()=>setPaused(p=>!p)}>{paused?"▶":"⏸"}</button>
              <span className="lt-lbl">{paused?"Resume":"Pause"}</span>
            </div>
          </div>

          {/* "I know this now" only in Review and Quiz (#17) */}
          {showKnowBtn && (
            <div className="l-know-row">
              <button className="l-know-btn" onClick={markKnownInLesson}>
                <span style={{fontSize:"1rem"}}>💪</span>
                <span>I know this now</span>
              </button>
            </div>
          )}

          <div className="l-divider" />
          <div className="l-speed">
            <div className="l-row-label">Pause between phrases</div>
            <div className="l-pill-row">
              {[{k:"slow",l:"Longer pause"},{k:"normal",l:"Normal"},{k:"fast",l:"Shorter pause"}].map(s=>
                <button key={s.k} className={`l-pill-btn ${speed===s.k?"on":""}`} onClick={()=>setSpeed(s.k)}>{s.l}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Quiz gets simpler controls */}
      {phase === 4 && (
        <div className="l-ctrl">
          <div className="l-transport">
            <div className="lt-wrap">
              <button className="lt-btn pri" onClick={()=>setPaused(p=>!p)}>{paused?"▶":"⏸"}</button>
              <span className="lt-lbl">{paused?"Resume":"Pause"}</span>
            </div>
          </div>
          {/* "I know this now" in Quiz too */}
          <div className="l-know-row">
            <button className="l-know-btn" onClick={markKnownInLesson}>
              <span style={{fontSize:"1rem"}}>💪</span>
              <span>I know this now</span>
            </button>
          </div>
        </div>
      )}

      {/* Quiz pronunciation score overlay */}
      {scoreResult && <PronunciationScore
        score={scoreResult.score}
        chars={scoreResult.chars}
        phrase={scoreResult.phrase}
        onRetry={() => { setScoreResult(null); quizStartTest(); }}
        onNext={() => { setScoreResult(null); setPaused(false); }}
        onClose={() => { setScoreResult(null); setPaused(false); }}
      />}
    </div>
  );
}

const phaseInfo_short = ["Warm-up","Learn","Drill","Review","Quiz","Wind down"];

// ---- ADD NEW SECTION ----
function AddNewSection({ progress, upd }) {
  const [open, setOpen] = useState(false);
  const [cn, setCn] = useState("");
  const [jyut, setJyut] = useState("");
  const [en, setEn] = useState("");
  const items = progress.unit10 || [];
  const learning = items.filter(s => !s.known && s.cn && s.cn !== "(add characters)");

  const addItem = () => {
    if (!cn.trim() && !en.trim()) return;
    const item = { en: en.trim()||"", jyut: jyut.trim()||"", cn: cn.trim()||"", tag: "Added", known: false, date: new Date().toLocaleDateString("en-GB",{day:"numeric",month:"short"}) };
    upd("unit10", [item, ...items]);
    setCn(""); setJyut(""); setEn("");
  };

  const markKnown = (idx) => {
    const updated = items.map((s, i) => i === idx ? { ...s, known: true } : s);
    upd("unit10", updated);
  };

  return (
    <div style={{background:"var(--wh)",borderRadius:14,padding:14,marginBottom:10,border:learning.length>0?"2px solid var(--lime)":"1px solid var(--st)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setOpen(v=>!v)}>
        <div style={{fontSize:".82rem",fontWeight:800,color:"var(--ink)"}}>
          {learning.length>0?`${learning.length} still learning — drilled every lesson`:"+ Add a word or phrase"}
        </div>
        <div style={{fontSize:".82rem",color:"var(--ink3)"}}>{open?"▲":"▼"}</div>
      </div>
      {open && (
        <div style={{marginTop:10}}>
          <div style={{display:"flex",gap:6,marginBottom:6,flexWrap:"wrap"}}>
            <input style={{flex:"2 1 100px",minWidth:80,background:"var(--cream)",border:"1.5px solid var(--st)",borderRadius:8,padding:"10px 12px",fontSize:".82rem",color:"var(--ink)",outline:"none",fontFamily:"${LANG_CONFIG.fontFamily.replace(/'/g, '')},sans-serif",minHeight:44}} placeholder="中文 Characters" value={cn} onChange={e=>setCn(e.target.value)} />
            <input style={{flex:"2 1 100px",minWidth:80,background:"var(--cream)",border:"1.5px solid var(--st)",borderRadius:8,padding:"10px 12px",fontSize:".82rem",color:"var(--plum)",fontStyle:"italic",outline:"none",minHeight:44}} placeholder="jyut6 ping4" value={jyut} onChange={e=>setJyut(e.target.value)} />
          </div>
          <div style={{display:"flex",gap:6,marginBottom:8}}>
            <input style={{flex:1,background:"var(--cream)",border:"1.5px solid var(--st)",borderRadius:8,padding:"10px 12px",fontSize:".82rem",color:"var(--ink)",outline:"none",minHeight:44}} placeholder="English meaning" value={en} onChange={e=>setEn(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addItem()} />
            <button style={{background:"var(--for)",color:"var(--lime)",border:"none",borderRadius:8,padding:"10px 16px",fontSize:".82rem",fontWeight:800,cursor:"pointer",minHeight:44}} onClick={addItem}>Add</button>
          </div>
          <div style={{fontSize:".65rem",color:"var(--ink3)",marginBottom:8,lineHeight:1.5}}>
            Look up words at <a href="https://words.hk" target="_blank" rel="noopener" style={{color:"var(--plum)",textDecoration:"none",fontWeight:700}}>words.hk</a> or <a href="https://cc-canto.org" target="_blank" rel="noopener" style={{color:"var(--plum)",textDecoration:"none",fontWeight:700}}>cc-canto.org</a>
          </div>
          {learning.length>0 && (
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              <div style={{fontSize:".68rem",fontWeight:700,color:"var(--ink3)",marginBottom:2}}>Still learning — priority in every lesson:</div>
              {items.map((s,i) => {
                if (s.known || !s.cn || s.cn === "(add characters)") return null;
                return (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:6,background:"var(--cream)",borderRadius:8,padding:"8px 10px",border:"1px solid var(--st)"}}>
                    <button style={{background:"none",border:"none",cursor:"pointer",padding:0,minHeight:30,display:"flex",alignItems:"center",gap:4,flex:1}} onClick={()=>speak(s.cn)}>
                      <span style={{fontFamily:"${LANG_CONFIG.fontFamily.replace(/'/g, '')}",fontWeight:700,fontSize:".82rem",color:"var(--ink)"}}>{s.cn}</span>
                      {s.jyut && s.jyut !== "(add jyutping)" && <span style={{fontSize:".68rem",fontStyle:"italic",color:"var(--plum)"}}>{s.jyut}</span>}
                      {s.en && <span style={{fontSize:".68rem",color:"var(--ink3)"}}>{s.en}</span>}
                    </button>
                    <button style={{background:"var(--lime)",border:"none",borderRadius:6,padding:"4px 8px",fontSize:".62rem",fontWeight:800,color:"var(--for)",cursor:"pointer",whiteSpace:"nowrap"}} onClick={()=>markKnown(i)}>I know this ✓</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- HOME TAB (Phase 2a) ----
function HomeTab({ profile, progress, upd, settings, setTab, recentTopics, setRecentTopics, practiceCount, library, selUnit, setSelUnit, markReviewed, startPlaylist, openPlBuilder, isPremium, setShowPremiumGate }) {
  const [shadow, setShadow] = useState(null);
  const [searchQ, setSearchQ] = useState("");
  const [readingMode, setReadingMode] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [actionBarScrolled, setActionBarScrolled] = useState(false);
  const [miniPlayer, setMiniPlayer] = useState(null);
  const miniTimer = useRef(null);

  const playPhraseMini = (ph) => {
    clearTimeout(miniTimer.current);
    setMiniPlayer({ en: ph.en, cn: ph.cn, jyut: getRom(ph), playing: true });
    speak(ph.cn);
    miniTimer.current = setTimeout(() => setMiniPlayer(null), 6000);
  };
  useEffect(() => () => clearTimeout(miniTimer.current), []);
  const phraseListRef = useRef(null);
  const searchRef = useRef(null);
  const stats = useMemo(() => getStats(progress), [progress]);
  const userName = profile;

  const totalPhrases = UNITS.reduce((s, u) => s + u.phrases.length, 0);
  const knownPhrases = Object.keys(progress.phrases || {}).filter(k => (progress.phrases || {})[k]).length;
  const pct = totalPhrases ? Math.round(knownPhrases / totalPhrases * 100) : 0;

  // Time-based greeting
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // PhrasesTab logic
  const unit = UNITS.find(u => u.id === selUnit) || UNITS[0];
  const kc = unit.phrases.filter((_, i) => (progress.phrases || {})[`${unit.id}-${i}`]).length;
  const sorted = unit.phrases.map((p, i) => ({ ...p, origIdx: i, known: !!(progress.phrases || {})[`${unit.id}-${i}`] })).sort((a, b) => a.known - b.known);
  const topicIcons = {1:"👋",2:"🤝",3:"🚕",4:"☕",5:"🍜",6:"🛍",7:"🏫",8:"🏠",9:"🕐",10:"❤️",11:"🍻",12:"🌧",13:"💰",14:"💪",15:"😤",16:"📱",17:"🥺",18:"🔢",19:"🎉",20:"🌇"};
  const sortedUnits = [...UNITS].sort((a, b) => {
    const aDone = a.phrases.every((_, i) => (progress.phrases || {})[`${a.id}-${i}`]);
    const bDone = b.phrases.every((_, i) => (progress.phrases || {})[`${b.id}-${i}`]);
    if (aDone && !bDone) return 1;
    if (!aDone && bDone) return -1;
    return a.id - b.id;
  });
  const selectUnit = (id) => {
    if (!isPremium && !FREE_UNIT_IDS.includes(id)) {
      setShowPremiumGate(true);
      return;
    }
    setSelUnit(id);
    setTimeout(() => { if (phraseListRef.current) phraseListRef.current.scrollIntoView({ behavior: "smooth" }); }, 80);
  };

  // Gradient colors for topic cards (fallbacks)
  const TOPIC_GRADIENTS = [
    "linear-gradient(135deg, #2D5A3D, #1F3329)",
    "linear-gradient(135deg, #3D4A5A, #1F2939)",
    "linear-gradient(135deg, #4A3D5A, #291F39)",
    "linear-gradient(135deg, #5A4A3D, #39291F)",
    "linear-gradient(135deg, #3D5A4A, #1F3929)",
    "linear-gradient(135deg, #5A3D4A, #391F29)",
  ];

  const TOPIC_IMAGES = {
    1: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=300&h=200&fit=crop",
    2: "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=300&h=200&fit=crop",
    3: "https://images.unsplash.com/photo-1536640712-4d4c36ff0e4e?w=300&h=200&fit=crop",
    4: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=300&h=200&fit=crop",
    5: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=300&h=200&fit=crop",
    6: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=300&h=200&fit=crop",
    7: "https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=300&h=200&fit=crop",
    8: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=300&h=200&fit=crop",
    9: "https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=300&h=200&fit=crop",
    10: "https://images.unsplash.com/photo-1518199266791-5375a83190b7?w=300&h=200&fit=crop",
    11: "https://images.unsplash.com/photo-1575037614876-c38a4ca44f42?w=300&h=200&fit=crop",
    12: "https://images.unsplash.com/photo-1501691223387-dd0500403074?w=300&h=200&fit=crop",
    13: "https://images.unsplash.com/photo-1553729459-afe8f2e2ed65?w=300&h=200&fit=crop",
    14: "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=300&h=200&fit=crop",
    15: "https://images.unsplash.com/photo-1544027993-37dbfe43562a?w=300&h=200&fit=crop",
    16: "https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=300&h=200&fit=crop",
    17: "https://images.unsplash.com/photo-1516483638261-f4dbaf036963?w=300&h=200&fit=crop",
    18: "https://images.unsplash.com/photo-1466378284817-a6b7fd50cc5a?w=300&h=200&fit=crop",
    19: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=300&h=200&fit=crop",
    20: "https://images.unsplash.com/photo-1462275646964-a0e3c11f18a6?w=300&h=200&fit=crop",
  };

  // Search across ALL units + GLOSS_DATA
  const searchResults = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return [];
    const results = [];
    // Search phrases from all units
    UNITS.forEach(u => {
      u.phrases.forEach((ph, i) => {
        const matchEn = (ph.en || "").toLowerCase().includes(q);
        const matchCn = (ph.cn || "").toLowerCase().includes(q);
        const matchJyut = (getRom(ph) || "").toLowerCase().includes(q);
        if (matchEn || matchCn || matchJyut) {
          results.push({ type: "phrase", en: ph.en, cn: ph.cn, jyut: getRom(ph), unitId: u.id, unitTitle: u.title, idx: i });
        }
      });
    });
    // Search GLOSS_DATA keys
    Object.keys(GLOSS_DATA || {}).forEach(key => {
      if (key.toLowerCase().includes(q)) {
        const g = GLOSS_DATA[key];
        if (Array.isArray(g)) {
          g.forEach(w => {
            results.push({ type: "word", en: w.en || "", cn: w.cn || key, jyut: w.jy || "", unitId: null, unitTitle: null });
          });
        }
      }
    });
    return results.slice(0, 8);
  }, [searchQ]);

  // Continue practicing: in-progress topics (at least 1 known but not all)
  const inProgressTopics = useMemo(() => {
    return UNITS.filter(u => {
      const k = u.phrases.filter((_, i) => (progress.phrases || {})[`${u.id}-${i}`]).length;
      return k > 0 && k < u.phrases.length;
    });
  }, [progress]);

  // Use recentTopics to order in-progress, fallback to natural order
  const continueTopics = useMemo(() => {
    const ordered = [];
    // Add recent ones first if they are in-progress
    (recentTopics || []).forEach(rid => {
      const found = inProgressTopics.find(u => u.id === rid);
      if (found && !ordered.find(o => o.id === found.id)) ordered.push(found);
    });
    // Fill rest
    inProgressTopics.forEach(u => {
      if (!ordered.find(o => o.id === u.id)) ordered.push(u);
    });
    return ordered.slice(0, 4);
  }, [inProgressTopics, recentTopics]);

  // Helper to update recent topics
  const updateRecent = (id) => {
    setRecentTopics(prev => [id, ...(prev || []).filter(x => x !== id)].slice(0, 10));
  };

  // Resolve recent topics to units
  const recentUnits = useMemo(() => {
    return (recentTopics || []).map(id => UNITS.find(u => u.id === id)).filter(Boolean);
  }, [recentTopics]);

  // Library count
  const libraryCount = (progress.unit10 || []).length;

  // Preload audio for selected unit
  useEffect(() => { preloadUnitAudio(unit.phrases); }, [selUnit]);

  if (shadow !== null) return <ShadowMode unit={unit} progress={progress} upd={upd} settings={settings} onClose={() => { releaseMicStream(); setShadow(null); }} startIdx={shadow === "unit" ? 0 : shadow} single={shadow !== "unit"} />;

  // When a unit is selected, show lesson view
  if (selUnit) {
    const items = unit.phrases;
    const knownInUnit = items.filter((_,i)=>(progress.phrases||{})[`${unit.id}-${i}`]).length;
    const unitPct = Math.round(knownInUnit/items.length*100);

    return (
      <div style={{paddingBottom:80}}>
        <div className="lesson-hdr">
          <div className="lesson-hdr-top">
            <button className="lesson-back" onClick={()=>setSelUnit(null)}>&#8592; Back</button>
            <div className="lesson-stats-badge">{knownInUnit} known &middot; {unitPct}%</div>
          </div>
          <div className="lesson-hero">
            <div className="lesson-art"><img src={TOPIC_IMAGES[unit.id] || TOPIC_IMAGES[1]} alt="" /></div>
            <div className="lesson-meta">
              <div className="lesson-meta-title">{unit.title}</div>
              <div className="lesson-meta-sub">{items.length} phrases &middot; Unit {unit.id}</div>
              <div className="lesson-meta-progress">{knownInUnit} of {items.length} learned</div>
            </div>
          </div>
        </div>
        <div className="ctrl-row">
          <button className="play-all-btn" onClick={()=>startPlaylist(items.map(p=>({en:p.en,cn:p.cn,jyut:p.jyut})),unit.title)}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 2.5L15 9L4 15.5V2.5Z" fill="#fff"/></svg>
          </button>
          <button className="shuffle-btn" onClick={()=>setShadow("unit")}>Shuffle</button>
          <span className="filter-chip" onClick={()=>setReadingMode(r=>!r)}>{readingMode?"Chinese first":"English first"}</span>
        </div>
        <div>
          {sorted.map((ph,i) => {
            const gloss = getAutoGloss(ph);
            const isExp = expandedIdx === ph.origIdx;
            return (
              <div className={"ph-item" + (isExp?" expanded":"")} key={ph.origIdx} onClick={()=>setExpandedIdx(isExp?null:ph.origIdx)}>
                <div className="ph-row">
                  <button className="ph-play" onClick={e=>{e.stopPropagation();playPhraseMini(ph);}}>
                    <svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M0 0L10 6L0 12V0Z" fill="#fff"/></svg>
                  </button>
                  <div className="ph-text">
                    {readingMode ? (
                      <>
                        <div className="ph-chi" style={{fontSize:15,fontWeight:600,color:"var(--ink)",marginBottom:3,display:"flex",justifyContent:"space-between",alignItems:"center"}}>{ph.cn}<div className="ph-chev">&#9662;</div></div>
                        <div className="ph-jyut">{getRom(ph)}</div>
                        <div style={{fontSize:13,color:"var(--ink2)"}}>{ph.en}</div>
                      </>
                    ) : (
                      <>
                        <div className="ph-eng">{ph.en}<div className="ph-chev">&#9662;</div></div>
                        <div className="ph-jyut">{getRom(ph)}</div>
                        <div className="ph-chi">{ph.cn}</div>
                      </>
                    )}
                  </div>
                </div>
                <div className="ph-detail">
                  {ph.tag && <div className="ph-context">Context: {ph.tag}</div>}
                  {gloss.length > 0 && <div className="gloss-row">
                    {gloss.filter(g=>g.cn).map((g,gi) => (
                      <div className="gloss-chip" key={gi} onClick={e=>{e.stopPropagation();speak(g.cn);}}>
                        <span className="gloss-chi">{g.cn}</span>
                        <span className="gloss-jyut">{g.jy}</span>
                        {g.en && <span className="gloss-eng">{g.en}</span>}
                        <div className="gloss-actions">
                          <span className="gloss-action" onClick={e=>{e.stopPropagation();const items=progress.unit10||[];if(!items.find(s=>s.cn===g.cn)){upd("unit10",[{en:g.en||"",jyut:g.jy||"",cn:g.cn,tag:unit.title,known:false,date:new Date().toLocaleDateString("en-GB",{day:"numeric",month:"short"})},...items]);setPopup({e:"📖",t:"Saved to library",s:g.cn});}}}>{(progress.unit10||[]).find(s=>s.cn===g.cn)?"\u2713":"+"}</span>
                        </div>
                      </div>
                    ))}
                  </div>}
                  <div className="ph-actions">
                    <button className="ph-action-btn" onClick={e=>{e.stopPropagation();const items=progress.unit10||[];if(!items.find(s=>s.cn===ph.cn)){upd("unit10",[{en:ph.en,jyut:getRom(ph),cn:ph.cn,tag:unit.title,known:false,date:new Date().toLocaleDateString("en-GB",{day:"numeric",month:"short"})},...items]);setPopup({e:"📖",t:"Saved to library",s:ph.en});}}}>{(progress.unit10||[]).find(s=>s.cn===ph.cn)?"Saved":"Save to My Library"}</button>
                    <button className="ph-action-btn shadow-btn" onClick={e=>{e.stopPropagation();setShadow(ph.origIdx);}}>Shadow</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Mini player — shows when a phrase is playing */}
        {miniPlayer && <div style={{position:"fixed",bottom:64,left:0,right:0,zIndex:110,padding:"0 12px",animation:"fadeUp .2s ease"}}>
          <div style={{background:"rgba(20,20,20,.95)",borderRadius:14,padding:"10px 14px",display:"flex",alignItems:"center",gap:12,boxShadow:"0 8px 32px rgba(0,0,0,.4)",border:"1px solid rgba(255,255,255,.06)"}}>
            <div style={{width:40,height:40,borderRadius:8,background:"var(--for)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,cursor:"pointer"}} onClick={()=>{speak(miniPlayer.cn);}}>
              <svg width="12" height="14" viewBox="0 0 10 12" fill="none"><path d="M0 0L10 6L0 12V0Z" fill="#C4F000"/></svg>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:".78rem",fontWeight:600,color:"rgba(255,255,255,.85)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{miniPlayer.en}</div>
              <div style={{fontSize:".68rem",fontStyle:"italic",color:"var(--lime)",marginTop:1}}>{miniPlayer.jyut}</div>
            </div>
            <div style={{fontSize:"1.4rem",fontWeight:900,color:"#fff",flexShrink:0}}>{miniPlayer.cn}</div>
            <button onClick={()=>{stopAudio();clearTimeout(miniTimer.current);setMiniPlayer(null);}} style={{background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.1)",borderRadius:"50%",width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",color:"rgba(255,255,255,.5)",fontSize:14,cursor:"pointer",flexShrink:0}}>x</button>
          </div>
        </div>}
      </div>
    );
  }

  // Home view (no unit selected)
  return (
    <div style={{paddingBottom:80}}>
      {/* Header with gradient */}
      <div className="home-hdr">
        <div className="home-greeting">
          <div className="greeting-text">{greeting}, {userName.split(" ")[0]}</div>
          <div className="greeting-sub">Keep going, you're building real fluency.</div>
          <div className="stats-row">
            <div className="stat-item">
              <div className="stat-num">{knownPhrases}</div>
              <div className="stat-label">Phrases Learned</div>
            </div>
            <div className="stat-item">
              <div className="stat-num">{(progress.lessonLog||[]).length}</div>
              <div className="stat-label">Lessons Done</div>
            </div>
          </div>
          <button className="start-btn" onClick={()=>setTab("practice")}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 2.5L15 9L4 15.5V2.5Z" fill="#111"/></svg>
            Start Today's Lesson
          </button>
        </div>
      </div>

      <div>
        {/* Search */}
        <div className="search-wrap">
          <svg className="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="#9A9A9A" strokeWidth="1.5"/><path d="M11 11L15 15" stroke="#9A9A9A" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <input className="home-search" placeholder="Search phrases & words" value={searchQ} onChange={e=>setSearchQ(e.target.value)} ref={searchRef} />
          {searchQ && <button onClick={()=>{setSearchQ("");if(searchRef.current)searchRef.current.focus();}} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",fontSize:16,color:"var(--ink3)",cursor:"pointer"}}>x</button>}
        </div>
        {/* Search results dropdown */}
        {searchResults.length > 0 && <div className="search-results" style={{margin:"0 16px 12px"}}>
          {searchResults.map((r, ri) => (
            <div key={ri} className="search-result" style={{flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,width:"100%"}} onClick={() => {
                if (r.unitId) { setSelUnit(r.unitId); updateRecent(r.unitId); setSearchQ(""); }
              }}>
                <span className="search-badge" style={{ background: r.type === "phrase" ? "rgba(122,170,0,.15)" : "rgba(143,106,232,.15)", color: r.type === "phrase" ? "var(--ld)" : "var(--plum)" }}>
                  {r.type === "phrase" ? "PHRASE" : "WORD"}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: ".82rem", fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.en}</div>
                  <div style={{ fontSize: ".72rem", color: "var(--plum)", fontStyle: "italic" }}>{r.jyut}</div>
                </div>
                <div style={{ fontSize: ".82rem", color: "var(--ink3)", flexShrink: 0 }}>{r.cn}</div>
              </div>
              <div style={{display:"flex",gap:6,marginTop:6,paddingLeft:0,width:"100%"}}>
                <button onClick={(e)=>{e.stopPropagation();if(r.unitId){setSelUnit(r.unitId);updateRecent(r.unitId);setSearchQ("");}}} style={{background:"var(--cream)",border:"1px solid var(--st)",borderRadius:999,padding:"6px 14px",fontSize:".72rem",fontWeight:700,color:"var(--ink2)",cursor:"pointer",minHeight:36}}>Go to unit ›</button>
                <button onClick={(e)=>{e.stopPropagation();const items=progress.unit10||[];if(!items.find(s=>s.cn===r.cn)){upd("unit10",[{en:r.en,jyut:r.jyut,cn:r.cn,tag:r.unitTitle||"Search",known:false,date:new Date().toLocaleDateString("en-GB",{day:"numeric",month:"short"})},...items]);setPopup({e:"📖",t:"Saved to library",s:r.en});}}} style={{background:"var(--cream)",border:"1px solid var(--st)",borderRadius:999,padding:"6px 14px",fontSize:".72rem",fontWeight:700,color:"var(--ink2)",cursor:"pointer",minHeight:36}}>+ Add to library</button>
              </div>
            </div>
          ))}
        </div>}

        {/* My Library card */}
        <div className="lib-card" onClick={()=>setTab("library")}>
          <div className="lib-card-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 19V5a2 2 0 012-2h8.5L20 8.5V19a2 2 0 01-2 2H6a2 2 0 01-2-2z" stroke="#C4F000" strokeWidth="1.5"/><path d="M14 3v6h6" stroke="#C4F000" strokeWidth="1.5"/><path d="M8 13h8M8 17h5" stroke="#C4F000" strokeWidth="1.5" strokeLinecap="round"/></svg></div>
          <div className="lib-card-info">
            <div className="lib-card-title">My Library</div>
            <div className="lib-card-sub">{libraryCount} saved phrases</div>
          </div>
          <span style={{fontSize:18,color:"var(--ink3)"}}>&#8250;</span>
        </div>

        {/* Most Recent - 2-col grid, max 4 */}
        {recentUnits.length > 0 && <>
          <div className="sec-hdr"><span className="sec-title">Most Recent</span></div>
          <div className="recent-grid">
            {recentUnits.slice(0,4).map(u => (
              <div className="recent-card" key={u.id} onClick={()=>{setSelUnit(u.id);updateRecent(u.id);}}>
                <div className="recent-card-art"><img src={TOPIC_IMAGES[u.id] || TOPIC_IMAGES[1]} alt="" /></div>
                <div className="recent-card-name">{u.title}</div>
              </div>
            ))}
          </div>
        </>}

        {/* Continue Learning - horizontal scroll shelf */}
        {continueTopics.length > 0 && <>
          <div className="sec-hdr"><span className="sec-title">Continue Learning</span><span className="sec-link">See all</span></div>
          <div className="cont-scroll">
            {continueTopics.map(u => {
              const k = u.phrases.filter((_,i)=>(progress.phrases||{})[`${u.id}-${i}`]).length;
              const cpct = Math.round(k/u.phrases.length*100);
              return (
                <div className="cont-card" key={u.id} onClick={()=>{setSelUnit(u.id);updateRecent(u.id);}}>
                  <div className="cont-art">
                    <img src={TOPIC_IMAGES[u.id] || TOPIC_IMAGES[1]} alt="" />
                    <span className="topic-label">{u.title}</span>
                    <span className="play-circle">&#9654;</span>
                  </div>
                  <div className="cont-info">
                    <div className="cont-name">{u.title}</div>
                    <div className="cont-meta">{k} of {u.phrases.length} phrases learned</div>
                    <div className="cont-pbar"><div className="cont-pbar-fill" style={{width:cpct+"%"}} /></div>
                  </div>
                </div>
              );
            })}
          </div>
        </>}

        {/* All Topics - 2-row horizontal grid */}
        <div className="sec-hdr"><span className="sec-title">All Topics</span><span className="sec-link">{UNITS.length} topics</span></div>
        <div className="topics-wrap">
          <div className="topics-grid">
            {UNITS.map((u,i) => (
              <div className="t-card" key={u.id} onClick={()=>{setSelUnit(u.id);updateRecent(u.id);}}>
                <div className="t-art">
                  <img src={TOPIC_IMAGES[u.id] || TOPIC_IMAGES[1]} alt="" />
                  <span className="t-num">#{i+1}</span>
                </div>
                <div className="t-info">
                  <div className="t-name">{u.title}</div>
                  <div className="t-meta">{u.phrases.length} phrases</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- LIBRARY TAB (Phase 2a) ----
function LibraryTab({ library, setLibrary, progress, upd, settings }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [en, setEn] = useState("");
  const [rom, setRom] = useState("");
  const [cn, setCn] = useState("");
  const [saved, setSaved] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState(null);

  const items = progress.unit10 || [];
  const stillLearning = items.filter(s => !s.known);
  const mastered = items.filter(s => s.known);

  const romKey = LANG_CONFIG.romanizationKey;
  const romLabel = LANG_CONFIG.romanizationLabel;

  const handleSave = () => {
    if (!en.trim()) return;
    const ns = { en: en.trim(), [romKey]: rom.trim() || "", cn: cn.trim() || "", tag: "Life", date: new Date().toLocaleDateString("en-GB", { weekday: "short" }), known: false };
    upd("unit10", [ns, ...items]);
    setEn(""); setRom(""); setCn(""); setSaved(true);
    setTimeout(() => { setSaved(false); setShowAddForm(false); }, 1500);
  };

  const toggleKnown = (idx) => {
    const updated = items.map((s, i) => i === idx ? { ...s, known: !s.known } : s);
    upd("unit10", updated);
  };

  const removeItem = (idx) => {
    const updated = items.filter((_, i) => i !== idx);
    upd("unit10", updated);
  };

  const canSpeak = (s) => s.cn && s.cn !== "(add characters)" && s.cn.trim() !== "";

  return (
    <div className="mc">
      {/* 1. Header */}
      <div style={{ marginBottom: 4 }}>
        <div className="pt" style={{ marginBottom: 2 }}>My Library</div>
        <div style={{ fontSize: ".78rem", color: "var(--ink3)", fontWeight: 600 }}>
          {mastered.length} mastered · {stillLearning.length} to learn
        </div>
      </div>

      {/* 2. Add your own button / form */}
      {!showAddForm && !saved ? (
        <button onClick={() => setShowAddForm(true)} style={{
          width: "100%", padding: "14px 16px", background: "transparent",
          border: "2px dashed var(--st)", borderRadius: 12, cursor: "pointer",
          fontSize: ".84rem", fontWeight: 700, color: "var(--plum)",
          marginBottom: 16, minHeight: 48, textAlign: "center"
        }}>+ Add your own word or phrase</button>
      ) : saved ? (
        <div style={{
          width: "100%", padding: "14px 16px", background: "rgba(196,240,0,.1)",
          border: "2px solid var(--lime)", borderRadius: 12,
          fontSize: ".84rem", fontWeight: 800, color: "var(--for)",
          marginBottom: 16, textAlign: "center", minHeight: 48,
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>Saved to your library!</div>
      ) : (
        <div style={{
          background: "var(--wh)", borderRadius: 14, padding: 16,
          border: "1.5px solid var(--st)", marginBottom: 16
        }}>
          <input style={{
            width: "100%", background: "var(--cream)", border: "1.5px solid var(--st)",
            borderRadius: 8, padding: "10px 12px", fontSize: ".82rem", color: "var(--ink)",
            outline: "none", fontFamily: "inherit", marginBottom: 8, minHeight: 44,
            boxSizing: "border-box"
          }} placeholder="What do you want to say?" value={en} onChange={e => setEn(e.target.value)} />
          <input style={{
            width: "100%", background: "var(--cream)", border: "1.5px solid var(--st)",
            borderRadius: 8, padding: "10px 12px", fontSize: ".82rem", color: "var(--ink)",
            outline: "none", fontFamily: LANG_CONFIG.fontFamily, marginBottom: 8, minHeight: 44,
            boxSizing: "border-box"
          }} placeholder="Chinese characters" value={cn} onChange={e => setCn(e.target.value)} />
          <input style={{
            width: "100%", background: "var(--cream)", border: "1.5px solid var(--st)",
            borderRadius: 8, padding: "10px 12px", fontSize: ".82rem", color: "var(--plum)",
            fontStyle: "italic", outline: "none", fontFamily: "inherit", marginBottom: 12,
            minHeight: 44, boxSizing: "border-box"
          }} placeholder={romLabel} value={rom} onChange={e => setRom(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setShowAddForm(false); setEn(""); setRom(""); setCn(""); }} style={{
              flex: 1, background: "var(--cream)", color: "var(--ink3)", border: "1.5px solid var(--st)",
              borderRadius: 10, padding: "10px 0", fontSize: ".82rem", fontWeight: 700,
              cursor: "pointer", minHeight: 44
            }}>Cancel</button>
            <button onClick={handleSave} style={{
              flex: 1, background: en.trim() ? "var(--lime)" : "var(--st)",
              color: en.trim() ? "var(--for)" : "var(--ink3)", border: "none",
              borderRadius: 10, padding: "10px 0", fontSize: ".82rem", fontWeight: 900,
              cursor: en.trim() ? "pointer" : "default", minHeight: 44
            }}>Save</button>
          </div>
        </div>
      )}

      {/* 3. Trophy Section — Mastered */}
      {mastered.length > 0 && (
        <div style={{
          background: "linear-gradient(135deg, #1F3329 0%, #2a4a36 50%, #1F3329 100%)",
          borderRadius: 16, padding: 16, marginBottom: 16
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 12
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "1.2rem" }}>🏆</span>
              <span style={{ color: "#fff", fontWeight: 800, fontSize: ".88rem" }}>Mastered</span>
            </div>
            <span style={{ color: "var(--lime)", fontSize: ".75rem", fontWeight: 700 }}>
              {mastered.length} conquered
            </span>
          </div>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8
          }}>
            {mastered.map((s) => {
              const idx = items.indexOf(s);
              return (
                <div key={idx} style={{
                  background: "linear-gradient(135deg, #FAFFF0, #fff)",
                  border: "2px solid rgba(122,170,0,.25)", borderRadius: 12,
                  padding: 12, display: "flex", flexDirection: "column", gap: 4
                }}>
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between"
                  }}>
                    <span style={{
                      fontFamily: LANG_CONFIG.fontFamily, fontSize: "1rem",
                      fontWeight: 700, color: "var(--ink)", lineHeight: 1.2
                    }}>{s.cn || s.en}</span>
                    {canSpeak(s) && (
                      <button onClick={() => speak(s.cn)} style={{
                        width: 36, height: 36, borderRadius: "50%", border: "none",
                        background: "rgba(122,170,0,.15)", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: ".7rem", color: "var(--for)", flexShrink: 0
                      }}>&#9654;</button>
                    )}
                  </div>
                  {s[romKey] && s[romKey] !== `(add ${romLabel.toLowerCase()})` && (
                    <div style={{
                      fontSize: ".72rem", color: "var(--plum)", fontStyle: "italic", fontWeight: 600
                    }}>{s[romKey]}</div>
                  )}
                  <div style={{
                    fontSize: ".68rem", color: "var(--ink3)", lineHeight: 1.3
                  }}>{s.cn ? s.en : ""}</div>
                  <button onClick={() => toggleKnown(idx)} style={{
                    background: "none", border: "none", color: "var(--plum)",
                    fontSize: ".72rem", fontWeight: 700, cursor: "pointer",
                    padding: "8px 0", textAlign: "left", marginTop: 2, minHeight: 36
                  }}>Relearn</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. Shadow all bar — only when Still Learning items exist */}
      {stillLearning.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
          background: "var(--for)", borderRadius: 12, padding: "10px 14px"
        }}>
          <button onClick={() => {/* shadow all — future hook */}} style={{
            width: 40, height: 40, borderRadius: "50%", background: "var(--lime)",
            border: "none", cursor: "pointer", display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: ".9rem", color: "var(--for)",
            fontWeight: 900, flexShrink: 0
          }}>&#9654;</button>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#fff", fontSize: ".78rem", fontWeight: 800 }}>Shadow all</div>
            <div style={{ color: "rgba(255,255,255,.5)", fontSize: ".65rem" }}>
              {stillLearning.length} phrase{stillLearning.length !== 1 ? "s" : ""}
            </div>
          </div>
          <button onClick={() => {/* shuffle shadow — future hook */}} style={{
            background: "rgba(255,255,255,.1)", border: "none", borderRadius: 999,
            padding: "10px 14px", color: "rgba(255,255,255,.7)", fontSize: ".72rem",
            fontWeight: 700, cursor: "pointer", minHeight: 44
          }}>🔀 Shuffle</button>
        </div>
      )}

      {/* 5. Still Learning section header */}
      {stillLearning.length > 0 && (
        <div style={{
          fontSize: ".7rem", fontWeight: 800, color: "var(--ink3)",
          letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 8
        }}>STILL LEARNING ({stillLearning.length})</div>
      )}

      {/* 6. Still Learning track list — expandable like lesson view */}
      {stillLearning.map((s) => {
        const idx = items.indexOf(s);
        const isExp = expandedIdx === idx;
        const gloss = canSpeak(s) ? getAutoGloss(s) : [];
        return (
          <div key={idx} className={"ph-item" + (isExp ? " expanded" : "")} onClick={() => setExpandedIdx(isExp ? null : idx)}>
            <div className="ph-row">
              <button className="ph-play" onClick={e => { e.stopPropagation(); if (canSpeak(s)) speak(s.cn); }}>
                <svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M0 0L10 6L0 12V0Z" fill="#fff"/></svg>
              </button>
              <div className="ph-text">
                <div className="ph-eng">{s.en}<div className="ph-chev">&#9662;</div></div>
                {s[romKey] && s[romKey] !== `(add ${romLabel.toLowerCase()})` && (
                  <div className="ph-jyut">{s[romKey]}</div>
                )}
                {s.cn && s.cn.trim() !== "" && (
                  <div className="ph-chi">{s.cn}</div>
                )}
              </div>
            </div>
            <div className="ph-detail">
              {s.tag && <div className="ph-context">From: {s.tag}</div>}
              {gloss.length > 0 && <div className="gloss-row">
                {gloss.filter(g => g.cn).map((g, gi) => (
                  <div className="gloss-chip" key={gi} onClick={e => { e.stopPropagation(); speak(g.cn); }}>
                    <span className="gloss-chi">{g.cn}</span>
                    <span className="gloss-jyut">{g.jy}</span>
                    {g.en && <span className="gloss-eng">{g.en}</span>}
                  </div>
                ))}
              </div>}
              <div className="ph-actions">
                <button className="ph-action-btn" onClick={e => { e.stopPropagation(); toggleKnown(idx); }}>
                  {s.known ? "Move to Still Learning" : "I know this!"}
                </button>
                <button className="ph-action-btn shadow-btn" onClick={e => { e.stopPropagation(); removeItem(idx); }}>Remove</button>
              </div>
            </div>
          </div>
        );
      })}

      {/* 7. Empty state */}
      {items.length === 0 && (
        <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--ink3)" }}>
          <div style={{ fontSize: "2.5rem", marginBottom: 12 }}>📚</div>
          <div style={{ fontSize: ".92rem", fontWeight: 800, color: "var(--ink)", marginBottom: 6 }}>Your library is empty</div>
          <div style={{ fontSize: ".78rem", lineHeight: 1.6, marginBottom: 20, maxWidth: 260, margin: "0 auto 20px" }}>
            Add words and phrases you hear in daily life. They'll become your top priority in practice.
          </div>
          <button onClick={() => setShowAddForm(true)} style={{
            background: "var(--lime)", color: "var(--for)", border: "none",
            borderRadius: 12, padding: "12px 24px", fontSize: ".84rem",
            fontWeight: 900, cursor: "pointer", minHeight: 48
          }}>+ Add your first phrase</button>
        </div>
      )}
    </div>
  );
}

// ---- PRACTICE TAB (Phase 2f) ----
function PracticeTab({ progress, upd, settings, library, practiceCount, setPracticeCount }) {
  const [showQuiz, setShowQuiz] = useState(false);
  const [showLaunch, setShowLaunch] = useState(false);
  const stats = useMemo(() => getStats(progress), [progress]);
  const mastered = Object.keys(progress.phrases || {}).filter(k => (progress.phrases || {})[k]).length;
  const totalPhrases = UNITS.reduce((s, u) => s + u.phrases.length, 0);
  const practicing = totalPhrases - mastered;

  // Items available for Quick Quiz: mastered + still learning
  const quizAvailable = useMemo(() => {
    let count = 0;
    UNITS.forEach(u => { u.phrases.forEach((_, i) => { const key = `${u.id}-${i}`; if ((progress.phrases || {})[key]) count++; }); });
    // Also count library items
    (progress.unit10 || []).forEach(s => { if (s.known) count++; });
    return count;
  }, [progress]);

  // Next uncompleted topic for launch screen
  const nextTopic = useMemo(() => {
    for (const u of UNITS) {
      const done = u.phrases.every((_, i) => (progress.phrases || {})[`${u.id}-${i}`]);
      if (!done) return u;
    }
    return UNITS[0];
  }, [progress]);

  // Still learning count for launch screen
  const stillLearningCount = useMemo(() => {
    let count = 0;
    UNITS.forEach(u => { u.phrases.forEach((_, i) => { if (!(progress.phrases || {})[`${u.id}-${i}`]) count++; }); });
    return count;
  }, [progress]);

  if (showQuiz) return <QuizTab progress={progress} upd={upd} />;

  // 6-phase Daily Practice launch screen
  if (showLaunch) {
    const phases = [
      { icon: "🔥", name: "Warm-up", time: "3 min", desc: "Review 5–8 mastered items" },
      { icon: "🆕", name: "Learn new", time: "7 min", desc: "3–5 new phrases from next topic" },
      { icon: "🗣", name: "Shadow drill", time: "8 min", desc: "Listen & repeat pattern" },
      { icon: "🔁", name: "Mix & review", time: "5 min", desc: "Everything shuffled" },
      { icon: "🧠", name: "Quiz", time: "5 min", desc: "Rapid-fire recall" },
      { icon: "😌", name: "Cool-down", time: "2 min", desc: "Relaxed listen-through" },
    ];
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "linear-gradient(160deg, #1F3329 0%, #2A4A35 50%, #1F3329 100%)", display: "flex", flexDirection: "column", alignItems: "center", padding: "0 24px", overflowY: "auto" }}>
        {/* Back button */}
        <button onClick={() => setShowLaunch(false)} style={{ position: "absolute", top: 16, left: 16, background: "rgba(255,255,255,.1)", border: "none", borderRadius: 999, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff", fontSize: "1.1rem" }}>&#8249;</button>

        <div style={{ marginTop: 72, textAlign: "center" }}>
          <div style={{ fontSize: "3rem", marginBottom: 8 }}>🎧</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 900, color: "#fff", marginBottom: 4 }}>Today's Practice</div>
          <div style={{ fontSize: ".72rem", color: "rgba(255,255,255,.45)" }}>~30 minutes · 6 phases</div>
        </div>

        {/* Phase list */}
        <div style={{ width: "100%", maxWidth: 360, marginTop: 28 }}>
          {phases.map((p, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 0", borderBottom: i < phases.length - 1 ? "1px solid rgba(255,255,255,.08)" : "none" }}>
              <div style={{ fontSize: "1.3rem", width: 32, textAlign: "center", flexShrink: 0 }}>{p.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: ".82rem", fontWeight: 800, color: "#fff" }}>{p.name}</div>
                <div style={{ fontSize: ".68rem", color: "rgba(255,255,255,.45)", marginTop: 1 }}>{p.desc}</div>
              </div>
              <div style={{ fontSize: ".68rem", fontWeight: 700, color: "var(--lime)", flexShrink: 0 }}>{p.time}</div>
            </div>
          ))}
        </div>

        {/* Info line */}
        <div style={{ marginTop: 20, fontSize: ".72rem", color: "rgba(255,255,255,.4)", textAlign: "center", lineHeight: 1.5 }}>
          {stillLearningCount} items in Still Learning · Next topic: {nextTopic.title}
        </div>

        {/* Begin button */}
        <button onClick={() => {
          const next = practiceCount + 1;
          setPracticeCount(next);
          localStorage.setItem(LANG_CONFIG.id + '-practice-count', next);
          setShowLaunch(false);
          setShowQuiz(true);
        }} style={{ marginTop: 24, marginBottom: 40, background: "var(--lime)", color: "var(--for)", border: "none", borderRadius: 999, padding: "16px 48px", fontSize: ".92rem", fontWeight: 900, cursor: "pointer", minHeight: 56, boxShadow: "0 4px 20px rgba(196,240,0,.3)" }}>
          ▶ Begin practice
        </button>
      </div>
    );
  }

  return (
    <div className="mc">
      <div className="pt">Practice & Quiz</div>
      <div className="ps">Build your skills with structured practice or test what you know.</div>

      {/* Daily Practice card — dark green, recommended */}
      <div style={{ background: "var(--for)", borderRadius: 16, padding: 20, marginBottom: 12, cursor: "pointer" }} onClick={() => setShowLaunch(true)}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: "2rem" }}>🎧</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: ".92rem", fontWeight: 900, color: "#fff", marginBottom: 2 }}>Daily Practice</div>
            <div style={{ fontSize: ".72rem", color: "rgba(255,255,255,.55)", lineHeight: 1.4 }}>A full 30-minute session with warm-up, new phrases, shadowing, review, and quiz.</div>
          </div>
          <div style={{ fontSize: "1.2rem", color: "var(--lime)" }}>&#8250;</div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <span style={{ fontSize: ".62rem", fontWeight: 700, background: "rgba(255,255,255,.12)", color: "rgba(255,255,255,.6)", padding: "3px 8px", borderRadius: 999 }}>30 min</span>
          <span style={{ fontSize: ".62rem", fontWeight: 700, background: "rgba(196,240,0,.15)", color: "var(--lime)", padding: "3px 8px", borderRadius: 999 }}>Recommended</span>
        </div>
      </div>

      {/* Quick Quiz card — white */}
      <div style={{ background: "var(--wh)", borderRadius: 16, padding: 20, marginBottom: 12, border: "1.5px solid var(--st)", cursor: "pointer" }} onClick={() => setShowQuiz(true)}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: "2rem" }}>🧠</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: ".92rem", fontWeight: 900, color: "var(--ink)", marginBottom: 2 }}>Quick Quiz</div>
            <div style={{ fontSize: ".72rem", color: "var(--ink3)", lineHeight: 1.4 }}>Test your recall on 10 items from your library and learned phrases.</div>
          </div>
          <div style={{ fontSize: "1.2rem", color: "var(--ink3)" }}>&#8250;</div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <span style={{ fontSize: ".62rem", fontWeight: 700, background: "var(--cream)", color: "var(--ink3)", padding: "3px 8px", borderRadius: 999 }}>5 min</span>
          <span style={{ fontSize: ".62rem", fontWeight: 700, background: "var(--cream)", color: "var(--ink3)", padding: "3px 8px", borderRadius: 999 }}>{quizAvailable} items available</span>
        </div>
      </div>

      {/* Stats bar — Mastered | Practicing | Sessions */}
      <div style={{ background: "var(--cream)", borderRadius: 14, padding: 16, marginTop: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "1.3rem", fontWeight: 900, color: "var(--for)" }}>{mastered}</div>
            <div style={{ fontSize: ".62rem", fontWeight: 700, color: "var(--ink3)" }}>Mastered</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "1.3rem", fontWeight: 900, color: "var(--for)" }}>{practicing}</div>
            <div style={{ fontSize: ".62rem", fontWeight: 700, color: "var(--ink3)" }}>Practicing</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "1.3rem", fontWeight: 900, color: "var(--for)" }}>{practiceCount}</div>
            <div style={{ fontSize: ".62rem", fontWeight: 700, color: "var(--ink3)" }}>Sessions</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- TODAY (with lesson engine) ----
function TodayTab({ profile, progress, upd, markReviewed, setTab, setSelUnit, startPlaylist, openPlBuilder, settings }) {
  const [inLesson, setInLesson] = useState(false);
  const [addEn, setAddEn] = useState("");
  const [addJy, setAddJy] = useState("");
  const [addCn, setAddCn] = useState("");
  const [addSaved, setAddSaved] = useState(false);
  const userName = profile; // profile is now the display name string
  const stats = useMemo(()=>getStats(progress),[progress]);
  const totalLessons = (progress.lessonLog||[]).length;
  const earnedBadges = BADGE_DEFS.filter(b=>b.check(stats));
  const vk = Object.keys(progress.vocab||{}).filter(k=>progress.vocab[k]).length;
  const nextReward = Math.ceil((totalLessons+1)/10)*10;
  const lifeUnknown = (progress.unit10||[]).filter(s=>s.cn&&s.cn!=="(add characters)"&&!s.known).length;

  const [confirmQuit, setConfirmQuit] = useState(false);

  const handleAddSave = () => {
    if (!addEn.trim()) return;
    const ns = { en: addEn.trim(), jyut: addJy.trim()||"(add jyutping)", cn: addCn.trim()||"(add characters)", tag: "Life", date: new Date().toLocaleDateString("en-GB",{weekday:"short"}), known: false };
    upd("unit10", [ns, ...(progress.unit10||[])]);
    setAddEn(""); setAddJy(""); setAddCn(""); setAddSaved(true);
    setTimeout(()=>setAddSaved(false),2000);
  };

  const completeLesson = () => {
    const log = [...(progress.lessonLog||[]), {date:Date.now(), mins:30}];
    upd("lessonLog", log);
    setInLesson(false);
  };

  {/* Quit confirmation overlay — must be checked BEFORE inLesson */}
  if (confirmQuit) return (
    <div className="comp-ov">
      <div className="comp-em">😟</div>
      <div className="comp-t">Quit the lesson?</div>
      <div className="comp-s">This won't count toward your total.</div>
      <div style={{display:"flex",gap:8}}>
        <button className="comp-btn" style={{background:"rgba(255,255,255,.1)",color:"#fff"}} onClick={()=>setConfirmQuit(false)}>Keep going</button>
        <button className="comp-btn" style={{background:"var(--cor)"}} onClick={()=>{setConfirmQuit(false);setInLesson(false);trackEvent('lesson_abandoned');}}>Quit lesson</button>
      </div>
    </div>
  );

  if (inLesson) return <LessonMode progress={progress} upd={upd} profile={profile} settings={settings} onComplete={completeLesson} onQuit={()=>setConfirmQuit(true)} />;

  return (
    <div className="mc" style={{padding:"0 14px 80px"}}>

      {/* ── GREETING ── */}
      <div style={{padding:"20px 0 16px"}}>
        <div style={{fontSize:"1.3rem",fontWeight:900,color:"var(--ink)"}}>Hello, {userName.split(" ")[0]} 👋</div>
        <div style={{fontSize:".82rem",color:"var(--ink2)",lineHeight:1.5,marginTop:4}}>
          {totalLessons===0?"Welcome! Let's get you started with " + LANG_CONFIG.name + ".":
           didLessonToday(progress)?`Great work today! You've done ${totalLessons} lesson${totalLessons>1?"s":""} so far.`:
           `Good to see you! You've done ${totalLessons} lesson${totalLessons>1?"s":""} so far${stats.streak>1?` — ${stats.streak} days in a row! 🔥`:""}.`}
        </div>
      </div>

      {/* ── ADD NEW WORDS ── */}
      <div style={{background:"var(--wh)",borderRadius:16,padding:16,marginBottom:16,border:"1px solid var(--st)"}}>
        <div style={{fontSize:".62rem",fontWeight:800,textTransform:"uppercase",letterSpacing:1,color:"var(--ink3)",marginBottom:10}}>Step 1 · Add</div>
        <div style={{fontSize:".88rem",fontWeight:700,color:"var(--ink)",marginBottom:4}}>Anything new to practise?</div>
        <div style={{fontSize:".72rem",color:"var(--ink3)",marginBottom:10,lineHeight:1.5}}>Add a word or phrase — it'll be priority in every lesson until you've got it.</div>
        <AddNewSection progress={progress} upd={upd} />
      </div>

      {/* ── START LESSON ── */}
      <div style={{background:"var(--for)",borderRadius:16,padding:20,marginBottom:16,textAlign:"center"}}>
        <div style={{fontSize:".62rem",fontWeight:800,textTransform:"uppercase",letterSpacing:1,color:"rgba(196,240,0,.5)",marginBottom:10}}>Step 2 · Practise</div>
        <div style={{fontSize:".95rem",fontWeight:800,color:"#fff",marginBottom:4,lineHeight:1.4}}>
          {(()=>{
            const learning = (progress.unit10||[]).filter(s=>!s.known&&s.cn&&s.cn!=="(add characters)").length;
            if(learning>0) return `${learning} word${learning>1?"s":""} to drill — let's go!`;
            const headlines = [
              "30 minutes of focused practice",
              "Every session rewires your brain 🧠",
              "Consistency beats perfection",
              "One more lesson, one step closer ✨",
              "Small daily wins add up to something big",
            ];
            if(totalLessons===0) return "Your first lesson — 30 minutes is all it takes!";
            return headlines[totalLessons % headlines.length];
          })()}
        </div>
        <div style={{fontSize:".68rem",color:"rgba(255,255,255,.4)",marginBottom:14}}>Warm-up → Learn → Drill → Review → Quiz → Cool-down</div>
        <button style={{background:"var(--lime)",color:"var(--for)",border:"none",borderRadius:12,padding:"14px 36px",fontSize:".9rem",fontWeight:900,cursor:"pointer",boxShadow:"0 4px 12px rgba(0,0,0,.15)"}} onClick={()=>setInLesson(true)}>Start practising 💪</button>
      </div>

      <div style={{height:1,background:"var(--st)",margin:"0 0 24px"}} />

      {/* ── YOUR PROGRESS ── */}
      <div style={{marginBottom:16}}>
        <div style={{fontSize:".62rem",fontWeight:800,textTransform:"uppercase",letterSpacing:1,color:"var(--ink3)",marginBottom:10}}>Your Progress</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6}}>
          <div style={{background:"var(--wh)",borderRadius:12,padding:10,textAlign:"center",border:"1px solid var(--st)"}}>
            <div style={{fontSize:"1.2rem",fontWeight:900,color:"var(--for)"}}>{totalLessons}</div>
            <div style={{fontSize:".62rem",fontWeight:700,color:"var(--ink2)"}}>Lessons</div>
          </div>
          <div style={{background:"var(--wh)",borderRadius:12,padding:10,textAlign:"center",border:"1px solid var(--st)"}}>
            <div style={{fontSize:"1.2rem",fontWeight:900,color:"var(--for)"}}>{stats.streak}🔥</div>
            <div style={{fontSize:".62rem",fontWeight:700,color:"var(--ink2)"}}>Streak</div>
          </div>
          <div style={{background:"var(--wh)",borderRadius:12,padding:10,textAlign:"center",border:"1px solid var(--st)"}}>
            <div style={{fontSize:"1.2rem",fontWeight:900,color:"var(--for)"}}>{stats.known}</div>
            <div style={{fontSize:".62rem",fontWeight:700,color:"var(--ink2)"}}>Phrases</div>
          </div>
          <div style={{background:"var(--wh)",borderRadius:12,padding:10,textAlign:"center",border:"1px solid var(--st)"}}>
            <div style={{fontSize:"1.2rem",fontWeight:900,color:"var(--for)"}}>{vk}</div>
            <div style={{fontSize:".62rem",fontWeight:700,color:"var(--ink2)"}}>Words</div>
          </div>
        </div>
      </div>

      {/* ── REWARD JOURNEY ── */}
      <div style={{background:"var(--wh)",borderRadius:16,padding:18,marginBottom:16,border:"1px solid var(--st)"}}>
        <div style={{fontSize:".62rem",fontWeight:800,textTransform:"uppercase",letterSpacing:1,color:"var(--ink3)",marginBottom:10}}>Reward Journey</div>
          {Math.floor(totalLessons/10) > 0 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4,marginBottom:12,background:"var(--cream)",borderRadius:10,padding:8}}>
              {Array.from({length:Math.min(Math.floor(totalLessons/10),10)},(_,i)=>(
                <div key={i} style={{fontSize:"1.2rem",animation:`wiggle 1s ease-in-out ${i*0.15}s infinite`}}>🎁</div>
              ))}
              <div style={{fontSize:".68rem",fontWeight:900,color:"var(--for)",marginLeft:4}}>{Math.floor(totalLessons/10)} reward{Math.floor(totalLessons/10)>1?"s":""} earned!</div>
            </div>
          )}
          <div style={{position:"relative",padding:"8px 0",marginBottom:8}}>
            <div style={{position:"absolute",top:"50%",left:16,right:16,height:3,background:"var(--st)",borderRadius:2,transform:"translateY(-50%)"}} />
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",position:"relative",padding:"0 2px"}}>
              {Array.from({length:10},(_,i)=>{
                const inBlock = totalLessons % 10 || (totalLessons > 0 ? 10 : 0);
                const filled = i < inBlock;
                const isNext = i === inBlock && inBlock < 10;
                const isGift = i === 9;
                return (
                  <div key={i} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,position:"relative"}}>
                    {isNext && <div style={{position:"absolute",top:-20,fontSize:"1rem",animation:"runnerBounce 1s ease-in-out infinite",transform:"scaleX(-1)"}}>🏃</div>}
                    <div style={{
                      width:isGift?36:28, height:isGift?36:28, borderRadius:"50%",
                      background: filled ? "var(--lime)" : isNext ? "rgba(196,240,0,.15)" : "var(--st)",
                      border: filled ? "3px solid var(--ld)" : isNext ? "2px dashed var(--lime)" : "2px solid var(--st2)",
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontSize: isGift ? "1.1rem" : ".65rem", fontWeight:900,
                      color: filled ? "var(--for)" : isNext ? "var(--ld)" : "var(--ink3)",
                      boxShadow: filled ? "0 2px 8px rgba(196,240,0,.25)" : "none",
                      zIndex:1,
                    }}>{isGift ? "🎁" : filled ? "⭐" : i+1}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <style>{`
            @keyframes giftPulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.12); box-shadow: 0 0 12px rgba(196,240,0,.4); } }
            @keyframes runnerBounce { 0%,100% { transform:translateY(0) scaleX(-1); } 50% { transform:translateY(-5px) scaleX(-1); } }
            @keyframes wiggle { 0%,100% { transform:rotate(0deg); } 25% { transform:rotate(-5deg); } 75% { transform:rotate(5deg); } }
          `}</style>
        <div style={{fontSize:".68rem",color:"var(--ink2)",textAlign:"center",fontWeight:700,marginTop:4}}>
          {totalLessons === 0 ? "Complete lessons to move along the path!" :
           (totalLessons % 10 === 0 && totalLessons > 0) ? "🎉 You earned a reward! Ask mum or dad!" :
           `${10 - (totalLessons % 10)} more to go. You've got this! 💪`}
        </div>
      </div>

      {/* BADGES EARNED */}
      {earnedBadges.length > 0 && (
        <div style={{marginBottom:24}}>
          <div style={{fontSize:".62rem",fontWeight:900,color:"var(--ink3)",textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:6}}>BADGES EARNED</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
            {earnedBadges.map(b=>(
              <div key={b.id} style={{background:"linear-gradient(135deg,#FAFFF0,#fff)",border:"2px solid var(--ld)",borderRadius:12,padding:"10px 8px",textAlign:"center",boxShadow:"0 2px 8px rgba(196,240,0,.2)"}}>
                <div style={{fontSize:"1.5rem",marginBottom:2}}>{b.icon}</div>
                <div style={{fontSize:".72rem",fontWeight:900,color:"var(--for)",lineHeight:1.2}}>{b.name}</div>
                <div style={{fontSize:".65rem",fontWeight:600,color:"var(--ink2)",lineHeight:1.2,marginTop:2}}>{b.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coming up badges */}
      {(()=>{
        const upcoming = BADGE_DEFS.filter(b=>!b.check(stats));
        if(!upcoming.length) return null;
        return (
          <div style={{marginBottom:16}}>
            <div style={{cursor:"pointer",display:"flex",alignItems:"center",gap:6,padding:"6px 0"}} onClick={()=>{const el=document.getElementById("upcoming-badges");if(el)el.style.display=el.style.display==="none"?"grid":"none"}}>
              <span style={{fontSize:".75rem",fontWeight:600,color:"var(--ink3)"}}>🔒 {upcoming.length} more badges to unlock</span>
              <span style={{fontSize:".72rem",color:"var(--plum)",fontWeight:700}}>Peek ▾</span>
            </div>
            <div id="upcoming-badges" style={{display:"none",gridTemplateColumns:"repeat(3,1fr)",gap:5}}>
              {upcoming.map(b=>(
                <div key={b.id} style={{background:"var(--cream)",border:"1.5px dashed var(--st2)",borderRadius:12,padding:"10px 8px",textAlign:"center",opacity:.5}}>
                  <div style={{fontSize:"1.3rem",filter:"grayscale(1)",marginBottom:2}}>{b.icon}</div>
                  <div style={{fontSize:".68rem",fontWeight:700,color:"var(--ink3)",lineHeight:1.2}}>{b.desc}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div style={{height:1,background:"var(--st)",margin:"0 0 24px"}} />

      {/* FINISH LINE — Rich redesign matching Mandarin version */}
      {(()=>{
        const totalPhrases = UNITS.reduce((s,u)=>s+u.phrases.length,0);
        const knownPhrases = Object.keys(progress.phrases||{}).filter(k=>(progress.phrases||{})[k]).length;
        const totalAll = totalPhrases + ALL_WORDS.length;
        const knownAll = knownPhrases + vk;
        const pct = totalAll ? Math.min(100, Math.round(knownAll/totalAll*100)) : 0;
        const encouragement = knownAll === 0 ? "Start your first lesson and watch this bar grow." :
          knownAll < 20 ? <><strong>You've already started — keep going.</strong></> :
          knownAll < 100 ? <><strong>You're building real momentum.</strong></> :
          knownAll < 300 ? <><strong>You're well on your way — don't stop now.</strong></> :
          <><strong>You're deep in it — Cantonese is becoming part of you.</strong></>;
        return (
          <div style={{background:"linear-gradient(160deg, #0D2818 0%, #1A3A2A 30%, #1F4530 60%, #0D2818 100%)",borderRadius:20,padding:"28px 24px 24px",position:"relative",overflow:"hidden"}}>
            {/* Radial glows */}
            <div style={{position:"absolute",top:"-20%",left:"-15%",width:"80%",height:"70%",background:"radial-gradient(ellipse, rgba(196,240,0,.06) 0%, transparent 70%)",pointerEvents:"none"}} />
            <div style={{position:"absolute",bottom:"-10%",right:"-10%",width:"60%",height:"50%",background:"radial-gradient(ellipse, rgba(196,240,0,.04) 0%, transparent 70%)",pointerEvents:"none"}} />
            {/* Pulsing glow line */}
            <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg, transparent, rgba(196,240,0,.4), transparent)",animation:"glowPulse 3s ease-in-out infinite"}} />

            <div style={{position:"relative",zIndex:1}}>
              {/* YOUR FINISH LINE pill */}
              <div style={{display:"flex",justifyContent:"center",marginBottom:20}}>
                <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"rgba(196,240,0,.08)",border:"1px solid rgba(196,240,0,.15)",borderRadius:999,padding:"6px 16px"}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:"var(--lime)"}} />
                  <span style={{fontSize:".65rem",fontWeight:900,color:"var(--lime)",textTransform:"uppercase",letterSpacing:"1.5px"}}>YOUR FINISH LINE</span>
                </div>
              </div>

              {/* Headline + description + stats — responsive layout */}
              <div className="fl-layout">
                <div className="fl-left">
                  {/* Large headline */}
                  <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:"2rem",fontWeight:900,color:"#fff",lineHeight:1.15,marginBottom:12}}>
                    {totalPhrases} phrases + {ALL_WORDS.length} vocab words in <span style={{color:"var(--lime)"}}>Cantonese</span>
                  </div>
                  {/* Description */}
                  <div style={{fontSize:".82rem",color:"rgba(255,255,255,.55)",lineHeight:1.6,marginBottom:16}}>
                    The most essential words and phrases, carefully chosen to get you speaking in the real world. {encouragement}
                  </div>
                </div>

                <div className="fl-right">
                  {/* YOUR PROGRESS SO FAR */}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:10}}>
                    <span style={{fontSize:".9rem"}}>🎉</span>
                    <span style={{fontSize:".62rem",fontWeight:900,color:"rgba(255,255,255,.5)",textTransform:"uppercase",letterSpacing:"1.5px"}}>YOUR PROGRESS SO FAR</span>
                  </div>
                  {/* Stats card */}
                  <div style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.1)",borderRadius:14,padding:"16px 12px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px 0",marginBottom:16}}>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:"1.6rem",fontWeight:900,color:"#fff"}}>{knownPhrases}</div>
                      <div style={{fontSize:".6rem",fontWeight:800,color:"rgba(255,255,255,.35)",textTransform:"uppercase",letterSpacing:"1px",marginTop:2}}>{knownPhrases===1?"PHRASE":"PHRASES"} LEARNED</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:"1.6rem",fontWeight:900,color:"#fff"}}>{vk}</div>
                      <div style={{fontSize:".6rem",fontWeight:800,color:"rgba(255,255,255,.35)",textTransform:"uppercase",letterSpacing:"1px",marginTop:2}}>{vk===1?"WORD":"WORDS"} LEARNED</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:"1.6rem",fontWeight:900,color:"#fff"}}>{totalLessons}</div>
                      <div style={{fontSize:".6rem",fontWeight:800,color:"rgba(255,255,255,.35)",textTransform:"uppercase",letterSpacing:"1px",marginTop:2}}>{totalLessons===1?"LESSON":"LESSONS"} COMPLETED</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:"1.6rem",fontWeight:900,color:"var(--lime)"}}>{stats.streak} 🔥</div>
                      <div style={{fontSize:".6rem",fontWeight:800,color:"rgba(255,255,255,.35)",textTransform:"uppercase",letterSpacing:"1px",marginTop:2}}>DAY STREAK</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Progress bar section */}
              <div style={{marginBottom:20}}>
                <div style={{fontSize:".65rem",fontWeight:900,color:"var(--lime)",textTransform:"uppercase",letterSpacing:"1px",marginBottom:6}}>{knownAll} OF {totalAll}</div>
                <div style={{position:"relative",height:10,background:"rgba(255,255,255,.08)",borderRadius:6,overflow:"visible"}}>
                  <div style={{height:"100%",width:`${pct}%`,background:"linear-gradient(90deg, var(--lime), #9FE870)",borderRadius:6,position:"relative",transition:"width 1s ease",minWidth:pct>0?10:0}}>
                    {/* Shimmer */}
                    <div style={{position:"absolute",inset:0,borderRadius:6,background:"linear-gradient(90deg, transparent 0%, rgba(255,255,255,.25) 50%, transparent 100%)",animation:"shimmer 2.5s ease-in-out infinite"}} />
                  </div>
                  {/* Glowing dot */}
                  <div style={{position:"absolute",top:"50%",left:`${Math.max(1,pct)}%`,transform:"translate(-50%,-50%)",width:18,height:18,borderRadius:"50%",background:"var(--lime)",boxShadow:"0 0 10px rgba(196,240,0,.5), 0 0 20px rgba(196,240,0,.25)",border:"2.5px solid rgba(255,255,255,.3)"}} />
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
                  <span style={{fontSize:".62rem",fontWeight:700,color:"rgba(255,255,255,.25)",textTransform:"uppercase",letterSpacing:"1px"}}>START</span>
                  <span style={{fontSize:".62rem",fontWeight:700,color:"rgba(255,255,255,.25)"}}>🏆 Finish</span>
                </div>
              </div>

              {/* Nudge cards */}
              <div style={{display:"flex",gap:10}}>
                <div style={{flex:1,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:14,padding:"18px 14px",textAlign:"center"}}>
                  <div style={{fontSize:"1.5rem",marginBottom:8}}>🧠</div>
                  <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:"1.1rem",fontWeight:900,color:"var(--lime)",marginBottom:4}}>30 min a day</div>
                  <div style={{fontSize:".72rem",fontWeight:700,color:"rgba(255,255,255,.55)",marginBottom:2}}>Rewires your brain</div>
                  <div style={{fontSize:".65rem",color:"rgba(255,255,255,.55)",lineHeight:1.4}}>New neural pathways form with every session</div>
                </div>
                <div style={{flex:1,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:14,padding:"18px 14px",textAlign:"center"}}>
                  <div style={{fontSize:"1.5rem",marginBottom:8}}>🌍</div>
                  <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:"1.1rem",fontWeight:900,color:"var(--lime)",marginBottom:4}}>85M speakers</div>
                  <div style={{fontSize:".72rem",fontWeight:700,color:"rgba(255,255,255,.55)",marginBottom:2}}>The world opens up</div>
                  <div style={{fontSize:".65rem",color:"rgba(255,255,255,.55)",lineHeight:1.4}}>Every word connects you to more people</div>
                </div>
              </div>
            </div>
            <style>{`
              @keyframes glowPulse { 0%,100% { opacity:.4; } 50% { opacity:1; } }
              @keyframes shimmer { 0% { transform:translateX(-100%); } 100% { transform:translateX(200%); } }
              .fl-layout { display:flex; flex-direction:column; }
              .fl-left { margin-bottom:0; }
              .fl-right { margin-bottom:0; }
              @media(min-width:700px) {
                .fl-layout { flex-direction:row; gap:24px; align-items:flex-start; }
                .fl-left { flex:1.2; text-align:left; }
                .fl-right { flex:1; }
              }
            `}</style>
          </div>
        );
      })()}
    </div>
  );
}


// ---- PHRASES ----
function PhrasesTab({ progress, upd, selUnit, setSelUnit, settings }) {
  const [shadow, setShadow] = useState(null);
  const [readingMode, setReadingMode] = useState(false);
  const phraseListRef = useRef(null);
  const unit = UNITS.find(u=>u.id===selUnit)||UNITS[0];
  const kc = unit.phrases.filter((_,i)=>(progress.phrases||{})[`${unit.id}-${i}`]).length;

  // Preload audio for selected unit
  useEffect(() => {
    preloadUnitAudio(unit.phrases);
  }, [selUnit]);

  // Sort: unknown first
  const sorted = unit.phrases.map((p,i)=>({...p,origIdx:i,known:!!(progress.phrases||{})[`${unit.id}-${i}`]})).sort((a,b)=>a.known-b.known);

  const selectUnit = (id) => { setSelUnit(id); setTimeout(()=>{ if(phraseListRef.current) phraseListRef.current.scrollIntoView({behavior:"smooth"}); }, 80); };

  if (shadow !== null) return <ShadowMode unit={unit} progress={progress} upd={upd} settings={settings} onClose={()=>{releaseMicStream();setShadow(null);}} startIdx={shadow==="unit"?0:shadow} single={shadow!=="unit"} />;

  // Topic icons for visual picker
  const topicIcons = {1:"👋",2:"🤝",3:"🚕",4:"☕",5:"🍜",6:"🛍",7:"🏫",8:"🏠",9:"🕐",10:"❤️",11:"🍻",12:"🌧",13:"💰",14:"💪",15:"😤",16:"📱",17:"🥺",18:"🔢",19:"🎉",20:"🌇"};

  // Sort: incomplete first, completed at bottom
  const sortedUnits = [...UNITS].sort((a,b) => {
    const aDone = a.phrases.every((_,i)=>(progress.phrases||{})[`${a.id}-${i}`]);
    const bDone = b.phrases.every((_,i)=>(progress.phrases||{})[`${b.id}-${i}`]);
    if (aDone && !bDone) return 1;
    if (!aDone && bDone) return -1;
    return a.id - b.id;
  });

  return (
    <div className="mc">
      <div className="pt">Phrases</div>
      <div className="ps">Pick a topic to practice! Tap any one to start.</div>

      {/* Visual topic grid */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:24}}>
        {sortedUnits.map(u=>{
          const k=u.phrases.filter((_,i)=>(progress.phrases||{})[`${u.id}-${i}`]).length;
          const pct=Math.round(k/u.phrases.length*100);
          const isComplete=pct===100;
          const isActive=u.id===selUnit;
          return (
            <div key={u.id} onClick={()=>selectUnit(u.id)} style={{
              background:isComplete?"#F0F9E0":isActive?"#FAFFF0":"var(--wh)",
              borderRadius:12,padding:"14px 12px 10px",
              border:isActive?"2px solid var(--ld)":isComplete?"2px solid var(--ld)":"1px solid var(--st)",
              cursor:"pointer",transition:"all .15s",
              opacity:isComplete&&!isActive?0.75:1
            }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:"1.3rem"}}>{isComplete?"✅":(!isPremium&&!FREE_UNIT_IDS.includes(u.id))?"🔒":topicIcons[u.id]||"📖"}</span>
                <span style={{fontSize:".72rem",fontWeight:800,color:isComplete?"var(--ld)":"var(--ink3)"}}>{isComplete?"Complete!":(!isPremium&&!FREE_UNIT_IDS.includes(u.id))?"Premium":` ${k}/${u.phrases.length}`}</span>
              </div>
              <div style={{fontSize:".82rem",fontWeight:800,color:isComplete?"var(--ld)":"var(--ink)",lineHeight:1.2,marginBottom:5}}>{u.title}</div>
              <div style={{height:4,background:"var(--st)",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:isComplete?"var(--ld)":"var(--lime)",borderRadius:2,transition:"width .3s"}} /></div>
            </div>
          );
        })}
      </div>

      {/* Playlist view */}
      <div ref={phraseListRef} style={{marginTop:4}}>
        {/* Playlist Header */}
        <div className="playlist-header">
          <div style={{display:"flex",alignItems:"flex-start",gap:14}}>
            <button onClick={()=>setSelUnit(UNITS[0].id)} style={{background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.15)",borderRadius:999,width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0,color:"#fff",fontSize:".9rem"}}>&#8249;</button>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                <span style={{fontSize:"2.6rem",lineHeight:1}}>{topicIcons[unit.id]||"📖"}</span>
                <div>
                  <div style={{fontSize:"1.1rem",fontWeight:900,color:"#fff",lineHeight:1.2}}>{unit.title}</div>
                  <div style={{fontSize:".72rem",color:"rgba(255,255,255,.5)",marginTop:3,lineHeight:1.3}}>{unit.scene}</div>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:10}}>
                <span style={{fontSize:".68rem",fontWeight:700,color:"rgba(255,255,255,.45)"}}>{unit.phrases.length} phrases</span>
                <span style={{color:"rgba(255,255,255,.2)"}}>·</span>
                <span style={{fontSize:".68rem",fontWeight:700,color:"var(--lime)"}}>{kc} known</span>
                <span style={{color:"rgba(255,255,255,.2)"}}>·</span>
                <span style={{fontSize:".68rem",fontWeight:800,color:"var(--lime)"}}>{Math.round(kc/unit.phrases.length*100)}%</span>
              </div>
              <div style={{height:4,background:"rgba(255,255,255,.1)",borderRadius:2,overflow:"hidden",marginTop:8}}>
                <div style={{height:"100%",width:Math.round(kc/unit.phrases.length*100)+"%",background:"var(--lime)",borderRadius:2,transition:"width .4s ease"}} />
              </div>
            </div>
          </div>
        </div>

        {/* Sticky Action Bar */}
        <div className="action-bar" style={{background:"var(--cream)"}}>
          <button onClick={()=>setShadow("unit")} style={{width:48,height:48,borderRadius:"50%",background:"var(--lime)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.1rem",flexShrink:0,color:"var(--for)",fontWeight:900}}>&#9654;</button>
          <button className="action-pill" onClick={()=>setShadow("unit")}>🔀 Shuffle</button>
          <div style={{width:1,height:28,background:"var(--st)",flexShrink:0}} />
          <button className={"action-pill"+(readingMode?" on":"")} onClick={()=>setReadingMode(m=>!m)}>
            🔤 {readingMode?"Chinese first":"English first"}
          </button>
        </div>

        {/* Track List */}
        <div style={{paddingTop:8}}>
          {sorted.map((ph) => (
            <PhraseCard key={ph.origIdx} ph={ph} unit={unit} upd={upd} setShadow={setShadow} readingMode={readingMode} progress={progress} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- DING SOUND (reusable) ----
function playDing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1108, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch(e) {}
}

// ---- CONFETTI (reusable) ----
function Confetti({ count = 20 }) {
  const colors = ["#C4F000","#8F6AE8","#F05A3A","#7B9EE8","#FFD700","#FF69B4"];
  return (
    <div style={{position:"absolute",top:0,left:0,right:0,height:200,pointerEvents:"none",overflow:"hidden"}}>
      {Array.from({length:count}).map((_,i) => (
        <div key={i} style={{
          position:"absolute", top:-10, borderRadius:2,
          left: Math.random()*100+"%",
          animationDelay: Math.random()*0.5+"s",
          animationDuration: (1+Math.random())+"s",
          background: colors[i%6],
          width: (4+Math.random()*6)+"px",
          height: (4+Math.random()*6)+"px",
          animation: "confettiFall ease-out forwards"
        }}/>
      ))}
    </div>
  );
}

// ---- QUICK CHECK SHEET ----
function QuickCheckSheet({ phrase, phraseKey, progress, upd, onClose }) {
  const [step, setStep] = useState("prompt");
  const [revealed, setRevealed] = useState(false);
  const closeTimer = useRef(null);

  useEffect(() => {
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, []);

  const markMastered = useCallback(() => {
    upd("phrases." + phraseKey, true);
  }, [phraseKey, upd]);

  const goToCelebrate = useCallback(() => {
    markMastered();
    playDing();
    setStep("celebrate");
    closeTimer.current = setTimeout(() => { onClose(); }, 2200);
  }, [markMastered, onClose]);

  const goToEncourage = useCallback(() => {
    setStep("encourage");
    closeTimer.current = setTimeout(() => { onClose(); }, 1800);
  }, [onClose]);

  const romanization = phrase[LANG_CONFIG.romanizationKey];

  // Shared overlay style
  const overlayStyle = {position:"fixed",inset:0,zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"};

  if (step === "prompt") {
    return (
      <div style={{...overlayStyle,background:"rgba(0,0,0,.4)",animation:"bsOverIn .2s ease"}} onClick={onClose}>
        <div style={{background:"var(--wh)",borderRadius:"20px 20px 0 0",padding:"28px 20px 20px",width:"100%",maxWidth:500,animation:"bsSlideUp .25s ease"}} onClick={e=>e.stopPropagation()}>
          <div style={{width:40,height:4,background:"var(--st)",borderRadius:2,margin:"0 auto 20px"}} />
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:"2.4rem",marginBottom:8}}>🎉</div>
            <div style={{fontSize:"1.05rem",fontWeight:800,color:"var(--ink)",marginBottom:4}}>Nice! Let's make sure it sticks.</div>
            <div style={{fontSize:".82rem",color:"var(--ink3)",marginBottom:24}}>A quick check helps lock it into memory</div>
            <button onClick={()=>setStep("quiz")} style={{width:"100%",padding:"14px",borderRadius:12,border:"none",background:"var(--lime)",color:"var(--for)",fontSize:".88rem",fontWeight:800,cursor:"pointer",marginBottom:10,minHeight:48}}>Quiz me</button>
            <button onClick={()=>{goToCelebrate();}} style={{width:"100%",padding:"14px",borderRadius:12,border:"1.5px solid var(--st)",background:"none",color:"var(--ink3)",fontSize:".82rem",fontWeight:700,cursor:"pointer",minHeight:48}}>I'm sure, skip</button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "quiz") {
    return (
      <div style={{...overlayStyle,background:"rgba(0,0,0,.4)",animation:"bsOverIn .2s ease"}} onClick={onClose}>
        <div style={{background:"var(--wh)",borderRadius:"20px 20px 0 0",padding:"28px 20px 20px",width:"100%",maxWidth:500,animation:"bsSlideUp .25s ease"}} onClick={e=>e.stopPropagation()}>
          <div style={{width:40,height:4,background:"var(--st)",borderRadius:2,margin:"0 auto 20px"}} />
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:".68rem",fontWeight:800,color:"var(--ink3)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12}}>SAY THIS IN CHINESE:</div>
            <div style={{fontSize:"1.2rem",fontWeight:800,color:"var(--ink)",marginBottom:8}}>{phrase.en}</div>
            <div style={{fontSize:".75rem",color:"var(--ink3)",marginBottom:20}}>Try to say it out loud first!</div>
            {!revealed ? (
              <button onClick={()=>setRevealed(true)} style={{width:"100%",padding:"14px",borderRadius:12,border:"none",background:"var(--lime)",color:"var(--for)",fontSize:".88rem",fontWeight:800,cursor:"pointer",minHeight:48}}>Reveal answer</button>
            ) : (
              <div style={{animation:"fadeUp .3s ease"}}>
                <div style={{background:"var(--cream)",borderRadius:14,padding:"16px",marginBottom:16}}>
                  {romanization && <div style={{fontSize:".85rem",fontStyle:"italic",color:"var(--plum)",fontWeight:600,marginBottom:4}}><JyutpingTone text={romanization} /></div>}
                  <div style={{fontFamily:LANG_CONFIG.fontFamily,fontSize:"1.1rem",fontWeight:800,color:"var(--ink)"}}>{phrase.cn}</div>
                </div>
                <div style={{fontSize:".78rem",fontWeight:700,color:"var(--ink2)",marginBottom:12}}>Did you get it right?</div>
                <button onClick={goToCelebrate} style={{width:"100%",padding:"14px",borderRadius:12,border:"none",background:"var(--lime)",color:"var(--for)",fontSize:".88rem",fontWeight:800,cursor:"pointer",marginBottom:10,minHeight:48}}>Yes, I got it!</button>
                <button onClick={goToEncourage} style={{width:"100%",padding:"14px",borderRadius:12,border:"1.5px solid var(--st)",background:"none",color:"var(--ink3)",fontSize:".82rem",fontWeight:700,cursor:"pointer",minHeight:48}}>Not quite yet</button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (step === "celebrate") {
    return (
      <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(31,51,41,.88)",display:"flex",alignItems:"center",justifyContent:"center",animation:"bsOverIn .2s ease"}}>
        <Confetti count={20} />
        <div style={{textAlign:"center",padding:20}}>
          <div style={{fontSize:"3.2rem",animation:"celebPop .5s ease forwards"}}>🏆</div>
          <div style={{fontSize:"1.3rem",fontWeight:900,color:"#fff",marginTop:12,animation:"fadeUp .4s ease .2s both"}}>Mastered!</div>
          <div style={{fontSize:".82rem",color:"rgba(255,255,255,.6)",marginTop:6,animation:"fadeUp .4s ease .4s both"}}>Added to your trophy collection</div>
        </div>
      </div>
    );
  }

  if (step === "encourage") {
    return (
      <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(31,51,41,.88)",display:"flex",alignItems:"center",justifyContent:"center",animation:"bsOverIn .2s ease"}}>
        <div style={{textAlign:"center",padding:20}}>
          <div style={{fontSize:"3.2rem",animation:"celebPop .5s ease forwards"}}>💪</div>
          <div style={{fontSize:"1.3rem",fontWeight:900,color:"#fff",marginTop:12,animation:"fadeUp .4s ease .2s both"}}>Almost there!</div>
          <div style={{fontSize:".82rem",color:"rgba(255,255,255,.6)",marginTop:6,animation:"fadeUp .4s ease .4s both"}}>Keep practicing, you'll get it!</div>
        </div>
      </div>
    );
  }

  return null;
}

// ---- PHRASE CARD — Track-style with expand/collapse ----
function PhraseCard({ ph, unit, upd, setShadow, readingMode, progress }) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [quickCheck, setQuickCheck] = useState(false);

  const gloss = getAutoGloss(ph);
  const hasGloss = gloss.length > 0;

  return (
    <div className={"track" + (ph.known ? " known" : "")}>
      {/* Collapsed row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Play button */}
        <button className="track-play-btn" onClick={(e) => { e.stopPropagation(); speak(ph.cn); }}>&#9654;</button>

        {/* Text stack */}
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setExpanded(v => !v)}>
          {readingMode ? (
            <>
              <div style={{ fontSize: ".88rem", fontWeight: 700, color: "var(--ink)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ph.cn}</div>
              <div style={{ fontSize: ".75rem", fontStyle: "italic", color: "var(--plum)", lineHeight: 1.3 }}><JyutpingTone text={getRom(ph)} /></div>
              <div style={{ fontSize: ".72rem", color: "var(--ink3)", lineHeight: 1.3 }}>{ph.en}</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: ".85rem", fontWeight: 700, color: "var(--ink)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ph.en}</div>
              <div style={{ fontSize: ".75rem", fontStyle: "italic", color: "var(--plum)", lineHeight: 1.3 }}><JyutpingTone text={getRom(ph)} /></div>
              <div style={{ fontSize: ".82rem", color: "var(--ink3)", lineHeight: 1.3 }}>{ph.cn}</div>
            </>
          )}
        </div>

        {/* Know button */}
        <button className={"track-know-btn" + (ph.known ? " known" : "")} onClick={(e) => { e.stopPropagation(); ph.known ? upd(`phrases.${unit.id}-${ph.origIdx}`, false) : setQuickCheck(true); }}>
          {ph.known ? "Known!" : "I know this!"}
        </button>

        {/* Expand chevron */}
        <span className={"track-chevron" + (expanded ? " open" : "")} onClick={() => setExpanded(v => !v)}>&#9662;</span>
      </div>

      {/* Expanded content */}
      <div className={"track-expand" + (expanded ? " open" : "")}>
        <div style={{ paddingTop: 14 }}>
          {/* Context tag */}
          {ph.tag && (
            <div style={{ fontSize: ".72rem", fontStyle: "italic", color: "var(--ink3)", marginBottom: 10 }}>Context: {ph.tag}</div>
          )}

          {/* Word-by-word breakdown */}
          {hasGloss && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {gloss.filter(g => g.cn).map((g, i) => (
                <div key={i} className="gloss-chip" onClick={() => speak(g.cn)}>
                  <div style={{ fontSize: ".82rem", fontWeight: 700, color: "var(--ink)", lineHeight: 1.2 }}>{g.cn}</div>
                  <div style={{ fontSize: ".68rem", fontStyle: "italic", color: "var(--plum)", lineHeight: 1.2 }}><JyutpingTone text={g.jy} /></div>
                  {g.en && <div style={{ fontSize: ".62rem", fontWeight: 600, color: "var(--ink2)", lineHeight: 1.2, marginTop: 1 }}>{g.en}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Action buttons row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button style={{ background: "var(--st)", border: "none", borderRadius: 999, padding: "8px 14px", fontSize: ".72rem", fontWeight: 700, color: "var(--ink2)", cursor: "pointer", minHeight: 36, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => speak(ph.cn)}>&#9654; Play</button>
            <button style={{ background: "var(--st)", border: "none", borderRadius: 999, padding: "8px 14px", fontSize: ".72rem", fontWeight: 700, color: "var(--ink2)", cursor: "pointer", minHeight: 36, display: "inline-flex", alignItems: "center", gap: 4 }}>📚 Add to Library</button>
            <button style={{ background: "var(--for)", border: "none", borderRadius: 999, padding: "8px 14px", fontSize: ".72rem", fontWeight: 700, color: "var(--lime)", cursor: "pointer", minHeight: 36, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => setShadow(ph.origIdx)}>🎙 Shadow</button>
            {/* 3-dot menu */}
            <button onClick={() => setMenuOpen(true)} style={{ marginLeft: "auto", background: "none", border: "none", fontSize: "1.1rem", color: "var(--ink3)", cursor: "pointer", padding: "4px 8px", minHeight: 36, display: "inline-flex", alignItems: "center" }}>&#8943;</button>
          </div>
        </div>
      </div>

      {/* Bottom sheet menu */}
      {menuOpen && (
        <div className="bottom-sheet-overlay" onClick={() => setMenuOpen(false)}>
          <div className="bottom-sheet" onClick={e => e.stopPropagation()}>
            <div className="bottom-sheet-handle" />
            {/* Preview */}
            <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--st)" }}>
              <div style={{ fontSize: ".85rem", fontWeight: 700, color: "var(--ink)", marginBottom: 2 }}>{ph.en}</div>
              <div style={{ fontSize: ".75rem", fontStyle: "italic", color: "var(--plum)" }}><JyutpingTone text={getRom(ph)} /></div>
            </div>
            <button className="bottom-sheet-opt" onClick={() => { setMenuOpen(false); setShadow(ph.origIdx); }}>🎙 Shadow this phrase</button>
            <button className="bottom-sheet-opt" onClick={() => { setMenuOpen(false); ph.known ? upd(`phrases.${unit.id}-${ph.origIdx}`, false) : setQuickCheck(true); }}>
              {ph.known ? "↩ Unmark as known" : "✓ I know this"}
            </button>
            <button className="bottom-sheet-opt">📚 Add to Library</button>
            <button className="bottom-sheet-opt" onClick={() => setMenuOpen(false)} style={{ color: "var(--ink3)", justifyContent: "center" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Quick Check mastery flow */}
      {quickCheck && <QuickCheckSheet
        phrase={ph}
        phraseKey={`${unit.id}-${ph.origIdx}`}
        progress={progress}
        upd={upd}
        onClose={() => setQuickCheck(false)}
      />}
    </div>
  );
}

// ---- SHADOW MODE ----
function ShadowMode({ unit, progress, upd, settings, onClose, startIdx=0, single=false }) {
  const [idx, setIdx] = useState(startIdx);
  const [phase, setPhase] = useState("play");
  const [playing, setPlaying] = useState(true);
  const [showCn, setShowCn] = useState(true);
  const [peeking, setPeeking] = useState(false);
  const [speed, setSpeed] = useState(settings?.defaultSpeed || "normal");
  const [complete, setComplete] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [scoreResult, setScoreResult] = useState(null);
  const timer = useRef(null);
  const peekTimer = useRef(null);
  const knownN = useRef(0);

  // Eye toggle peek: auto-hide after 2.5s
  const doPeek = () => {
    setPeeking(true);
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeeking(false), 2500);
  };
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  const phrases = single ? [unit.phrases[startIdx]] : unit.phrases;

  // Preload all phrases for this shadow session
  useEffect(() => {
    preloadUnitAudio(phrases);
  }, []);
  const ph = phrases[single?0:idx];
  const realIdx = single ? startIdx : idx;
  const total = phrases.length;
  const isKn = (progress.phrases||{})[`${unit.id}-${realIdx}`];
  const gaps = { slow: [4000,4500], normal: [2800,3200], fast: [1500,1800] };

  const clear = () => { if(timer.current)clearTimeout(timer.current); };
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(()=>{
    if(!playing||complete)return; clear();
    let cancelled = false;
    async function playSequence() {
      if (phase === "play" && ph) {
        try { await speakPhrase(ph); } catch(e) {}
        if (cancelled || !playingRef.current) return;
        await new Promise(r => setTimeout(r, 600));
        if (cancelled || !playingRef.current) return;
        setPhase("shadow");
      } else if (phase === "shadow") {
        const [,shadowGap] = gaps[speed];
        timer.current = setTimeout(() => {
          if (single) { setPhase("play"); }
          else if (idx + 1 >= total) setComplete(true);
          else { setIdx(i => i + 1); setPhase("play"); }
        }, shadowGap);
      }
    }
    playSequence();
    return () => { cancelled = true; clear(); stopAudio(); };
  },[phase,playing,idx,complete,single,speed]);

  const markKn = () => { if(!isKn){knownN.current++;upd(`phrases.${unit.id}-${realIdx}`,true);} };

  // Pronunciation test: record, stop, score
  const startTest = async () => {
    setPlaying(false); // pause auto-advance
    stopAudio();
    const ok = await startRecording();
    if (ok) setIsRecording(true);
  };
  const stopTest = async () => {
    setIsRecording(false);
    setScoring(true);
    const blob = await stopRecording();
    if (blob && ph) {
      try {
        const result = await scorePronunciation(blob, ph.cn, LANG_CONFIG.id);
        // Build chars array from API response
        let chars = [];
        if (result.expectedJyutping && result.transcribedJyutping) {
          const expSyls = result.expectedJyutping.trim().split(/\s+/);
          const yourSyls = result.transcribedJyutping.trim().split(/\s+/);
          const cnChars = ph.cn.replace(/[，,。！？!?\s]/g, "").split("");
          for (let i = 0; i < Math.max(expSyls.length, cnChars.length); i++) {
            chars.push({
              cn: cnChars[i] || "",
              e: expSyls[i] || "",
              y: yourSyls[i] || "",
              m: expSyls[i] === yourSyls[i] ? 1 : 0
            });
          }
        }
        setScoreResult({ score: result.score, passed: result.passed, chars, phrase: ph });
      } catch(e) {
        console.error("Scoring error:", e);
        setScoreResult(null);
      }
    }
    setScoring(false);
  };

  if(complete) return (
    <div className="comp-ov">
      <div className="comp-em">🎉</div>
      <div className="comp-t">Session complete!</div>
      <div className="comp-s">Unit {unit.id}: {unit.title} · {knownN.current} marked known</div>
      <div style={{display:"flex",gap:8}}>
        <button className="comp-btn" style={{background:"rgba(255,255,255,.1)",color:"#fff"}} onClick={()=>{setIdx(0);setPhase("play");setComplete(false);setPlaying(true);knownN.current=0;}}>Again</button>
        <button className="comp-btn" onClick={onClose}>Done</button>
      </div>
    </div>
  );

  return (
    <div className="sho">
      {/* Header: close pill + unit name + eye toggle */}
      <div className="sh-hd">
        <button className="sh-cl" onClick={onClose}><span style={{fontSize:".8rem"}}>&#8249;</span> Close</button>
        <div style={{textAlign:"center",flex:1}}>
          <div style={{fontSize:".72rem",fontWeight:800,color:"rgba(255,255,255,.6)"}}>{unit.title}</div>
          <div style={{fontSize:".62rem",fontWeight:700,color:"rgba(255,255,255,.3)",marginTop:1}}>Phrase {(single?1:idx+1)} of {total}</div>
        </div>
        {/* Eye toggle */}
        <button onClick={()=>setShowCn(v=>!v)} style={{background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.12)",borderRadius:999,width:40,height:40,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"rgba(255,255,255,.5)",fontSize:"1.1rem"}}>
          {showCn ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>}
        </button>
      </div>
      {!single&&<div className="sh-bar"><div className="sh-bf" style={{width:((idx+1)/total*100)+"%"}} /></div>}

      {/* Hero phrase area */}
      <div className="sh-bd" style={{position:"relative"}}>
        {/* "I know this!" floats top-right */}
        <button onClick={markKn} style={{position:"absolute",top:12,right:12,background:isKn?"rgba(196,240,0,.08)":"rgba(196,240,0,.15)",border:isKn?"1.5px solid rgba(196,240,0,.15)":"1.5px solid rgba(196,240,0,.3)",borderRadius:999,padding:"8px 14px",fontSize:".72rem",fontWeight:800,color:isKn?"rgba(196,240,0,.4)":"var(--lime)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,minHeight:36}}>
          <span style={{fontSize:".9rem"}}>{isKn?"✓":"💪"}</span> {isKn?"Known":"I know this!"}
        </button>

        {/* Context line */}
        {ph.tag && <div className="sh-ctx">Context: {ph.tag}</div>}

        <div className="sh-en">{ph.en}</div>

        {/* Chinese + Jyutping with eye toggle */}
        {showCn ? (<>
          <div className="sh-jy"><JyutpingTone text={getRom(ph)} /></div>
          <div className="sh-cn">{ph.cn}</div>
        </>) : (
          <div className="sh-peek" onClick={doPeek}>
            {peeking ? (<>
              <div className="sh-jy" style={{marginBottom:4}}><JyutpingTone text={getRom(ph)} /></div>
              <div className="sh-cn" style={{marginBottom:0}}>{ph.cn}</div>
            </>) : (
              <div className="sh-peek-text">Tap to peek</div>
            )}
          </div>
        )}

        {/* Two-state cue — centered below phrase */}
        <div className={`cue-pill ${phase==="shadow"?"speak":"listen"}`}>
          <span className="cue-pill-emoji">{phase==="shadow"?"👄":"👂"}</span>
          <div className="cue-pill-dot" />
          <span className="cue-pill-text">{phase==="shadow"?"Repeat out loud":"Listen"}</span>
        </div>
      </div>

      {/* Controls area — thumb zone */}
      <div className="l-ctrl">
        {/* Transport: Replay / Pause / Next */}
        <div className="l-transport">
          {!single&&<div className="lt-wrap">
            <button className="lt-btn sec" disabled={idx===0} style={idx===0?{opacity:.3}:{}} onClick={()=>{if(idx>0){clear();setScoreResult(null);setIdx(i=>i-1);setPhase("play");}}}>⏮</button>
            <span className="lt-lbl">Back</span>
          </div>}
          <div className="lt-wrap">
            <button className="lt-btn sec" onClick={()=>{clear();setPhase("play");}}>↻</button>
            <span className="lt-lbl">Replay</span>
          </div>
          <div className="lt-wrap">
            <button className="lt-btn pri" onClick={()=>setPlaying(p=>!p)}>{playing?"⏸":"▶"}</button>
            <span className="lt-lbl">{playing?"Pause":"Play"}</span>
          </div>
          {!single&&<div className="lt-wrap">
            <button className="lt-btn sec" onClick={()=>{clear();setScoreResult(null);if(idx+1>=total)setComplete(true);else{setIdx(i=>i+1);setPhase("play");}}}>⏭</button>
            <span className="lt-lbl">Next</span>
          </div>}
        </div>

        <div className="l-divider" />

        {/* Speed row — pause between phrases */}
        <div className="l-speed">
          <div className="l-row-label">Pause between phrases</div>
          <div className="l-pill-row">
            {[{k:"slow",l:"Longer pause"},{k:"normal",l:"Normal"},{k:"fast",l:"Shorter pause"}].map(s=>
              <button key={s.k} className={`l-pill-btn ${speed===s.k?"on":""}`} onClick={()=>setSpeed(s.k)}>{s.l}</button>
            )}
          </div>
        </div>
      </div>

      {/* Pronunciation score overlay */}
      {scoreResult && <PronunciationScore
        score={scoreResult.score}
        chars={scoreResult.chars}
        phrase={scoreResult.phrase}
        onRetry={() => { setScoreResult(null); startTest(); }}
        onNext={() => { setScoreResult(null); if(!single && idx+1<total){setIdx(i=>i+1);setPhase("play");setPlaying(true);}else{setPhase("play");setPlaying(true);} }}
        onClose={() => { setScoreResult(null); setPlaying(true); }}
      />}
    </div>
  );
}

// ---- VOCAB ----
function VocabTab({ progress, upd, startPlaylist }) {
  const [tier, setTier] = useState(1);
  const [openCat, setOpenCat] = useState(null);
  const [speed, setSpeed] = useState("normal");
  const vk = Object.keys(progress.vocab||{}).filter(k=>progress.vocab[k]).length;
  const catsForTier = VOCAB_CATS.filter(c=>c.tier===tier);

  const playCategory = (cat) => {
    const items = cat.words.map(w => ({ en: w.en, cn: w.cn, jyut: w.jyut }));
    startPlaylist(items, cat.label);
  };

  const playTier = (t) => {
    const items = VOCAB_CATS.filter(c=>c.tier===t).flatMap(c=>c.words.map(w=>({en:w.en,cn:w.cn,jyut:w.jyut})));
    startPlaylist(items, `Tier ${t} vocabulary`);
  };

  return (
    <div className="mc">
      <div className="pt">Vocabulary Bank 📖</div>
      <div className="ps">{vk} of {ALL_WORDS.length} words known. Every word unlocks new sentences!</div>

      {TIER_META.map(tm=>{
        const tw=ALL_WORDS.filter(w=>w.tier===tm.t);const kn=tw.filter(w=>(progress.vocab||{})[w.jyut]).length;const pct=tw.length?Math.round(kn/tw.length*100):0;
        return <div key={tm.t} className="tc"><div className="tc-h"><span className="tc-l">Tier {tm.t}: {tm.label}</span><span className="tc-c">{kn}/{tw.length}</span></div><div className="tc-bar"><div className="tc-bf" style={{width:pct+"%",background:tm.color}} /></div></div>;
      })}

      <div className="tt">{TIER_META.map(tm=><button key={tm.t} className={`ttb ${tier===tm.t?"on":""}`} onClick={()=>{setTier(tm.t);setOpenCat(null)}}><div className="ttb-l">Tier {tm.t}</div><div className="ttb-s">{tm.label}</div></button>)}</div>

      <button style={{width:"100%",background:"var(--for)",color:"var(--lime)",border:"none",borderRadius:999,padding:"8px 14px",fontSize:".66rem",fontWeight:800,cursor:"pointer",marginBottom:8}} onClick={()=>playTier(tier)}>🎧 Listen to all Tier {tier} words</button>

      {catsForTier.map(cat => {
        const isOpen = openCat === cat.id;
        const words = cat.words.slice().sort((a,b)=>{const ak=(progress.vocab||{})[a.jyut]?1:0;const bk=(progress.vocab||{})[b.jyut]?1:0;return ak-bk;});
        const kn = words.filter(w=>(progress.vocab||{})[w.jyut]).length;
        return (
          <div key={cat.id} className="acc">
            <div className={`acc-hd ${isOpen?"open":""}`} onClick={()=>setOpenCat(isOpen?null:cat.id)}>
              <div><span className="acc-ti">{cat.label}</span></div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <button style={{background:"var(--for)",color:"var(--lime)",border:"none",borderRadius:999,padding:"10px 16px",fontSize:".72rem",fontWeight:800,cursor:"pointer",minHeight:44,minWidth:44,display:"flex",alignItems:"center",gap:4}} onClick={e=>{e.stopPropagation();playCategory(cat)}}>▶ Listen</button>
                <span className="acc-ct">{kn}/{words.length}</span>
                <span className={`acc-chv ${isOpen?"open":""}`}>▼</span>
              </div>
            </div>
            {isOpen && (
              <div className="acc-bd">
                <div className="wg">
                  {words.map((w,i)=>{
                    const ik=(progress.vocab||{})[w.jyut];
                    return <div key={i} className={`wc ${ik?"kn":""}`}>
                      <div className="wc-en">{w.en}</div>
                      <div className="wc-jy">{w.jyut}</div>
                      <div className="wc-cn">{w.cn}</div>
                      <div className="wc-ft">
                        <div style={{display:"flex",alignItems:"center",gap:4}}>
                          <button className="wc-pl" onClick={()=>speak(w.cn)}>▶</button>
                          <button className="wc-pl" style={{width:"auto",borderRadius:999,padding:"10px 14px",fontSize:".65rem",fontWeight:700,minHeight:44}} onClick={()=>{speak(w.cn);setTimeout(()=>speak(w.cn),2000);setTimeout(()=>speak(w.cn),4000)}}>▶▶▶</button>
                        </div>
                        <button className={`wc-ik ${ik?"kn":"un"}`} onClick={()=>upd(`vocab.${w.jyut}`,!ik)}>{ik?"✓":"I know this!"}</button>
                      </div>
                    </div>;
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- UNIT 10 (Unified Phrasebook) ----
function Unit10Tab({ progress, upd }) {
  const [en, setEn] = useState("");
  const [jy, setJy] = useState("");
  const [cn, setCn] = useState("");
  const [tag, setTag] = useState("");
  const [saved, setSaved] = useState(false);
  const items = progress.unit10 || [];

  const handleSave = () => {
    if (!en.trim()) return;
    const ns = { en: en.trim(), jyut: jy.trim()||"(add jyutping)", cn: cn.trim()||"(add characters)", tag: tag.trim()||"Life", date: new Date().toLocaleDateString("en-GB",{weekday:"short"}), known: false };
    upd("unit10", [ns, ...items]);
    setEn(""); setJy(""); setCn(""); setTag(""); setSaved(true);
    setTimeout(()=>setSaved(false),2000);
  };

  const toggleKnown = (idx) => {
    const updated = items.map((s,i) => i===idx ? {...s, known: !s.known} : s);
    upd("unit10", updated);
  };

  const stillLearning = items.filter(s => !s.known);
  const learned = items.filter(s => s.known);

  return (
    <div className="mc">
      <div className="pt">📖 My Phrasebook</div>
      <div className="ps">Your personal collection. Unknown words get drilled as top priority in every lesson!</div>

      <div style={{background:"var(--wh)",borderRadius:14,padding:16,border:"1.5px solid var(--st)",marginBottom:16}}>
        <div style={{fontSize:".88rem",fontWeight:800,color:"var(--ink)",marginBottom:10}}>What did you need to say today?</div>
        <input style={{width:"100%",background:"var(--cream)",border:"1.5px solid var(--st)",borderRadius:8,padding:"10px 12px",fontSize:".82rem",color:"var(--ink)",outline:"none",fontFamily:"inherit",marginBottom:6,minHeight:44}} placeholder="English, e.g. Can you wrap that separately?" value={en} onChange={e=>setEn(e.target.value)} />
        <input style={{width:"100%",background:"var(--cream)",border:"1.5px solid var(--st)",borderRadius:8,padding:"10px 12px",fontSize:".82rem",color:"var(--plum)",fontStyle:"italic",outline:"none",fontFamily:"inherit",marginBottom:6,minHeight:44}} placeholder="Jyutping, e.g. ho2 m4 ho2 ji5 fan1 hoi1 baau1" value={jy} onChange={e=>setJy(e.target.value)} />
        <input style={{width:"100%",background:"var(--cream)",border:"1.5px solid var(--st)",borderRadius:8,padding:"10px 12px",fontSize:".82rem",color:"var(--ink)",outline:"none",fontFamily:"${LANG_CONFIG.fontFamily.replace(/'/g, '')},sans-serif",marginBottom:6,minHeight:44}} placeholder="Chinese characters, e.g. 可唔可以分開包" value={cn} onChange={e=>setCn(e.target.value)} />
        <div style={{display:"flex",gap:6,marginBottom:6}}>
          <input style={{flex:1,background:"var(--cream)",border:"1.5px solid var(--st)",borderRadius:8,padding:"10px 12px",fontSize:".82rem",color:"var(--ink)",outline:"none",fontFamily:"inherit",minHeight:44}} placeholder="Where? e.g. Wet market" value={tag} onChange={e=>setTag(e.target.value)} />
          <button style={{background:"var(--lime)",color:"var(--for)",border:"none",borderRadius:8,padding:"10px 18px",fontSize:".82rem",fontWeight:900,cursor:"pointer",minHeight:44}} onClick={handleSave}>Save →</button>
        </div>
        <div style={{fontSize:".72rem",color:"var(--ink3)",lineHeight:1.5,marginTop:4}}>
          {saved ? <span style={{color:"var(--ld)",fontWeight:700}}>✓ Saved!</span> : <>
            Look up Jyutping & characters at: <a href="https://cc-canto.org" target="_blank" rel="noopener" style={{color:"var(--plum)",textDecoration:"none",fontWeight:700}}>cc-canto.org</a> or <a href="https://words.hk" target="_blank" rel="noopener" style={{color:"var(--plum)",textDecoration:"none",fontWeight:700}}>words.hk</a>
            <br/>💡 You can also ask Claude or ChatGPT: "How do you say ___ in Cantonese?"
          </>}
        </div>
      </div>

      {/* Still learning section */}
      {stillLearning.length > 0 && (<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <span style={{fontSize:".82rem",fontWeight:900,color:"var(--ink)"}}>🔄 Still learning</span>
          <span style={{fontSize:".72rem",color:"var(--ink3)"}}>{stillLearning.length} phrase{stillLearning.length>1?"s":""}</span>
        </div>
        {stillLearning.map((s,si)=>{
          const idx = items.indexOf(s);
          return (
            <div key={idx} className="card" style={{borderLeft:"3px solid var(--lime)"}}>
              <div className="ph-en">{s.en}</div>
              <div className="ph-jy">{s.jyut}</div>
              <div className="ph-cn">{s.cn}</div>
              <div className="ph-ft">
                {s.cn && s.cn !== "(add characters)" && <button className="pbtn play-btn" onClick={()=>speak(s.cn)}>▶</button>}
                <span className="tg">{s.tag}</span>
                <button style={{marginLeft:"auto",background:"var(--lime)",color:"var(--for)",border:"none",borderRadius:999,padding:"6px 14px",fontSize:".72rem",fontWeight:900,cursor:"pointer",minHeight:36}} onClick={()=>toggleKnown(idx)}>I know this ✓</button>
              </div>
            </div>
          );
        })}
      </>)}

      {/* Learned section */}
      {learned.length > 0 && (<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,marginTop:stillLearning.length>0?16:0}}>
          <span style={{fontSize:".82rem",fontWeight:900,color:"var(--ink3)"}}>✓ Learned</span>
          <span style={{fontSize:".72rem",color:"var(--ink3)"}}>{learned.length} phrase{learned.length>1?"s":""}</span>
        </div>
        {learned.map((s,si)=>{
          const idx = items.indexOf(s);
          return (
            <div key={idx} className="card" style={{opacity:.6}}>
              <div className="ph-en">{s.en}</div>
              <div className="ph-jy">{s.jyut}</div>
              <div className="ph-cn">{s.cn}</div>
              <div className="ph-ft">
                {s.cn && s.cn !== "(add characters)" && <button className="pbtn play-btn" onClick={()=>speak(s.cn)}>▶</button>}
                <span className="tg">{s.tag}</span>
                <button style={{marginLeft:"auto",background:"var(--st)",color:"var(--ink2)",border:"none",borderRadius:999,padding:"6px 14px",fontSize:".72rem",fontWeight:700,cursor:"pointer",minHeight:36}} onClick={()=>toggleKnown(idx)}>Relearn</button>
              </div>
            </div>
          );
        })}
      </>)}

      {items.length===0&&<div style={{textAlign:"center",padding:28,color:"var(--ink3)",fontSize:".72rem",lineHeight:1.6}}>No sentences yet! This is your personal phrasebook. Add phrases you need in daily life — they'll become your top priority in lessons. 🌱</div>}
    </div>
  );
}

// ---- PLAYLIST BUILDER ----
function PlaylistBuilder({ onClose, onPlay, progress }) {
  const [selUnits, setSelUnits] = useState(new Set());
  const [selPhrases, setSelPhrases] = useState(new Set());
  const [selLife, setSelLife] = useState(new Set());
  const [selAllLife, setSelAllLife] = useState(false);
  const [selVocabCats, setSelVocabCats] = useState(new Set());
  const [expanded, setExpanded] = useState(null);

  const lifeItems = (progress?.unit10 || []).filter(s => s.cn && s.cn !== "(add characters)");

  const toggleUnit = (uid) => {
    const next = new Set(selUnits);
    if (next.has(uid)) {
      next.delete(uid);
      const nextP = new Set(selPhrases);
      UNITS.find(u=>u.id===uid)?.phrases.forEach((_,i)=>nextP.delete(`${uid}-${i}`));
      setSelPhrases(nextP);
    } else {
      next.add(uid);
    }
    setSelUnits(next);
  };

  const togglePhrase = (uid, idx) => {
    const key = `${uid}-${idx}`;
    const next = new Set(selPhrases);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelPhrases(next);
  };

  const toggleAllLife = () => {
    if (selAllLife) { setSelAllLife(false); setSelLife(new Set()); }
    else { setSelAllLife(true); setSelLife(new Set(lifeItems.map((_,i)=>i))); }
  };

  const toggleLifeItem = (idx) => {
    const next = new Set(selLife);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setSelLife(next);
    setSelAllLife(next.size === lifeItems.length);
  };

  const getSelectedItems = () => {
    const items = [];
    UNITS.forEach(u => {
      u.phrases.forEach((p, i) => {
        const key = `${u.id}-${i}`;
        if (selUnits.has(u.id) || selPhrases.has(key)) {
          items.push({ ...p, unitId: u.id, unitTitle: u.title });
        }
      });
    });
    // Life sentences
    lifeItems.forEach((s, i) => {
      if (selAllLife || selLife.has(i)) {
        items.push({ en: s.en, jyut: s.jyut, cn: s.cn, tag: s.tag, unitId: 11, unitTitle: "Life Sentences" });
      }
    });
    // Vocab categories
    VOCAB_CATS.forEach(cat => {
      if (selVocabCats.has(cat.id)) {
        cat.words.forEach(w => items.push({ en: w.en, cn: w.cn, jyut: w.jyut, tag: cat.label }));
      }
    });
    return items;
  };

  const count = getSelectedItems().length;

  return (
    <div className="plb-ov">
      <div className="plb-hd">
        <button className="plb-cl" onClick={onClose}>✕ Cancel</button>
        <div className="plb-ti">Build Playlist</div>
        <button className="plb-play" disabled={count===0} onClick={()=>onPlay(getSelectedItems(),"My playlist")}>
          ▶ Play {count}
        </button>
      </div>

      <div className="plb-body">
        <div className="plb-sec">Fixed units</div>
        {UNITS.map(u => {
          const isSel = selUnits.has(u.id);
          return (
            <div key={u.id}>
              <div className={`plb-unit ${isSel?"sel":""}`} onClick={()=>toggleUnit(u.id)}>
                <div className="plb-chk">{isSel?"✓":""}</div>
                <div className="plb-nm">Unit {u.id}: {u.title}</div>
                <div className="plb-ct">{u.phrases.length}</div>
                <button style={{background:"none",border:"none",color:"var(--ink3)",fontSize:10,cursor:"pointer",padding:4}} onClick={e=>{e.stopPropagation();setExpanded(expanded===u.id?null:u.id)}}>
                  {expanded===u.id?"▲":"▼"}
                </button>
              </div>
              {expanded===u.id && (
                <div style={{paddingLeft:8,paddingBottom:4}}>
                  {u.phrases.map((p,i)=>{
                    const key=`${u.id}-${i}`;
                    const pSel = selUnits.has(u.id) || selPhrases.has(key);
                    return (
                      <div key={i} className={`plb-phrase ${pSel?"sel":""}`} onClick={()=>togglePhrase(u.id,i)}>
                        <div className="plb-ph-chk">{pSel?"✓":""}</div>
                        <div className="plb-ph-en">{p.en}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Life Sentences */}
        {lifeItems.length > 0 && (
          <>
            <div className="plb-sec">Your life sentences</div>
            <div className={`plb-unit ${selAllLife?"sel":""}`} onClick={toggleAllLife}>
              <div className="plb-chk">{selAllLife?"✓":""}</div>
              <div className="plb-nm">Life Sentences</div>
              <div className="plb-ct">{lifeItems.length}</div>
              <button style={{background:"none",border:"none",color:"var(--ink3)",fontSize:10,cursor:"pointer",padding:4}} onClick={e=>{e.stopPropagation();setExpanded(expanded==="life"?null:"life")}}>
                {expanded==="life"?"▲":"▼"}
              </button>
            </div>
            {expanded==="life" && (
              <div style={{paddingLeft:8,paddingBottom:4}}>
                {lifeItems.map((s,i)=>{
                  const isSel = selAllLife || selLife.has(i);
                  return (
                    <div key={i} className={`plb-phrase ${isSel?"sel":""}`} onClick={()=>toggleLifeItem(i)}>
                      <div className="plb-ph-chk">{isSel?"✓":""}</div>
                      <div className="plb-ph-en">{s.en}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Vocabulary categories */}
        <div className="plb-sec">Vocabulary categories</div>
        {VOCAB_CATS.map(cat => {
          const isSel = selVocabCats.has(cat.id);
          return (
            <div key={cat.id} className={`plb-unit ${isSel?"sel":""}`} onClick={()=>{
              const next = new Set(selVocabCats);
              if (next.has(cat.id)) next.delete(cat.id); else next.add(cat.id);
              setSelVocabCats(next);
            }}>
              <div className="plb-chk">{isSel?"✓":""}</div>
              <div className="plb-nm">{cat.label}</div>
              <div className="plb-ct">{cat.words.length} words</div>
            </div>
          );
        })}
      </div>

      <div className="plb-summary">
        <div className="plb-sum-txt"><span className="plb-sum-n">{count}</span> phrases selected</div>
        <button className="plb-play" disabled={count===0} onClick={()=>onPlay(getSelectedItems(),"My playlist")}>▶ Play</button>
      </div>
    </div>
  );
}

// ---- PRONUNCIATION SCORE CARD ----
function PronunciationScore({ score, chars, phrase, onRetry, onNext, onClose }) {
  const [animDone, setAnimDone] = useState(false);
  const type = score >= 90 ? "perfect" : score >= 70 ? "good" : "try-again";
  const label = score >= 90 ? "Perfect pronunciation!" : score >= 70 ? "Good effort! Almost there." : "Keep practicing! You got this.";
  const circ = 2 * Math.PI * 58;
  const offset = circ - (score / 100) * circ;

  useEffect(() => {
    const t = setTimeout(() => {
      setAnimDone(true);
      playScoreSound(type);
    }, 700);
    return () => clearTimeout(t);
  }, []);

  const chunk = (a, n) => { const r=[]; for(let i=0;i<a.length;i+=n) r.push(a.slice(i,i+n)); return r; };
  const chunks = chunk(chars || [], 5);

  return (
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.6)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{width:"100%",maxWidth:420,background:"var(--wh)",borderRadius:24,overflow:"hidden",boxShadow:"0 8px 40px rgba(0,0,0,.15)"}}>
        <div style={{padding:"24px 20px 18px",textAlign:"center",position:"relative",overflow:"hidden",
          background:type==="perfect"?"var(--for)":type==="good"?"#1a3a2a":"#3a2020"}}>
          <div style={{width:110,height:110,margin:"0 auto 10px",position:"relative"}}>
            <svg viewBox="0 0 140 140" style={{width:"100%",height:"100%"}}>
              <circle cx="70" cy="70" r="58" fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="8" />
              <circle cx="70" cy="70" r="58" fill="none" strokeWidth="8" strokeLinecap="round"
                stroke={type==="perfect"?"var(--lime)":type==="good"?"#7AAA00":"var(--cor)"}
                strokeDasharray={circ} strokeDashoffset={animDone?offset:circ}
                style={{transform:"rotate(-90deg)",transformOrigin:"center",transition:"stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)"}} />
            </svg>
            <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",fontSize:"1.8rem",fontWeight:900,color:"#fff"}}>
              {score}<span style={{fontSize:".75rem",fontWeight:600,opacity:.5}}>%</span>
            </div>
          </div>
          <div style={{display:"inline-block",fontSize:".75rem",fontWeight:800,padding:"6px 16px",borderRadius:999,
            background:type==="perfect"?"rgba(196,240,0,.15)":type==="good"?"rgba(122,170,0,.15)":"rgba(240,90,58,.15)",
            color:type==="perfect"?"var(--lime)":type==="good"?"#9dcc33":"#ff7a5c",
            opacity:animDone?1:0,transform:animDone?"translateY(0)":"translateY(10px)",transition:"all .3s"}}>{label}</div>
        </div>

        <div style={{padding:"16px 20px 8px"}}>
          <div style={{fontFamily:"${LANG_CONFIG.fontFamily.replace(/'/g, '')}",fontSize:"1.3rem",fontWeight:900,color:"var(--ink)",marginBottom:2}}>{phrase?.cn}</div>
          <div style={{fontSize:".75rem",color:"var(--plum)",fontWeight:600,fontStyle:"italic",marginBottom:2}}>{phrase?.jyut || phrase?.jy}</div>
          <div style={{fontSize:".7rem",color:"var(--ink3)",marginBottom:12}}>{phrase?.en}</div>

          {chars && chars.length > 0 && <>
            <div style={{fontSize:".55rem",fontWeight:700,color:"var(--ink3)",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Your pronunciation <span style={{fontWeight:500,textTransform:"none",letterSpacing:0}}>(tap to hear)</span></div>
            {chunks.map((ch, ci) => (
              <div key={ci} style={{marginBottom:8}}>
                <div style={{display:"flex",gap:2}}>
                  <div style={{width:28}}></div>
                  {ch.map((c,i) => <div key={i} style={{flex:1,textAlign:"center",fontFamily:"${LANG_CONFIG.fontFamily.replace(/'/g, '')}",fontSize:"1.1rem",fontWeight:900,color:"var(--ink)",cursor:"pointer",padding:"2px 0"}} onClick={()=>googleTTS(c.cn,"yue-HK")}>{c.cn}</div>)}
                </div>
                <div style={{display:"flex",gap:2,marginTop:2}}>
                  <div style={{width:28,fontSize:".42rem",fontWeight:700,color:"var(--ink3)",display:"flex",alignItems:"center"}}>EXP</div>
                  {ch.map((c,i) => <div key={i} style={{flex:1,textAlign:"center"}}><span style={{display:"inline-block",fontSize:".58rem",fontWeight:700,padding:"3px 5px",borderRadius:6,background:"rgba(143,106,232,.08)",color:"var(--plum)",cursor:"pointer"}} onClick={()=>googleTTS(c.cn,"yue-HK")}>{c.expected || c.e}</span></div>)}
                </div>
                <div style={{display:"flex",gap:2,marginTop:2}}>
                  <div style={{width:28,fontSize:".42rem",fontWeight:700,color:"var(--ink3)",display:"flex",alignItems:"center"}}>YOU</div>
                  {ch.map((c,i) => {
                    const match = c.match || c.m;
                    return <div key={i} style={{flex:1,textAlign:"center"}}><span style={{display:"inline-block",fontSize:".58rem",fontWeight:700,padding:"3px 5px",borderRadius:6,cursor:"pointer",
                      background:match?"rgba(196,240,0,.12)":"rgba(240,90,58,.1)",
                      color:match?"var(--ld)":"var(--cor)",
                      border:match?"1.5px solid rgba(196,240,0,.3)":"1.5px solid rgba(240,90,58,.25)"
                    }} onClick={()=>googleTTS(c.cn,"yue-HK")}>{c.yours || c.y}</span></div>;
                  })}
                </div>
                <div style={{display:"flex",gap:2,marginTop:2}}>
                  <div style={{width:28}}></div>
                  {ch.map((c,i) => <div key={i} style={{flex:1,textAlign:"center",fontSize:".55rem"}}>{(c.match||c.m)?"✅":"❌"}</div>)}
                </div>
              </div>
            ))}
          </>}
        </div>

        <div style={{padding:"0 20px 20px",display:"flex",gap:8}}>
          <button style={{flex:1,padding:12,borderRadius:14,border:"none",background:"var(--st)",color:"var(--ink)",fontSize:".78rem",fontWeight:800,cursor:"pointer"}} onClick={onRetry}>🔄 Try again</button>
          <button style={{flex:1,padding:12,borderRadius:14,border:"none",background:"var(--for)",color:"var(--lime)",fontSize:".78rem",fontWeight:800,cursor:"pointer"}} onClick={score>=70?onNext:onClose}>{score>=70?"→ Next phrase":"👂 Listen again"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- VOICE ONBOARDING (first-time only) ----
function VoiceOnboarding({ onComplete }) {
  const [selectedEn, setSelectedEn] = useState(DEFAULT_EN_VOICE);
  const [selectedCn, setSelectedCn] = useState(DEFAULT_CN_VOICE);
  const [step, setStep] = useState(1); // 1 = English, 2 = Cantonese
  const [playing, setPlaying] = useState(null);

  const previewEnVoice = async (voiceId) => {
    setPlaying(voiceId);
    try {
      stopAudio();
      const orig = _activeEnVoiceId;
      _activeEnVoiceId = voiceId;
      await elevenLabsTTS("Hello! I'll be your English voice throughout your Cantonese learning journey.", "en");
      _activeEnVoiceId = orig;
    } catch(e) { console.warn("Preview failed:", e); }
    setPlaying(null);
  };

  const previewCnVoice = async (voiceId) => {
    setPlaying(voiceId);
    try {
      stopAudio();
      const orig = _activeCnVoiceId;
      _activeCnVoiceId = voiceId;
      await cantoneseAiTTS("你好！我會陪你一齊學廣東話。");
      _activeCnVoiceId = orig;
    } catch(e) { console.warn("Preview failed:", e); }
    setPlaying(null);
  };

  const voices = step === 1 ? EN_VOICES : CN_VOICES;
  const selected = step === 1 ? selectedEn : selectedCn;
  const setSelected = step === 1 ? setSelectedEn : setSelectedCn;
  const previewFn = step === 1 ? previewEnVoice : previewCnVoice;

  return (
    <div className="ca" style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"100vh",padding:24}}>
      <div style={{maxWidth:400,width:"100%"}}>
        <div style={{fontSize:"2rem",marginBottom:8}}>{step===1?"🎧":"🗣"}</div>
        <div style={{fontSize:"1.3rem",fontWeight:900,color:"var(--ink)",marginBottom:6}}>{step===1?"Choose your English voice":"Choose your Cantonese voice"}</div>
        <div style={{fontSize:".78rem",color:"var(--ink2)",lineHeight:1.5,marginBottom:24}}>{step===1?"This voice will speak English translations and instructions.":"This voice will speak Cantonese phrases."} You can change this later in Settings.</div>

        <div style={{display:"flex",gap:6,marginBottom:16}}>
          <div style={{flex:1,height:3,borderRadius:2,background:"var(--lime)"}}></div>
          <div style={{flex:1,height:3,borderRadius:2,background:step===2?"var(--lime)":"var(--st)"}}></div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:28}}>
          {voices.map(v => (
            <div key={v.id} onClick={()=>setSelected(v.id)} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:14,border:selected===v.id?"2px solid var(--lime)":"1.5px solid var(--st)",background:selected===v.id?"rgba(196,240,0,.08)":"var(--wh)",cursor:"pointer",transition:"all .15s"}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:selected===v.id?"var(--lime)":"var(--st)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".9rem",flexShrink:0}}>{v.gender==="female"?"👩":"👨"}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:".82rem",fontWeight:700,color:"var(--ink)"}}>{v.label}</div>
                {v.accent && <div style={{fontSize:".65rem",color:"var(--ink3)"}}>{v.accent} accent</div>}
              </div>
              <button onClick={(e)=>{e.stopPropagation();previewFn(v.id);}} style={{background:"var(--for)",color:"var(--lime)",border:"none",borderRadius:999,padding:"8px 14px",fontSize:".68rem",fontWeight:700,cursor:"pointer"}}>{playing===v.id?"...":"▶ Preview"}</button>
            </div>
          ))}
        </div>

        {step === 1 ? (
          <button onClick={()=>setStep(2)} style={{width:"100%",padding:"16px",borderRadius:14,border:"none",background:"var(--lime)",color:"var(--for)",fontSize:".9rem",fontWeight:800,cursor:"pointer"}}>Next →</button>
        ) : (
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setStep(1)} style={{flex:1,padding:"16px",borderRadius:14,border:"1.5px solid var(--st)",background:"var(--wh)",color:"var(--ink)",fontSize:".9rem",fontWeight:800,cursor:"pointer"}}>← Back</button>
            <button onClick={()=>onComplete(selectedEn, selectedCn)} style={{flex:2,padding:"16px",borderRadius:14,border:"none",background:"var(--lime)",color:"var(--for)",fontSize:".9rem",fontWeight:800,cursor:"pointer"}}>Continue →</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- SETTINGS (redesigned) ----
function SettingsTab({ settings, updSettings, isPremium, setShowPremiumGate }) {
  const [playing, setPlaying] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dlState, setDlState] = useState(() => localStorage.getItem(LANG_CONFIG.audioDownloadedKey) === "true" ? "done" : "idle");
  const [dlProgress, setDlProgress] = useState({ done: 0, total: 0 });

  const downloadOfflineAudio = async () => {
    setDlState("loading");
    try {
      const manifest = await loadAudioManifest();
      if (!manifest) { setDlState("error"); return; }
      const urls = [];
      for (const app of Object.values(manifest)) {
        for (const lang of Object.values(app)) {
          for (const path of Object.values(lang)) {
            urls.push(path);
          }
        }
      }
      setDlProgress({ done: 0, total: urls.length });
      const batchSize = 20;
      let done = 0;
      for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        if (navigator.serviceWorker?.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "precache-audio", urls: batch });
        }
        await new Promise(r => setTimeout(r, 500));
        done += batch.length;
        setDlProgress({ done: Math.min(done, urls.length), total: urls.length });
      }
      localStorage.setItem(LANG_CONFIG.audioDownloadedKey, "true");
      setDlState("done");
    } catch(e) {
      console.warn("Offline download failed:", e);
      setDlState("error");
    }
  };

  const previewEnVoice = async (voiceId) => {
    setPlaying(voiceId);
    try {
      const orig = _activeEnVoiceId;
      _activeEnVoiceId = voiceId;
      await elevenLabsTTS("Hello! This is what I sound like.", "en");
      _activeEnVoiceId = orig;
    } catch(e) {}
    setPlaying(null);
  };

  const previewCnVoice = async (voiceId) => {
    setPlaying(voiceId);
    try {
      const orig = _activeCnVoiceId;
      _activeCnVoiceId = voiceId;
      await cantoneseAiTTS("你好！我係你嘅廣東話老師。");
      _activeCnVoiceId = orig;
    } catch(e) {}
    setPlaying(null);
  };
  return (
    <div className="mc">
      <div className="pt">Settings</div>

      {/* Learning focus */}
      <div className="set-card">
        <div className="set-lb">Learning focus</div>
        <div style={{fontSize:".68rem",color:"var(--ink2)",lineHeight:1.5,marginBottom:10}}>Speaking mode shows jyutping large for pronunciation practice. Reading mode shows Chinese characters large for character recognition.</div>
        <div style={{display:"flex",gap:8}}>
          <button style={{flex:1,padding:"12px 10px",borderRadius:12,border:settings.learnMode!=="reading"?"2px solid var(--lime)":"1.5px solid var(--st)",background:settings.learnMode!=="reading"?"rgba(196,240,0,.1)":"var(--wh)",cursor:"pointer",textAlign:"center"}} onClick={()=>updSettings("learnMode","speaking")}>
            <div style={{fontSize:"1.1rem",marginBottom:4}}>🗣</div>
            <div style={{fontSize:".72rem",fontWeight:700,color:"var(--ink)"}}>Speaking</div>
            <div style={{fontSize:".58rem",color:"var(--ink3)",marginTop:2}}>Jyutping first</div>
          </button>
          <button style={{flex:1,padding:"12px 10px",borderRadius:12,border:settings.learnMode==="reading"?"2px solid var(--lime)":"1.5px solid var(--st)",background:settings.learnMode==="reading"?"rgba(196,240,0,.1)":"var(--wh)",cursor:"pointer",textAlign:"center"}} onClick={()=>updSettings("learnMode","reading")}>
            <div style={{fontSize:"1.1rem",marginBottom:4}}>📖</div>
            <div style={{fontSize:".72rem",fontWeight:700,color:"var(--ink)"}}>Reading</div>
            <div style={{fontSize:".58rem",color:"var(--ink3)",marginTop:2}}>Characters first</div>
          </button>
        </div>
      </div>

      {/* English voice picker */}
      <div className="set-card">
        <div className="set-lb">English voice</div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {EN_VOICES.map(v => (
            <div key={v.id} onClick={()=>updSettings("enVoice",v.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:12,border:(settings.enVoice||DEFAULT_EN_VOICE)===v.id?"2px solid var(--lime)":"1.5px solid var(--st)",background:(settings.enVoice||DEFAULT_EN_VOICE)===v.id?"rgba(196,240,0,.08)":"var(--wh)",cursor:"pointer"}}>
              <div style={{fontSize:".85rem"}}>{v.gender==="female"?"👩":"👨"}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:".75rem",fontWeight:700,color:"var(--ink)"}}>{v.label}</div>
              </div>
              <button onClick={(e)=>{e.stopPropagation();previewEnVoice(v.id);}} style={{background:"var(--for)",color:"var(--lime)",border:"none",borderRadius:999,padding:"12px 16px",fontSize:".68rem",fontWeight:700,cursor:"pointer",minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>{playing===v.id?"...":"▶"}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Cantonese voice picker */}
      <div className="set-card">
        <div className="set-lb">Cantonese voice</div>
        <div style={{fontSize:".68rem",color:"var(--ink2)",lineHeight:1.5,marginBottom:10}}>AI voice for Cantonese phrases.</div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {CN_VOICES.map(v => (
            <div key={v.id} onClick={()=>updSettings("cnVoice",v.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:12,border:(settings.cnVoice||DEFAULT_CN_VOICE)===v.id?"2px solid var(--lime)":"1.5px solid var(--st)",background:(settings.cnVoice||DEFAULT_CN_VOICE)===v.id?"rgba(196,240,0,.08)":"var(--wh)",cursor:"pointer"}}>
              <div style={{fontSize:".85rem"}}>{v.gender==="female"?"👩":"👨"}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:".75rem",fontWeight:700,color:"var(--ink)"}}>{v.label}</div>
              </div>
              <button onClick={(e)=>{e.stopPropagation();previewCnVoice(v.id);}} style={{background:"var(--for)",color:"var(--lime)",border:"none",borderRadius:999,padding:"12px 16px",fontSize:".68rem",fontWeight:700,cursor:"pointer",minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>{playing===v.id?"...":"▶"}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Default speed */}
      <div className="set-card">
        <div className="set-lb">Default speed</div>
        <div style={{fontSize:".68rem",color:"var(--ink2)",lineHeight:1.5,marginBottom:10}}>Sets the starting speed for lessons and shadow mode.</div>
        <div style={{display:"flex",gap:8}}>
          {[{k:"slow",l:"🐢 Slow"},{k:"normal",l:"Normal"},{k:"fast",l:"🐇 Fast"}].map(s=>
            <button key={s.k} onClick={()=>updSettings("defaultSpeed",s.k)} style={{flex:1,padding:"10px 8px",borderRadius:12,border:(settings.defaultSpeed||"normal")===s.k?"2px solid var(--lime)":"1.5px solid var(--st)",background:(settings.defaultSpeed||"normal")===s.k?"rgba(196,240,0,.1)":"var(--wh)",cursor:"pointer",fontSize:".72rem",fontWeight:700,color:"var(--ink)",textAlign:"center"}}>{s.l}</button>
          )}
        </div>
      </div>

      {/* Download for offline */}
      <div className="set-card">
        <div className="set-lb">Offline audio</div>
        <div style={{fontSize:".68rem",color:"var(--ink2)",lineHeight:1.5,marginBottom:10}}>Download all audio files so you can use the app without internet. This only needs to be done once.</div>
        {dlState==="idle"&&<button onClick={downloadOfflineAudio} style={{width:"100%",padding:"12px",borderRadius:12,border:"none",background:"var(--for)",cursor:"pointer",fontSize:".78rem",fontWeight:700,color:"var(--lime)",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>Download for offline use</button>}
        {dlState==="loading"&&<div><div style={{fontSize:".72rem",fontWeight:700,color:"var(--ink)",marginBottom:6}}>Downloading... {dlProgress.done}/{dlProgress.total}</div><div style={{width:"100%",height:8,borderRadius:4,background:"var(--st)",overflow:"hidden"}}><div style={{width:`${dlProgress.total?((dlProgress.done/dlProgress.total)*100):0}%`,height:"100%",background:"var(--lime)",borderRadius:4,transition:"width .3s"}}></div></div></div>}
        {dlState==="done"&&<div style={{fontSize:".72rem",fontWeight:700,color:"#27ae60"}}>All audio downloaded! You can now use the app offline.</div>}
        {dlState==="error"&&<div><div style={{fontSize:".72rem",fontWeight:700,color:"#e74c3c",marginBottom:6}}>Download failed. Make sure you're online and try again.</div><button onClick={()=>{setDlState("idle");}} style={{padding:"8px 16px",borderRadius:10,border:"1.5px solid var(--st)",background:"var(--wh)",fontSize:".72rem",fontWeight:700,color:"var(--ink)",cursor:"pointer"}}>Retry</button></div>}
      </div>

      {/* ShadowSpeak Premium */}
      <div className="set-card">
        <div className="set-lb">ShadowSpeak Premium</div>
        {isPremium ? (
          <div style={{fontSize:".72rem",fontWeight:700,color:"#27ae60"}}>Premium active. All content unlocked.</div>
        ) : (
          <button onClick={()=>setShowPremiumGate(true)} style={{width:"100%",padding:"12px",borderRadius:12,border:"none",background:"var(--for)",cursor:"pointer",fontSize:".78rem",fontWeight:700,color:"var(--lime)",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>Unlock Premium</button>
        )}
      </div>

      {/* Switch language */}
      <div className="set-card">
        <div className="set-lb">Switch language</div>
        <button onClick={()=>{localStorage.setItem('shadowspeak-lang', LANG_CONFIG.switchTo.lang); window.location.reload();}} style={{width:"100%",padding:"12px",borderRadius:12,border:"1.5px solid var(--st)",background:"var(--wh)",cursor:"pointer",fontSize:".78rem",fontWeight:700,color:"var(--ink)",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>{LANG_CONFIG.switchTo.flag} {LANG_CONFIG.switchTo.label}</button>
      </div>

      {/* Reset progress */}
      <div className="set-card">
        {!confirmReset ? (
          <button onClick={()=>setConfirmReset(true)} style={{background:"none",border:"none",cursor:"pointer",fontSize:".75rem",fontWeight:600,color:"#e74c3c",padding:0}}>Reset all progress</button>
        ) : (
          <div>
            <div style={{fontSize:".72rem",color:"#e74c3c",fontWeight:700,marginBottom:8}}>Are you sure? This will erase all your progress and cannot be undone.</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{
                const uid = fbAuth.currentUser?.uid;
                if(uid){
                  fbDb.collection(PROGRESS_COLLECTION).doc(uid).delete();
                  fbDb.collection("settings").doc(uid+LANG_CONFIG.settingsKeySuffix).delete();
                }
                localStorage.removeItem(LANG_CONFIG.localStorageSettingsKey);
                window.location.reload();
              }} style={{flex:1,padding:"10px",borderRadius:10,border:"none",background:"#e74c3c",color:"#fff",fontSize:".72rem",fontWeight:700,cursor:"pointer"}}>Yes, reset everything</button>
              <button onClick={()=>setConfirmReset(false)} style={{flex:1,padding:"10px",borderRadius:10,border:"1.5px solid var(--st)",background:"var(--wh)",fontSize:".72rem",fontWeight:700,color:"var(--ink)",cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* About */}
      <div className="set-card">
        <div className="set-lb">About</div>
        <div style={{fontSize:".68rem",color:"var(--ink2)",lineHeight:1.5}}>ShadowSpeak {LANG_CONFIG.name} v3.9.2. Shadowing method + spaced repetition. {ALL_WORDS.length} vocabulary words across {VOCAB_CATS.length} categories. {UNITS.reduce((s,u)=>s+u.phrases.length,0)} phrases across {UNITS.length} units.</div>
        <button onClick={()=>window.location.href="index.html"} style={{marginTop:8,background:"none",border:"none",cursor:"pointer",fontSize:".68rem",fontWeight:600,color:"var(--lime)",padding:0}}>← Back to landing page</button>
      </div>
    </div>
  );
}



export default App;
