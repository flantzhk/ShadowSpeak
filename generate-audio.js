#!/usr/bin/env node
/**
 * generate-audio.js — Pre-generate all TTS audio for ShadowSpeak offline mode
 * 
 * Usage:
 *   node generate-audio.js [--canto-only] [--mandarin-only] [--en-only] [--cn-only] [--resume] [--dry-run]
 * 
 * This calls the Cloudflare Worker proxy at:
 *   https://shadowspeak-proxy.faith-lantz-ee8.workers.dev
 * 
 * Audio routing:
 *   - Cantonese CN:  cantonese.ai via POST /tts (woman voice)
 *   - Cantonese EN:  ElevenLabs via POST /elevenlabs/tts (American woman)
 *   - Mandarin CN:   ElevenLabs via POST /elevenlabs/tts (Mandarin woman)
 *   - Mandarin EN:   ElevenLabs via POST /elevenlabs/tts (American woman)
 * 
 * Output structure:
 *   audio/canto/cn/  — Cantonese Chinese audio
 *   audio/canto/en/  — Cantonese English audio
 *   audio/mandarin/cn/ — Mandarin Chinese audio
 *   audio/mandarin/en/ — Mandarin English audio
 * 
 * Filenames: SHA-256 hash of the text, truncated to 12 hex chars. e.g. "a1b2c3d4e5f6.mp3"
 * A manifest file (audio/manifest.json) maps text -> filename for the apps to look up.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ============================================================
// CONFIG
// ============================================================

const PROXY_URL = "https://shadowspeak-proxy.faith-lantz-ee8.workers.dev";

// Voice IDs
const VOICE_EN = "4yoylgRRiLD7CqjKHeTx";        // American woman (ElevenLabs)
const VOICE_MANDARIN = "bhJUNIXWQQ94l8eI2VUf";    // Mandarin woman (ElevenLabs)
const VOICE_CANTO = "c09e3009-5aa6-4aab-aa94-a3621032bcc4"; // Cantonese woman (cantonese.ai)

// Rate limiting: be kind to the APIs
const DELAY_ELEVENLABS_MS = 350;  // ~2.8 req/sec
const DELAY_CANTONESE_AI_MS = 500; // ~2 req/sec
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ============================================================
// PHRASE DATA — extracted from canto.html and mandarin.html
// ============================================================

// We'll parse the HTML files to extract phrases at runtime
// This makes the script self-updating when phrases change

function extractCantoData(html) {
  const phrases = [];
  const vocabWords = [];

  // Unit phrases: { en: "...", jyut: "...", cn: "..." }
  const phraseRe = /\{\s*en:\s*"([^"]+)",\s*jyut:\s*"[^"]*",\s*cn:\s*"([^"]+)"/g;
  let m;
  while ((m = phraseRe.exec(html)) !== null) {
    phrases.push({ en: m[1], cn: m[2] });
  }

  // Vocab: { cn:"...", jyut:"...", en:"..." }
  const vocabStart = html.indexOf("const VOCAB_CATS = [");
  if (vocabStart > -1) {
    const vocabEnd = html.indexOf("];", vocabStart) + 2;
    const vocabBlock = html.substring(vocabStart, vocabEnd);
    const vocabRe = /cn:"([^"]+)",jyut:"[^"]*",en:"([^"]+)"/g;
    while ((m = vocabRe.exec(vocabBlock)) !== null) {
      vocabWords.push({ en: m[2], cn: m[1] });
    }
  }

  return dedup([...phrases, ...vocabWords]);
}

function extractMandarinData(html) {
  const phrases = [];
  const vocabWords = [];

  // Unit phrases: { en: "...", pinyin: "...", cn: "..." }
  const phraseRe = /\{\s*en:\s*"([^"]+)",\s*pinyin:\s*"[^"]*",\s*cn:\s*"([^"]+)"/g;
  let m;
  while ((m = phraseRe.exec(html)) !== null) {
    phrases.push({ en: m[1], cn: m[2] });
  }

  // Vocab: { cn:"...", pinyin:"...", en:"..." }
  const vocabStart = html.indexOf("const VOCAB_CATS = [");
  if (vocabStart > -1) {
    const vocabEnd = html.indexOf("];", vocabStart) + 2;
    const vocabBlock = html.substring(vocabStart, vocabEnd);
    const vocabRe = /cn:"([^"]+)",pinyin:"[^"]*",en:"([^"]+)"/g;
    while ((m = vocabRe.exec(vocabBlock)) !== null) {
      vocabWords.push({ en: m[2], cn: m[1] });
    }
  }

  return dedup([...phrases, ...vocabWords]);
}

function dedup(items) {
  const seenCn = new Set();
  const seenEn = new Set();
  const cnItems = [];
  const enItems = [];

  for (const item of items) {
    if (!seenCn.has(item.cn)) {
      seenCn.add(item.cn);
      cnItems.push(item.cn);
    }
    if (!seenEn.has(item.en)) {
      seenEn.add(item.en);
      enItems.push(item.en);
    }
  }

  return { cn: cnItems, en: enItems };
}

// ============================================================
// FILENAME HASHING
// ============================================================

function textToFilename(text) {
  const hash = crypto.createHash("sha256").update(text).digest("hex").substring(0, 12);
  return hash + ".mp3";
}

// ============================================================
// API CALLERS
// ============================================================

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        // Rate limited — wait longer
        const wait = RETRY_DELAY_MS * attempt * 2;
        console.log(`    Rate limited (429), waiting ${wait}ms before retry ${attempt}/${retries}...`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = RETRY_DELAY_MS * attempt;
      console.log(`    Attempt ${attempt} failed: ${err.message}. Retrying in ${wait}ms...`);
      await sleep(wait);
    }
  }
}

/** Cantonese.ai TTS — returns MP3 buffer */
async function cantoneseTTS(text) {
  const res = await fetchWithRetry(`${PROXY_URL}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      language: "cantonese",
      speed: 1,
      output_extension: "mp3",
      voice_id: VOICE_CANTO,
    }),
  });
  return Buffer.from(await res.arrayBuffer());
}

/** ElevenLabs TTS — returns MP3 buffer */
async function elevenLabsTTS(text, voiceId) {
  const res = await fetchWithRetry(`${PROXY_URL}/elevenlabs/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0 },
    }),
  });
  return Buffer.from(await res.arrayBuffer());
}

