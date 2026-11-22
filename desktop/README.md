# NUMZ AI desktop app (Tauri)

NUMZ AI as a desktop application: **the NUMZ AI site in a native window, plus the native things a web page cannot do for itself.** The first of
those is Screenshot Intelligence ([`docs/screenshot-intelligence.md`](../docs/screenshot-intelligence.md)). The app has no screen of its own, no
second assistant and no second API: it opens `https://lab.numz.site/ai/` and answers the page's few native requests.

```
desktop/
  src-tauri/
    src/lib.rs, main.rs          the window; stays on the site (plus Google's sign-in page); registers the commands
    src/screenshot.rs            the five commands the page may call (status, windows, capture, export, discard)
    src/study.rs                 the five study-watcher commands (watch start, poll, pause, resume, stop) and the window title that says "screen reading ON"
    capabilities/default.json    WHO may call them: https://lab.numz.site/* and nothing else
    capabilities/dev-local.json  local testing only (http://127.0.0.1:*); NOT enabled unless a test build turns it on
    crates/numz-capture/         the capture library: one still per call, per-OS backends, encoding, in-memory holding, and the study watcher
                                 (change detection, exclusions, dead-man switch); no Tauri in it
  shell/index.html              the offline notice (shown only if the site cannot be reached)
  e2e/                          the real-app end-to-end runs (screenshots; the study watcher) and the access check
  scripts/verify-linux-x11.sh   the native-capture check against a real X server
```

## How a screenshot is taken

| Mode | What happens |
|---|---|
| Full screen | the primary display is captured once |
| Area | the primary display is captured once, then the person drags on the **preview inside the app**; only that part is exported. Nothing is drawn on the desktop, nothing is dimmed or frozen |
| Window | the person picks from the list of windows in the app; that one window is captured |

The capture is held in memory (two at a time, five minutes), shown as a small preview, and exported (cropped, scaled to at most 2048 px, JPEG) only
when the person presses **Analyse**. Nothing is written to disk.

| Platform | Interface used | Permission |
|---|---|---|
| Windows | Windows Graphics Capture (`windows-capture`); the system's border and cursor defaults are left alone | none; Windows may outline what is captured |
| macOS | ScreenCaptureKit `SCScreenshotManager` (`objc2-screen-capture-kit`), macOS 14+ | the system asks for Screen Recording itself and shows its own indicator |
| Linux X11 | read-only X requests (`GetImage`) through `xcap` | none |
| Linux Wayland | the desktop portal's Screenshot interface through `xcap` | the desktop asks, and shows its own indicator |

### What it never does

No simulated keys, mouse movement or clicks; no focus change or raising of a window; no pointer movement; no overlay, dimming or frozen desktop; no
sound, no notification; no video, no recording, no continuous capture. `src-tauri/crates/numz-capture/tests/no_input.rs` fails the build if any API
that could (`SendInput`, `CGEventPost`, `XTest`, `XSetInputFocus`, `SetForegroundWindow`, `uinput`, `RemoteDesktop`, `enigo`, video recorders,
notification and audio crates, ...) appears anywhere in the desktop layer's source or the capture crate's dependencies.

## The study watcher (Academic Intelligence)

A study session in the page can ask the app to **watch the screen** ([`docs/academic-intelligence.md`](../docs/academic-intelligence.md)).
It is the local half of "hybrid" reading: the app decides *whether* anything is worth reading; the server only ever sees pictures that passed.

| Rule | How |
|---|---|
| One still at a time, never video | every 1.5–30 s (default 2.5 s) the primary display is captured once and reduced to a 32×18 luminance signature |
| Only changes, and only once they settle | a picture is reported when the signature has changed and then stayed stable; at least 10 s between reported pictures |
| **Exclusions come first** | if a password manager, a sign-in / verification / private-browsing window, or any app or title the person listed is open, **no picture is taken at all** (a picture of the screen cannot have a window cut out of it, so the rule is applied before capture) |
| Visible | while watching, the window title reads "NUMZ AI - study session, screen reading ON" (paused: "...paused") |
| Dead-man switch | if the page does not collect results for 20 s, the watcher stops by itself and the title goes back |
| Windows must be listable | it starts only where windows can be listed (X11, Windows, macOS). On **Wayland it is not offered** |
| Held in memory | the picture is handed to the page once, sent, and discarded; nothing is written to disk |

The five commands (`screenshot_watch_start/poll/pause/resume/stop`) are covered by the same two guards as the screenshot ones (Tauri capability for
`https://lab.numz.site/*` only, and a per-command origin check). Like everything else here they are never allowed to simulate input or move focus.


## Trust

The page is remote, so the commands are guarded twice: Tauri's capability (`capabilities/default.json`) lets **only** `https://lab.numz.site/*`
call them, and each command re-checks that the calling window is `main` and shows a page of the trusted origin. The window refuses to navigate
anywhere else (only `accounts.google.com` is allowed, for signing in, and it cannot call the commands). A release build always opens the real
site; only a debug build honours `NUMZ_AI_URL` (for trying the app against a copy of the site).

