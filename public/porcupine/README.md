# Porcupine wake word assets

Download from [Picovoice Console](https://console.picovoice.ai/):

1. Create a custom wake word (e.g. **numz**).
2. Export for **Web (WASM)**.
3. Place files here, for example:
   - `numz_en_wasm_v3_0_0.ppn` (keyword)
   - `porcupine_params_en.pv` (model) — often shared across keywords

Set in `.env`:

```
VITE_PICOVOICE_ACCESS_KEY=your_key
VITE_PORCUPINE_KEYWORD_PUBLIC_PATH=/porcupine/numz_en_wasm_v3_0_0.ppn
VITE_PORCUPINE_MODEL_PUBLIC_PATH=/porcupine/porcupine_params_en.pv
```

Without these files, local wake mode is unavailable (hold-to-talk still works).
