# Audio stabilization run sheet

Date: __________  
Machine: __________  
Whisper model: __________  
Porcupine sensitivity: __________  

## Prerequisites

- [ ] `ffmpeg -version` OK
- [ ] `npm run dev:audio` — `curl http://127.0.0.1:8765/health` → `{ "ok": true }`
- [ ] `npm run dev:api` + `npm run dev`
- [ ] `.env`: `STT_BACKEND=local`
- [ ] Picovoice assets in `public/porcupine/` (if testing wake)

---

## A. End-to-end (E2E)

| ID | Test | Pass | Notes |
|----|------|------|-------|
| E2E-1 | Health + three processes up | | |
| E2E-2 | Hold mic → command → TTS → idle | | |
| E2E-3 | Wake → NUMZ + command → reply | | |
| E2E-4 | Page refresh → E2E-2 again | | |
| E2E-5 | Kill Python → hold mic → offline message | | |
| E2E-6 | Restart Python → E2E-2 without refresh | | |

### Golden timing (one short command)

| Milestone | ms |
|-----------|-----|
| Record stop → transcript | |
| Transcript → TTS start | |
| Full turn | |

---

## B. Wake (W-1–W-8)

| ID | Pass | Notes |
|----|------|-------|
| W-1 Clean wake | | |
| W-2 False accept 5 min | | |
| W-3 Miss rate 10 tries | | |
| W-4 Double wake | | Busy or single turn |
| W-5 Wake during TTS | | No loop |
| W-6 Wake during LLM | | Busy message |
| W-7 Hold mic while armed | | Wake disarms |
| W-8 Missing .ppn | | Clear setup msg |

---

## C. VAD (V-1–V-5)

Record `durationMs`, `vadTrimmedMs`, `vadMs`, `whisperMs` from response or logs.

| ID | Pass | vadTrimmed/duration |
|----|------|---------------------|
| V-1 Short "yes" | | |
| V-2 Long mid-pause sentence | | |
| V-3 Noisy environment | | |
| V-4 Trailing silence | | |
| V-5 Wake word in clip | | Keyword stripped in UI transcript |

---

## D. STT latency / accuracy

| Clip length | p50 transcribe ms | p95 ms |
|-------------|-------------------|--------|
| ~3s | | |
| ~5s | | |
| ~10s | | |

Run [audio-test-phrases.md](./audio-test-phrases.md): _____ / 20 pass.

---

## E. State recovery (S-1–S-8)

| ID | End state IDLE? | Pass |
|----|-----------------|------|
| S-1 Success turn | | |
| S-2 no-speech | | |
| S-3 Sidecar offline | | |
| S-4 LLM error | | |
| S-5 TTS error | | |
| S-6 Interrupt (if available) | | |
| S-7 API down at init | | |
| S-8 Stream force states | | |

---

## F. Failures

| Failure | UI message clear? | Recovers to idle? | Pass |
|---------|-----------------|-------------------|------|
| Sidecar offline | | | |
| Empty / no-speech | | | |
| Mic denied | | | |
| Busy overlap | | | |
| Double capture | Already listening | | |

---

## Sign-off

- [ ] 10 consecutive E2E turns without refresh
- [ ] ≥ 85% on 20-phrase list
- [ ] All failure rows pass
- [ ] No silent drops on busy / double-wake
- [ ] Porcupine sensitivity note: __________

**Signed off:** __________
