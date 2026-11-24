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
  shell/index.html              a placeholder page the build needs (nothing shows it: if the site cannot be reached, the web view's own error page appears, with Refresh)
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
| Windows | the screen: **Desktop Duplication** (DXGI, no outline), falling back to Windows Graphics Capture; a window: Windows Graphics Capture (`windows-capture`) | none; Windows outlines a *window* while it is captured unless the app is allowed under Settings > Privacy & security > Screenshot borders |
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
| One still at a time, never video | a look every 1.5–30 s (default 2.5 s): the open windows are listed and, only if none is excluded, the primary display is captured once and reduced to a brightness plane |
| Only changes, and only once they settle | blocks of the plane are compared with the last *reported* screen by the sum of absolute differences, so one changed digit, word or token of code counts; a picture is reported when a difference has stayed the same across two looks; at least 10 s between reported pictures |
| Things that move by themselves | a blinking caret or a ticking clock is learned per tile and ignored; a real edit, even repeated, is not |
| **This app's own window is left out** | its position is reported by the backend and its area is masked in the *comparison* only (the picture is whole): what NUMZ AI shows about the session cannot make the screen look new |
| **Exclusions come first** | if a password manager, a sign-in / verification / private-browsing window, or any app or title the person listed is open, **no picture is taken at all** (a picture of the screen cannot have a window cut out of it, so the rule is applied before capture) |
| Visible | while watching, the window title reads "NUMZ AI - study session, screen reading ON" (paused: "...paused") |
| Dead-man switch | if the page does not collect results for 20 s, the watcher stops by itself and the title goes back |
| Windows must be listable | it starts only where windows can be listed (X11, Windows, macOS). On **Wayland it is not offered** |
| Held in memory | the picture is handed to the page once, sent, and discarded; nothing is written to disk |
| No bypassing | it uses the operating system's ordinary capture; a protected window or a permission the system refuses stays refused |

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
TAURI_CONFIG='{"app":{"security":{"capabilities":["numz-ai-site","numz-ai-dev-local"]}},"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}' cargo build   # the test build
cd ../.. && node desktop/e2e/run.mjs                              # 26 checks: screenshots
node desktop/e2e/study.mjs                                        # the study watcher end to end, signed in through the real broker
node desktop/e2e/update.mjs                                       # the update line: offered, put away, refused when not signed by the app's own key, accepted when it is (needs the test build below)
node desktop/e2e/layout.mjs                                       # the Study/Meeting dock and the conversation at 1280/1000/800/720px, in the app's own WebKit (19 checks)
# and, with an app built WITHOUT that config:
NUMZ_DESKTOP_BIN=<default build> node desktop/e2e/acl-check.mjs   # all of them (the twelve above and the updater plugin's own) are refused for any other address
```

`study.mjs` additionally needs numzlab-auth's test rig (`NUMZLAB_AUTH_DIR`, default `/srv/infrastructure/auth`): Academic Intelligence only works for a
signed-in person. The app only ever navigates to the site (and Google's own sign-in page), so it cannot walk through the rig's pretend Google: the
run signs in through the real broker with a cookie jar and hands the session cookie to the app's window, as a browser that had signed in would have it.

The run serves the page over plain http, and WebKit (unlike Chromium) obeys the site's `upgrade-insecure-requests`, so the run points the app at a
small proxy that removes that one directive. The real site is https and needs no such thing.

## Status

| | Status |
|---|---|
| Linux X11 | **Verified here** on Xvfb + openbox: native capture 16/16, screenshots end to end 26/26, **study watcher end to end 29/29**, access check 11/11, `cargo test --workspace` |
| Linux Wayland | Written (portal Screenshot); **not run** (no Wayland session or portal on this machine). Window capture is not offered there, and **the study watcher is not offered** |
| Windows | Built and tested on **GitHub's Windows machine** (`.github/workflows/desktop-windows.yml`): the Rust workspace tests pass there (28), the installer builds, the app starts and opens its window, and the capture code took a **real full-screen picture and a real window picture** (the app's own window) of that machine's desktop. Measured there: Windows Graphics Capture draws a yellow outline at the screen edge (5 500+ yellow pixels in a 4 px band) and ignores a request for none unless the app is allowed in Settings (it answered *denied by user*); Desktop Duplication drew **none** (0 pixels), so the screen is taken that way. **Not verified:** loading the live site (GitHub's machines cannot reach it), Google sign-in inside the window, the watcher, the area mode, Windows 10, a real person's PC. The installer is **unsigned** (SmartScreen warns) |
| macOS | Written (ScreenCaptureKit); the capture crate **type-checks** for `aarch64-apple-darwin`; **never run**; macOS 14+. The app crate cannot be cross-checked here (needs Apple's toolchain) |

## Limits and things not done

* **Never run on macOS or Wayland, and run on Windows only in the limited way above.** Those backends compile, but nobody has taken a picture with them. Treat them as unverified. That
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


## Updates (the update line)

An installed app finds out for itself when a newer version is published and shows **one thin line at the top of its window**: "A new version of NUMZ AI is
ready (0.2.1, you have 0.2.0). **Update now** · Not now". Nothing is downloaded or installed until the person presses *Update now*; the app then downloads
it, checks its signature, installs it and opens the new version (Windows: the installer runs passively, with a progress bar and no questions). *Not now* puts
the line away for that version until the app is started again. A browser has no line: only the desktop app can update itself.

* **Where the app asks:** `plugins.updater.endpoints` in `tauri.conf.json`: `https://github.com/Numzn/Numz-assistant/releases/latest/download/latest.json`, the list
  of versions attached to the newest GitHub release. It looks 15 seconds after the window opens and then every 6 hours; offline, it stays quiet.
* **What it will install:** only a download signed with the **update key**. Its public half is `plugins.updater.pubkey` in `tauri.conf.json` (every installed app
  carries it); the private half is on the machine that publishes (`~/.numz-updater/updater.key`, password in `updater.password`, a copy under
  `/srv/backups/manual/numz-updater-20261124/`). **It is never given to GitHub.** If the private key is lost, installed apps can no longer be updated and must be
  installed by hand once more, with a new key in a new build: keep the backup.
* **The commands** (`app_update_check`, `app_update_install`, in `src/update.rs`) are allowed for the NUMZ AI site only, like the screenshot commands, and
  refuse any other page (`desktop/e2e/acl-check.mjs`).

### Publishing an update

1. Raise `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (a version that is not higher than the one installed is not offered).
2. Build the installer on GitHub's Windows machine: Actions → "Desktop app (Windows)" → Run workflow (on the branch with the change), then download the artifact.
3. Sign it and write the list of versions, on the machine that has the key:
   `node desktop/scripts/prepare-update-release.mjs <the installer.exe> <version> [notes.txt] [out-dir]`. It signs, checks the signature against the public key in
   `tauri.conf.json` (so a list an app would refuse is never made) and prints the `gh release create ...` command that publishes the three files.
4. Publish that release (it becomes the "latest" one, which is where installed apps look). Installed apps offer it at their next look.

The very first build with an update line (0.2.0) has to be installed by hand once; the 0.1.0 installers already out there have no update line and cannot be updated.
The installer is still not code-signed for Windows (SmartScreen warns on a first install), which is a different thing from the update key.