## Build, run, test

Needs Rust (rustup) and, on Linux, `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libxdo-dev libayatana-appindicator3-dev
libdbus-1-dev libxcb1-dev libxcb-randr0-dev libxcb-shm0-dev libxcb-xfixes0-dev libpipewire-0.3-dev libgbm-dev libegl-dev libwayland-dev
libdrm-dev libclang-dev pkg-config build-essential`.

```bash
cd desktop/src-tauri
cargo test --workspace                       # unit tests + the no-input source scan
cargo build                                  # a debug app: target/debug/numz-ai-desktop (opens the real site)
cargo install tauri-cli --locked && cargo tauri build   # installers (see "Not done" below)
```

**Capture check against a real X server** (Xvfb, openbox, two GTK windows, a real pointer): confirms the right pixels come back and that the
active window, focus, pointer position and window stacking are unchanged.

```bash
cd desktop/src-tauri/crates/numz-capture && cargo build --example shot && cd ../../.. && ./scripts/verify-linux-x11.sh
```

**The real app, end to end** (the real app in a real X session, the real NUMZ AI server, a stand-in vision provider that decodes the picture it is
sent): needs `tauri-driver`, `WebKitWebDriver`, Xvfb, openbox, xdotool, ImageMagick and `python3-gi`.

```bash
cargo install tauri-driver --locked
cd desktop/src-tauri
TAURI_CONFIG='{"app":{"security":{"capabilities":["numz-ai-site","numz-ai-dev-local"]}}}' cargo build   # the test build
cd ../.. && node desktop/e2e/run.mjs                              # 26 checks: screenshots
node desktop/e2e/study.mjs                                        # 23 checks: the study watcher, signed in through the real broker
# and, with an app built WITHOUT that config:
NUMZ_DESKTOP_BIN=<default build> node desktop/e2e/acl-check.mjs   # all ten commands are refused for any other address
```

`study.mjs` additionally needs numzlab-auth's test rig (`NUMZLAB_AUTH_DIR`, default `/srv/infrastructure/auth`): Academic Intelligence only works for a
signed-in person. The app only ever navigates to the site (and Google's own sign-in page), so it cannot walk through the rig's pretend Google: the
run signs in through the real broker with a cookie jar and hands the session cookie to the app's window, as a browser that had signed in would have it.

The run serves the page over plain http, and WebKit (unlike Chromium) obeys the site's `upgrade-insecure-requests`, so the run points the app at a
small proxy that removes that one directive. The real site is https and needs no such thing.

## Status

| | Status |
|---|---|
| Linux X11 | **Verified here** on Xvfb + openbox: native capture 16/16, screenshots end to end 26/26, **study watcher end to end 23/23**, access check 11/11, `cargo test --workspace` |
| Linux Wayland | Written (portal Screenshot); **not run** (no Wayland session or portal on this machine). Window capture is not offered there, and **the study watcher is not offered** |
| Windows | Written (Windows Graphics Capture); the capture crate (including the watcher) **type-checks** for `x86_64-pc-windows-msvc`; **never run**. The app crate cannot be cross-checked on this host (needs the Windows resource compiler) |
| macOS | Written (ScreenCaptureKit); the capture crate **type-checks** for `aarch64-apple-darwin`; **never run**; macOS 14+. The app crate cannot be cross-checked here (needs Apple's toolchain) |

## Limits and things not done

* **Never run on Windows or macOS, or on Wayland.** Those backends compile, but nobody has taken a picture with them. Treat them as unverified. That
  includes the **window listing the watcher's exclusions depend on**: if a backend lists windows wrongly, an excluded window could be missed. Until
  it has been run on Windows and macOS, do not rely on the exclusions there.
* **Permission denial** was exercised in the page logic (unit tests with the native error) and in the error mapping (`classify`), not against a real
  operating-system prompt: X11 has none, and Windows/macOS/Wayland were not available.
* **X11 without a compositing manager:** the part of a window that another window covers cannot be read back (the X server keeps no copy). A
  compositing desktop (GNOME, KDE, XFCE with compositing) is not affected. The check windows are laid out so none is covered.
* **Primary display only.** There is no multi-monitor picker yet.
* **Signing in inside the app window is untested.** The site uses Google sign-in through NUMZLAB; Google may refuse to sign in from an embedded
  web view. If it does, the answer is a system-browser sign-in handed back to the app (a small, separate piece of work: it needs a registered
  return address).
* **No installers.** `cargo tauri build` has not been run; the icons are placeholders and there is no macOS `.icns`, no code signing or
  notarization, no auto-update.
* An area is chosen by dragging, so it needs a pointer; **Use the whole picture** is the keyboard route.
* The study watcher judges "an excluded window is open" from the **window list**, which does not know about a window that is minimised behind
  another, a second monitor (the primary display only is captured), or a title the person did not think to list. It errs towards not reading.
* The features reach the app's users only once the new site is deployed: the app opens the live site, which does not have them yet.
