/**
 * sw.js — ShadowSpeak Service Worker
 * 
 * Strategy:
 *   - INSTALL: Pre-cache the HTML shell files + manifest
 *   - ACTIVATE: Clean up old caches
 *   - FETCH:
 *     - HTML/manifest: Cache-first, network fallback
 *     - Audio files: Cache-first, network fallback  
 *     - Google Fonts: Cache-first (stale-while-revalidate)
 *     - Firebase/CDN scripts: Network-first, cache fallback
 *     - API calls (proxy): Network-only (never cache API responses)
 * 
 * Audio files are cached on first load from GitHub Pages.
 * The generate-audio.js script creates them, you push to GitHub,
 * and the SW caches them as users browse.
 */

const CACHE_VERSION = "ss-v2";
const CACHE_STATIC = `${CACHE_VERSION}-static`;
const CACHE_AUDIO = `${CACHE_VERSION}-audio`;
const CACHE_FONTS = `${CACHE_VERSION}-fonts`;
const CACHE_CDN = `${CACHE_VERSION}-cdn`;

// Files to pre-cache on install
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./canto.html",
  "./mandarin.html",
  "./manifest.json",
  "./audio/manifest.json",
];

// ============================================================
// INSTALL — pre-cache shell
// ============================================================
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      console.log("[SW] Pre-caching shell files");
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        // Don't fail install if audio manifest doesn't exist yet
        console.warn("[SW] Some pre-cache items failed (ok on first deploy):", err);
        return cache.addAll([
          "./",
          "./index.html",
          "./canto.html",
          "./mandarin.html",
          "./manifest.json",
        ]);
      });
    })
  );
  // Take control immediately
  self.skipWaiting();
});

// ============================================================
// ACTIVATE — clean old caches, claim clients
// ============================================================
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((k) => k.startsWith("ss-") && k !== CACHE_STATIC && k !== CACHE_AUDIO && k !== CACHE_FONTS && k !== CACHE_CDN)
          .map((k) => {
            console.log("[SW] Deleting old cache:", k);
            return caches.delete(k);
          })
      );
    })
  );
  // Start serving immediately
  self.clients.claim();
});

// ============================================================
// FETCH — routing strategy
// ============================================================
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests (POST to proxy, etc.)
  if (event.request.method !== "GET") return;

  // Skip chrome-extension, etc.
  if (!url.protocol.startsWith("http")) return;

  // ---- AUDIO FILES: cache-first ----
  if (url.pathname.includes("/audio/")) {
    event.respondWith(cacheFirst(event.request, CACHE_AUDIO));
    return;
  }

  // ---- GOOGLE FONTS: cache-first ----
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(event.request, CACHE_FONTS));
    return;
  }

  // ---- CDN SCRIPTS (React, Babel, Firebase): stale-while-revalidate ----
  if (
    url.hostname === "cdnjs.cloudflare.com" ||
    url.hostname === "www.gstatic.com" ||
    url.hostname.endsWith("firebaseio.com")
  ) {
    event.respondWith(staleWhileRevalidate(event.request, CACHE_CDN));
    return;
  }

  // ---- API PROXY: network-only (never cache) ----
  if (url.hostname.includes("shadowspeak-proxy") || url.hostname.includes("workers.dev")) {
    return; // Let the browser handle normally
  }

  // ---- Firebase APIs: network-only ----
  if (
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("identitytoolkit.googleapis.com") ||
    url.hostname.includes("securetoken.googleapis.com") ||
    url.hostname.includes("googleapis.com")
  ) {
    return; // Let the browser handle normally
  }

  // ---- Google TTS: cache-first (these are GET requests with audio) ----
  if (url.hostname === "translate.google.com" && url.pathname.includes("translate_tts")) {
    event.respondWith(cacheFirst(event.request, CACHE_AUDIO));
    return;
  }

  // ---- HTML / STATIC: cache-first ----
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request, CACHE_STATIC));
    return;
  }
});

// ============================================================
// CACHING STRATEGIES
// ============================================================

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline and not cached — return a simple offline response for HTML
    if (request.headers.get("Accept")?.includes("text/html")) {
      return new Response(
        "<html><body style='font-family:sans-serif;text-align:center;padding:40px'><h2>You're offline</h2><p>This page hasn't been cached yet. Open it once while online, then it will work offline.</p></body></html>",
        { headers: { "Content-Type": "text/html" } }
      );
    }
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Fetch in background regardless
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Return cached immediately if available, otherwise wait for network
  return cached || (await fetchPromise) || new Response("Offline", { status: 503 });
}

// ============================================================
// MESSAGE HANDLER — for cache management from the app
// ============================================================
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }

  // Pre-cache a batch of audio URLs
  if (event.data?.type === "precache-audio" && Array.isArray(event.data.urls)) {
    event.waitUntil(
      caches.open(CACHE_AUDIO).then(async (cache) => {
        for (const url of event.data.urls) {
          try {
            // Resolve to absolute URL so cache key matches fetch requests
            const absoluteUrl = new URL(url, self.location.origin + self.location.pathname.replace(/[^/]*$/, '')).href;
            const existing = await cache.match(absoluteUrl);
            if (!existing) {
              const res = await fetch(absoluteUrl);
              if (res.ok) await cache.put(absoluteUrl, res);
            }
          } catch (e) {
            // Skip failures silently
          }
        }
      })
    );
  }
});
