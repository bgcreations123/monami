# Monami — Debug & Polish Todo

> Status legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked

## Phase 1 — Diagnostics
- [x] Inventory project, entry points, and toolchain
- [x] Verify Node/npm versions and install frontend dependencies if missing
- [x] Run production build (`npm run build`) and record every error
- [x] Statically check server scripts (`node --check`) and tests
- [x] Run existing test suite (`scripts/tests`)

## Phase 2 — Fix Errors
- [x] Fix dependency / version problems
- [x] Fix JavaScript/JSX syntax and runtime errors
- [x] Fix React state, effect, and prop-contract bugs
- [x] Fix server route / API mismatches
- [x] Fix broken asset, icon, or import references
- [x] Fix settings tab crash (`isSD15OrCustom is not defined`)
- [x] Exercise image generation flow
- [x] Exercise speech transcription flow
- [x] Exercise text-to-speech flow
- [x] Add automatic GPU → CPU fallback when an image model cannot fit in VRAM

## Phase 3 — UI Beautification
- [x] Audit shared design tokens (color, spacing, radius, elevation, type scale)
- [x] Polish sidebar, top status bar, and navigation rail (brand lockup overlap)
- [x] Remove the loaded-model pill from the top bar; keep the theme controls
- [x] Polish chat composer, bubbles, and markdown/code blocks
- [x] Polish images, models, speech, TTS, and settings screens
- [x] Add focus-visible states, reduced-motion support, and responsive polish
- [x] Clear stale GPU device labels after switching to CPU
- [x] Keep the 1024px option selectable before a model is loaded

## Phase 4 — Verification
- [x] Production build succeeds; only Vite's informational chunk-size advisory remains
- [x] Lint/static check the whole app (`no-undef` clean, all server scripts parse)
- [x] Boot the production server and smoke-test every route + API
- [x] Confirm no uncaught errors in browser console
- [x] Write final verification report (`VERIFICATION.md`)
- [x] Revalidate final bundle (`index-BLkmZyTP.js`) after the `serverRunning` effect fix
- [x] Strip GPU vendor prefix from the sidebar device label

## Findings Log

### Fixed
- `app/frontend/src/components/Settings.jsx`: opening **Image generation** settings threw
  `ReferenceError: isSD15OrCustom is not defined` and blanked the app. Added the missing
  derived value (`const isSD15OrCustom = isSD15OrCustomModel(activeModel);`).
- `app/frontend/src/App.css`: sidebar brand lockup used stacked/negative-margin hacks that
  made the Monami mark collide with "LOCAL STUDIO" and the header action icons. Rebuilt as a
  single horizontal logo + wordmark lockup.
- `app/frontend/src/components/Sidebar.jsx`: brand label changed from "Local Studio" to the
  product name "Monami" to match the window title and logo; device GPU names now have their
  marketing suffixes stripped (`Intel(R) Iris(R) Xe Graphics` → `Iris Xe Graphics`).
- `app/frontend/src/components/TopStatusBar.jsx`: removed the loaded-model status pill
  (`Chat qwen2.5-coder-14b-instruct-q4_k_m` + unload button) and its 3-second status
  polling. The top bar now contains only the theme and palette controls (and the sidebar
  toggle when the sidebar is hidden).
- `app/frontend/src/components/ModelManager.jsx`: search placeholder was clipped mid-word
  ("Search models and Hugging"). Shortened the visible placeholder and kept the full
  explanation in the accessible label/title.
- `scripts/server/serve.cjs`: startup banner still said "UNCENSORED AI STUDIO"; aligned it
  with the Monami product name.
- `app/frontend/src/services/api.js` + `Generator.jsx` + `ModelManager.jsx`: a Vulkan
  out-of-memory load dead-ended at an error. Added `startImageBackendWithFallback`, which
  detects GPU allocation failures and retries once on CPU at 512×512, updates constraints,
  and shows a clear "Running on CPU" notice.
- `app/frontend/src/services/api.js`: backend stderr arrives in chunks, so the first error
  was sometimes a bare `[ERROR]` and the fallback never fired. Added a 1.5 s settle window
  that waits for the complete message before classifying the failure; GPU startup crashes
  without a clear error also retry on CPU.
- `scripts/server/serve.cjs`: ignored bare `[ERROR]` fragments when publishing
  `backendError`, so status never exposed a meaningless placeholder.
- `app/frontend/src/App.jsx`: the per-model defaults effect reset a successful CPU fallback
  back to 1024×1024 (and Lightning CFG 1.5), causing Generator to restart on CPU and take
  ~20 minutes per image. It now mirrors the actually loaded backend settings and leaves
  already-running models alone.
- `scripts/server/serve.cjs`: CPU starts kept the previous `vulkan0` device name, so Models
  showed "Running on CPU · vulkan0". Device is now cleared for non-Vulkan backends.
- `app/frontend/src/components/Settings.jsx`: the 1024px choice was disabled before any
  model was loaded, even though width/height accepted 1024. The lock now applies only when
  a loaded model is actually SD 1.5/custom.

### Verified
- Production build succeeds (only a Vite chunk-size advisory).
- `no-undef` ESLint pass across `src` with 0 errors.
- `node --check` passes for all JS/CJS/MJS server and script files (13 files, 0 failures).
- `node --test scripts/tests` → 29 tests, 0 failures.
- All Settings tabs open without errors: Appearance, Image generation, Text generation,
  Code, Speech, Voice.
- All Models tabs render: Image, Text, Speech, Voice.
- Chat end-to-end on final build: Qwen2.5 7B replied `MONAMI OK` (4 tokens, 2.09 s).
- Speech transcription on final build: produced `Hello from Minami.` in the transcript box.
- TTS on final build: synthesized "Final runtime verification at 14:27:59." and saved
  `tts-2026-11-16T14-28-08-855Z-af_heart.wav`.
- Image fallback on final build: Vulkan/DreamShaperXL OOM → CPU 512×512 ready; Settings
  showed CPU/512 and no stale `vulkan0` label.
- Image generation through the Generator UI after fallback: 512×512, 4 steps, 284 s,
  valid 437 KB PNG.
- Broad browser audit: all routes, all Settings/Models tabs, no console errors, page
  errors, failed requests, or HTTP errors (and no console warnings).
- Sidebar collapse/reopen, sidebar search, all 8 themes, and the font-size slider work.
- GET endpoints smoke-tested (health, diagnostics, hardware, telemetry, model lists,
  backend options/status, outputs, speech/TTS/LLM status, progress, cleanup candidates).

### Open
- No functional blockers.
- CPU image generation is slow on the current Intel Iris Xe machine (~4.5 minutes for a
  512×512, 4-step image). This is expected without a supported GPU allocation.
- Vite emits an informational >500 kB chunk-size advisory; it does not affect runtime.
