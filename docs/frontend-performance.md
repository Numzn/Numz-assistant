# Frontend load performance

Status: **Implemented and tested locally on branch `perf/phase1-fast-load`. Not merged, not deployed.**

This is Phase 1 of the speed work: how many bytes the first page load costs. It changes no screen and no API.
What it does not cover is listed at the end.

## What was wrong

Measured on `main` (2026-10-18), against production:

- The app was one 1.74 MB script, sent **uncompressed**: neither the front door (Caddy has no `encode`) nor the
  server compressed anything.
- 64% of that script was the Picovoice wake-word SDK (about 1.1 MB). In production it can never run: no
  `VITE_PICOVOICE_ACCESS_KEY` exists, and `.dockerignore` keeps `.env*` out of the build.
- Another 27% was Three.js, which only the voice-mode orb needs. A WebGL context and the bloom render targets
  were created at page load even though the orb is only drawn in voice mode.
- Hashed files were served with `Cache-Control: public, max-age=0`, so a returning visitor revalidated each one.
- Through the public name (`assistant.lab.numz.site`, by way of the gateway) the bundle came in at about 6 KB/s
  from this host, so bytes were the whole cost.

## What changed

| Change | Where |
|---|---|
| Brotli and gzip copies are made at build time and sent as they are | `scripts/precompress.js` (run by `npm run build`), `server/http/staticAssets.js` |
| `/assets/*` (content-hashed) is `public, max-age=31536000, immutable`; everything else, `index.html` above all, is `no-cache` | `server/http/staticAssets.js` |
| A missing `/assets/*` file is a 404, not the app page | same |
| The Picovoice SDK loads the first time the wake word is armed, and never without a key | `src/interfaces/voice/porcupineWake.js`, `porcupineSdk.js` |
| The Three.js orb is fetched when the browser is idle (or the voice button is approached) and created on the first entry to voice mode | `src/orb/orbLoader.js`, `src/orb/createOrb.js`, `src/main.js` |

Details worth knowing:

- Brotli wins whenever the browser accepts it, in whatever order it lists encodings (Chrome lists gzip first).
  A compressed copy older than its original is ignored, and a copy is kept only if it is smaller.
- Nothing is compressed per request, so there is no CPU cost, and the chat stream (SSE) is untouched.
- The compressed files travel unchanged through both proxies (the front door and the gateway), so no Caddy
  change is needed.
- The orb is decoration. If its file cannot be fetched, or the browser has no WebGL, voice mode still starts and
  a warning is logged (`[orb] unavailable`). Before this, a browser without WebGL failed the whole page at load.
- Prefetching the orb is skipped on a data-saver or 2G connection; the orb is then fetched on first use.
- A tab opened before a deploy still holds last week's chunk names. Its orb or wake word fails to load (a 404)
  and voice mode carries on without the orb until the page is reloaded.

## Numbers

Sizes are of the files as built. "Sent" is what crossed the wire in headless Chromium against the production
server on a spare port (`request.sizes()`), first visit.

| First load of `index.html` | Before | After |
|---|---:|---:|
| Scripts, raw | 1,742.9 KB | 142.3 KB |
| Whole page, raw | 1,770.5 KB | 169.8 KB |
| Whole page, gzip | 635.5 KB | 55.3 KB |
| Whole page, Brotli | 494.8 KB | 48.1 KB |
| **Sent in production** | **1,770 KB** (uncompressed) | **48.1 KB** (Brotli) |

| Built but fetched only when needed | Raw | Brotli | When |
|---|---:|---:|---|
| `createOrb-*.js` (Three.js, bloom, the orb) | 485.6 KB | 100.6 KB | prefetched when idle; created on first voice mode |
| `porcupineSdk-*.js` (Picovoice) | 1,116.8 KB | 347.3 KB | only if the wake word is armed (needs a key) |

Measured in a real browser (headless Chromium, fake microphone):

- First visit: 4 files, 48.1 KB; no orb, no Picovoice, 0 WebGL contexts.
- After 6 s idle: the orb code (100.6 KB) has been prefetched; still 0 WebGL contexts, no Picovoice.
- Entering voice mode: 1 WebGL context, the orb is drawn (the middle of the screen goes from 2% to 21% bright
  pixels), no console errors, no new file downloaded.
- Second visit: the script and stylesheet come from the browser cache with no request; only the small HTML
  page is revalidated.
- With the orb file blocked: voice mode still starts, a warning is logged, no page error.

At the 6 KB/s measured on the public route, the first load goes from about 295 s to about 8 s. That is
arithmetic on one measurement, not a measurement of the new build on that route.

After the UI refresh (same day, `docs/home-screen.md`): the first load of `index.html` is 52.7 KB in Brotli (HTML 2.9,
script 41.0 and 3.0, stylesheet 5.7). The self-hosted fonts are extra: Inter 48 KB and the greeting's Instrument Serif
22 KB on every first visit, JetBrains Mono 31 KB only once something that uses it (a timer, a timestamp, code, the
model label) is on screen. All three are content-hashed and cached for a year.

**The fonts wait for the script.** First deployed, the fonts started downloading as soon as the stylesheet arrived and
shared a slow link with the script (on the public route, which delivers 2 to 6 KB/s, the script took about 10 s to
arrive instead of about 7). Now the default font tokens in `style.css` name only system fonts, and
`:root[data-fonts]` is what names the three web fonts. `enableWebFonts()` (`src/interfaces/layout/workspace.js`) adds
`data-fonts` to `<html>` as the first statement of `main.js` and `history.js`, that is, once the script has arrived; a
browser fetches a font only when a rule uses its family, so nothing is fetched before. Data saver and 2G keep the
system fonts (`isLowBandwidth()`, shared with the orb prefetch). `tests/fontsDeferred.test.js` fails if a web font
family is named anywhere else in the stylesheet or if either page stops calling the helper.

Measured on the same throttled link for both builds (6 KB/s, 1.2 s latency, cold cache, three runs each, identical
every time): the script arrived at 20.5 s before and 11.5 s after (9 s earlier, the app is usable that much sooner),
first paint stayed at 5.4 s, and the `load` event moved from 25.2 s to 25.9 s because the fonts still use the link,
just after the script. The text shows in the system font first and switches to Inter when the font arrives.

## Keeping it fast

`npm run build && npm run bundle:report` prints first-load and lazy sizes (raw, gzip, Brotli) per page.

Three tests hold the line (`npm test`):

- `tests/importGraph.test.js` fails if anything the page loads up front can reach `three`, `@picovoice/*`, the
  orb, or `src/engine`, `src/animation` by a static `import`. Use `import()`.
- `tests/bundleBudget.test.js` builds the app for real and fails if the first load exceeds its budget (scripts
  220 KB raw / 80 KB gzip, whole page 75 KB Brotli), if Three.js or Picovoice code is in a first-load file, or if a
  file under `/assets/` has no content hash (the server would cache it as immutable).
- `tests/staticAssets.test.js` reads the real bytes and headers off the wire.

## Not in Phase 1

- The startup request chain (auth status, then an awaited `POST /sessions`, then `/health`), inline critical CSS,
  and a service worker. These need small behaviour changes and were left for later.
- The public route's throughput (the gateway and tunnel). Serving static files from an edge cache would avoid it;
  that is infrastructure and was not touched.
- Compressing JSON API responses (they are small). `encode` in the Caddyfile would do it.
