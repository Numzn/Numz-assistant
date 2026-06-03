# Audio test phrases (manual regression)

Use with local audio pipeline (`audioMode: local`, `STT_BACKEND=local`). Score **pass** if transcript is usable for the intended command without manual correction of core nouns/numbers.

| # | Phrase | Expected intent | Pass | Notes |
|---|--------|-----------------|------|-------|
| 1 | NUMZ status | Wake + status query | | |
| 2 | Hello NUMZ show fleet summary | Wake prefix + query | | |
| 3 | Show tracker seven | Tracker lookup | | |
| 4 | Where is unit forty two | Unit ID (42) | | |
| 5 | Immobilize vehicle twelve | Immobilization command | | |
| 6 | Release immobilization for truck three | Release command | | |
| 7 | Fuel anomaly on unit nine | Analytics query | | |
| 8 | Send notification to dispatch | Notification action | | |
| 9 | List active alarms | Telemetry / alarms | | |
| 10 | NUMZFLEET dashboard | Proper noun NUMZFLEET | | |
| 11 | Yes | Short confirmation | VAD may trim hard | |
| 12 | Stop | One-word command | | |
| 13 | Cancel | One-word command | | |
| 14 | Repeat last message | Meta command | | |
| 15 | What is the speed of unit five | Numeric + unit | | |
| 16 | (silence 3s, release mic) | no-speech | Should not send LLM | |
| 17 | (mumble / breath only) | no-speech or empty | | |
| 18 | Background TV noise 30s armed wake | False accept test | Should not trigger | |
| 19 | NUMZ (only wake word, no command) | Re-arm or short prompt | | |
| 20 | NUMZ immobilize unit seven now | Full wake + command | Strip "numz" before LLM | |

## Scoring

- **Target:** ≥ 17/20 pass (85%) on phrases 1–15 and 20.
- **Silence cases (16–17):** must not produce hallucinated LLM turns.
- **False accept (18):** ≤ 1 trigger in 5 minutes armed idle.
