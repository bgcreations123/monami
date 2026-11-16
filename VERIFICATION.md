# Monami — Final Verification Report

**Date:** 16 November 2026  
**Build:** `app/dist` (`assets/index-BnqggxaN.js`)  
**Server:** `node scripts/server/serve.cjs` on `http://127.0.0.1:1420`  
**Browser:** Playwright + Microsoft Edge, 1440×900  
**Machine:** Intel Core i5-1135G7, Intel Iris Xe Graphics, 11.7 GB RAM (Windows)

## Result

Every route, Settings tab, Models tab, and core workflow was exercised against the
production build. No uncaught exceptions, console errors, failed requests, or HTTP errors
were observed. Image, text, speech, and TTS pipelines all produced real output.

## Static and automated checks

| Check | Command | Result |
|---|---|---|
| Production build | `npm run build` | Pass — 1,790 modules; only the informational >500 kB chunk advisory |
| `no-undef` lint | `eslint@9 -c <temp config> src` | Pass — 0 errors |
| Server/script syntax | `node --check` on all JS/CJS/MJS | Pass — 13 files, 0 failures |
| Project tests | `node --test scripts/tests` | Pass — 29 tests, 0 failures |

JSX syntax is covered by the production build (Vite/Rolldown).

## Runtime verification

### Image generation (automatic GPU → CPU fallback)

1. Set **Vulkan GPU**, 1024×1024, DreamShaperXL Lightning in Settings.
2. Clicked **Load** in Models.
3. Vulkan failed with `ErrorOutOfDeviceMemory` / `new_sd_ctx_t failed`.
4. Monami automatically retried on **CPU at 512×512** and reached ready in ~10 s.
5. The "Running on CPU" notice appeared; Settings showed **CPU, 512×512**.
6. No stale device label: Models now reads `Running on CPU` (previously `vulkan0`).
7. Generated an image through the Generator UI at 512×512 / 4 steps.

**Evidence**
- Generation completed in **284 s**; PNG is **437,106 bytes**, content type `image/png`.
- Prompt/metadata: “a single red apple on a wooden table, studio light”,
  seed 493694, 281.3 s.
- Screenshots: `flows/ui-generated-final.png`, `flows/fallback-after-load.png`,
  `flows/settings-cpu-after-reload.png`, `flows/models-cpu-device-clean.png`
- Machine-readable report: `flows/fallback-generate-report.json`

### Text chat

Loaded Qwen2.5 7B Instruct (Q3_K_M) through the UI and sent
“Reply with exactly: MONAMI OK”.

**Result:** `MONAMI OK` — 4 tokens, 2.09 s.

- Screenshot: `flows/final-chat2.png`
- Report: `flows/final-runtime2-report.json`

### Speech transcription

Loaded Whisper Small Multilingual, uploaded the existing WAV, clicked **Transcribe**.

**Result:** `Hello from Minami.` populated in the transcript editor.

- Screenshot: `flows/final-transcribe-text.png`

### Text-to-speech

Loaded Kokoro 82M, entered “Final runtime verification at 14:27:59.”, clicked **Speak**.

**Result:** New output saved as
`app/tts-outputs/tts-2026-11-16T14-28-08-855Z-af_heart.wav`; the player and history entry
appeared.

- Screenshot: `flows/final-voice2.png`

### Route and UI audit

Opened every route (`chat`, `images`, `transcribe`, `voice`, `models`, `settings`) and every
Settings/Models tab. Checked layout, populated content, and console/network health.

**Result:** 0 console errors, 0 page errors, 0 HTTP errors, 0 request failures,
0 console warnings.

- Screenshots: `audit4/settings-*.png`, `audit4/models-*.png`,
  `audit4/chat-model-menu.png`, `audit4/voice-page.png`,
  `audit4/transcribe-page.png`, `audit4/images-page.png`
- Report: `audit4/report.json`

### Final bundle revalidation