// ============================================================
// GENERATION PIPELINE
// ============================================================

async function generateBatch(items, outDir, fetchFn, delayMs, label) {
  fs.mkdirSync(outDir, { recursive: true });

  const total = items.length;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${label}: ${total} items -> ${outDir}`);
  console.log(`${"=".repeat(60)}`);

  for (const text of items) {
    const filename = textToFilename(text);
    const filepath = path.join(outDir, filename);

    // Resume support: skip if file already exists and has content
    if (fs.existsSync(filepath) && fs.statSync(filepath).size > 100) {
      skipped++;
      done++;
      if (done % 50 === 0 || done === total) {
        process.stdout.write(`  [${done}/${total}] ${skipped} skipped, ${failed} failed\r`);
      }
      continue;
    }

    try {
      const buffer = await fetchFn(text);
      fs.writeFileSync(filepath, buffer);
      done++;

      if (done % 10 === 0 || done === total) {
        const pct = ((done / total) * 100).toFixed(1);
        process.stdout.write(`  [${done}/${total}] ${pct}% | ${skipped} skipped | ${failed} failed\r`);
      }

      await sleep(delayMs);
    } catch (err) {
      failed++;
      done++;
      errors.push({ text: text.substring(0, 30), error: err.message });
      console.log(`\n  FAILED: "${text.substring(0, 30)}..." - ${err.message}`);
    }
  }

  console.log(`\n  Done: ${done - skipped - failed} generated, ${skipped} skipped, ${failed} failed`);

  if (errors.length > 0) {
    const errFile = path.join(outDir, "_errors.json");
    fs.writeFileSync(errFile, JSON.stringify(errors, null, 2));
    console.log(`  Error log: ${errFile}`);
  }

  return { total, generated: done - skipped - failed, skipped, failed };
}

// ============================================================
// MANIFEST BUILDER
// ============================================================

function buildManifest(cantoData, mandarinData) {
  const manifest = {
    canto: { cn: {}, en: {} },
    mandarin: { cn: {}, en: {} },
  };

  for (const text of cantoData.cn) {
    manifest.canto.cn[text] = `audio/canto/cn/${textToFilename(text)}`;
  }
  for (const text of cantoData.en) {
    manifest.canto.en[text] = `audio/canto/en/${textToFilename(text)}`;
  }
  for (const text of mandarinData.cn) {
    manifest.mandarin.cn[text] = `audio/mandarin/cn/${textToFilename(text)}`;
  }
  for (const text of mandarinData.en) {
    manifest.mandarin.en[text] = `audio/mandarin/en/${textToFilename(text)}`;
  }

  return manifest;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const cantoOnly = args.includes("--canto-only");
  const mandarinOnly = args.includes("--mandarin-only");
  const enOnly = args.includes("--en-only");
  const cnOnly = args.includes("--cn-only");
  const dryRun = args.includes("--dry-run");

  // Find and parse HTML files
  const scriptDir = path.dirname(process.argv[1]);
  const cantoPath = path.join(scriptDir, "canto.html");
  const mandarinPath = path.join(scriptDir, "mandarin.html");

  if (!fs.existsSync(cantoPath)) {
    console.error(`Error: canto.html not found at ${cantoPath}`);
    console.error("Run this script from the repo root (same folder as canto.html and mandarin.html).");
    process.exit(1);
  }
  if (!fs.existsSync(mandarinPath)) {
    console.error(`Error: mandarin.html not found at ${mandarinPath}`);
    process.exit(1);
  }

  console.log("Parsing HTML files for phrase data...");
  const cantoHtml = fs.readFileSync(cantoPath, "utf-8");
  const mandarinHtml = fs.readFileSync(mandarinPath, "utf-8");

  const cantoData = extractCantoData(cantoHtml);
  const mandarinData = extractMandarinData(mandarinHtml);

  console.log(`\nCantonese:  ${cantoData.cn.length} CN phrases, ${cantoData.en.length} EN phrases`);
  console.log(`Mandarin:   ${mandarinData.cn.length} CN phrases, ${mandarinData.en.length} EN phrases`);

  const totalFiles = cantoData.cn.length + cantoData.en.length + mandarinData.cn.length + mandarinData.en.length;
  console.log(`Total:      ${totalFiles} audio files to generate`);

  // Build and save manifest (always, even on dry-run)
  console.log("\nBuilding audio manifest...");
  const manifest = buildManifest(cantoData, mandarinData);
  const manifestDir = path.join(scriptDir, "audio");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`Manifest saved: audio/manifest.json`);

  if (dryRun) {
    console.log("\n--dry-run: Manifest built, no audio generated.");
    console.log("Sample filenames:");
    const sampleCn = cantoData.cn.slice(0, 3);
    for (const t of sampleCn) {
      console.log(`  "${t}" -> ${textToFilename(t)}`);
    }
    return;
  }

  console.log("\n--- Starting audio generation ---");
  console.log("This will take a while. Progress is saved; re-run to resume.\n");

  const stats = [];

  // 1. Cantonese CN (cantonese.ai)
  if (!mandarinOnly && !enOnly) {
    stats.push(await generateBatch(
      cantoData.cn,
      path.join(scriptDir, "audio", "canto", "cn"),
      (text) => cantoneseTTS(text),
      DELAY_CANTONESE_AI_MS,
      "Cantonese CN (cantonese.ai)"
    ));
  }

  // 2. Cantonese EN (ElevenLabs)
  if (!mandarinOnly && !cnOnly) {
    stats.push(await generateBatch(
      cantoData.en,
      path.join(scriptDir, "audio", "canto", "en"),
      (text) => elevenLabsTTS(text, VOICE_EN),
      DELAY_ELEVENLABS_MS,
      "Cantonese EN (ElevenLabs)"
    ));
  }

  // 3. Mandarin CN (ElevenLabs)
  if (!cantoOnly && !enOnly) {
    stats.push(await generateBatch(
      mandarinData.cn,
      path.join(scriptDir, "audio", "mandarin", "cn"),
      (text) => elevenLabsTTS(text, VOICE_MANDARIN),
      DELAY_ELEVENLABS_MS,
      "Mandarin CN (ElevenLabs)"
    ));
  }

  // 4. Mandarin EN (ElevenLabs)
  if (!cantoOnly && !cnOnly) {
    stats.push(await generateBatch(
      mandarinData.en,
      path.join(scriptDir, "audio", "mandarin", "en"),
      (text) => elevenLabsTTS(text, VOICE_EN),
      DELAY_ELEVENLABS_MS,
      "Mandarin EN (ElevenLabs)"
    ));
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  let totalGen = 0, totalSkip = 0, totalFail = 0;
  for (const s of stats) {
    totalGen += s.generated;
    totalSkip += s.skipped;
    totalFail += s.failed;
  }
  console.log(`  Generated: ${totalGen}`);
  console.log(`  Skipped (already existed): ${totalSkip}`);
  console.log(`  Failed: ${totalFail}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Check audio/manifest.json is present`);
  console.log(`  2. Push everything to GitHub: git add -A && git commit -m "Add offline audio" && git push`);
  console.log(`  3. Open the site and add to home screen on your phone`);

  if (totalFail > 0) {
    console.log(`\n  ${totalFail} files failed. Re-run the script to retry (it skips already-generated files).`);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
