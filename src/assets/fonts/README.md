# Fonts

Latin subsets, self-hosted so the page needs no third-party stylesheet (and works offline). They are imported by
`@font-face` rules in `/style.css`, so the build gives them content hashes and the server caches them for a year.

| File | Family | Used for | Source |
|---|---|---|---|
| `inter-latin.woff2` | Inter (variable, 400-700) | interface text | fonts.gstatic.com, Google Fonts v20 |
| `instrument-serif-italic-latin.woff2` | Instrument Serif (italic 400) | the greeting | fonts.gstatic.com, Google Fonts v5 |
| `jetbrains-mono-latin.woff2` | JetBrains Mono (variable, 400-500) | timers, timestamps, the model label, code | fonts.gstatic.com, Google Fonts v24 |

All three families are licensed under the SIL Open Font License 1.1, which allows bundling and redistribution.
Text outside the Latin range falls back to the system font stack (`--font` in `style.css`).