The final bundle was rebuilt as `index-BnqggxaN.js` after the last UI pass: the loaded-model
status pill was removed from the top bar (theme controls remain), the sidebar device label
now strips the GPU vendor prefix (`Intel Iris Xe Graphics` → `Iris Xe Graphics`), and the
chat thread bar now uses a clickable three-dot menu instead of the context-percentage ring
plus clear-chat delete icon.

Re-tested end to end:

- CPU fallback restart: HTTP **200**, ready on **CPU**, **512×512**, empty device string.
- Models row: `DreamShaperXL | Loaded | 6.5 GB · Lightning · Running on CPU` (no `vulkan0`).
- 1024px option remains enabled for the loaded SDXL model; it is enabled before load too.
- Top bar shows only the theme and palette controls; no model name or unload pill.
- Sidebar footer fits `Iris Xe Graphics` without truncation.
- Chat thread bar: no context-percentage ring; kebab button opens a menu with the
  **Clear chat** item, which executes correctly; 0 console errors.
- Every route and every Settings/Models tab rendered with **0 console errors, 0 page
  errors, 0 HTTP errors, 0 request failures, 0 warnings**.
- Report: `final-smoke/report.json`; screenshots: `final-smoke/route-*.png`.

### Vision / image attachment

After downloading the Qwen2.5-VL 3B Instruct model and its `mmproj` projector, the chat was
switched to the vision runtime (`supportsVision: true`, `visionMode: mmproj`).

- Attach button enabled and accepted a PNG through the chat composer.
- The attached image rendered as a chat attachment chip.
- A chat message with the image attached produced a real assistant response (no errors).
- Server-side vision state: `supportsVision=true`, `mmproj=mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf`.

## Defects fixed in this pass

- Missing `isSD15OrCustom` value crashed the Image generation Settings tab.
- Sidebar brand lockup collided with the wordmark and header actions.
- Models search placeholder was clipped mid-word.
- Server banner still read “UNCENSORED AI STUDIO”.
- Vulkan out-of-memory left users at a dead end; added automatic CPU 512×512 fallback.
- Fallback sometimes missed the real error because backend stderr arrives in chunks; added
  a settle window and ignored bare `[ERROR]` fragments.
- Successful fallback was immediately overwritten back to 1024×1024 by model defaults,
  causing a ~20-minute CPU restart; constraints now mirror the loaded backend.
- CPU loads retained the previous `vulkan0` device label.
- Sidebar footer kept the GPU vendor prefix, wasting space and truncating the name
  (`Intel Iris Xe Gra…`); vendor prefixes are now stripped (`Iris Xe Graphics`).
- The top bar showed a long loaded-model pill (`Chat qwen2.5-coder-14b-instruct…`) plus an
  unload button; removed the pill so the bar holds only the theme controls.
- The chat thread bar showed a context-percentage ring plus a clear-chat delete icon; replaced
  with a clickable three-dot menu (`Chat thread actions`) whose **Clear chat** item works.
- The 1024px resolution option was disabled before a model was selected.

## Artifact locations

All paths above are under
`C:\Users\iHub\AppData\Local\Temp\opencode\pwtest\`.

Key files:

- `flows\ui-generated-final.png` — image generated through the UI after fallback
- `flows\final-chat2.png` — chat reply `MONAMI OK`
- `flows\final-transcribe-text.png` — transcript `Hello from Minami.`
- `flows\final-voice2.png` — new TTS output in history/player
- `flows\final-runtime2-report.json` — speech/TTS/chat results
- `flows\fallback-generate-report.json` — fallback + image generation results
- `audit4\report.json` — full route/tab audit
- `final-smoke\report.json` — final bundle route/tab/console audit

## Known limitations

- CPU image generation is slow on this hardware: ~4.5 minutes for 512×512 at 4 steps.
  Vulkan cannot fit the 6.5 GB DreamShaperXL checkpoint in the Intel Iris Xe's available
  device memory; fallback handles it automatically.
- Vite reports an informational chunk-size advisory (>500 kB). It has no runtime impact.
- No functional blockers remain.
