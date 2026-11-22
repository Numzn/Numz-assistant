#!/usr/bin/env bash
# Verifies the Linux (X11) capture backend against a real X server: Xvfb with the openbox window manager, two real windows, a real pointer.
#
#   desktop/scripts/verify-linux-x11.sh [path to the built `shot` example]
#
# It checks that full-screen and single-window capture return the right pixels, and that taking them leaves the active window, the keyboard
# focus, the pointer position and the window stacking exactly as they were, and maps no new window. xdotool is used ONLY here, to set the
# scene and to look at the result; the app and the capture crate contain no input code (tests/no_input.rs).
set -uo pipefail
SHOT="${1:-$(dirname "$0")/../src-tauri/crates/numz-capture/target/debug/examples/shot}"
OUT="$(mktemp -d)"
DISPLAY_NUM=":77"
pass=0; fail=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1  ${2:-}"; fail=$((fail+1)); }
cleanup() { kill ${PIDS:-} 2>/dev/null; wait 2>/dev/null; rm -rf "$OUT"; }
trap cleanup EXIT

Xvfb "$DISPLAY_NUM" -screen 0 1600x900x24 -nolisten tcp >/dev/null 2>&1 & PIDS="$!"
export DISPLAY="$DISPLAY_NUM"
for _ in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
xdpyinfo >/dev/null 2>&1 || { echo "no X server"; exit 1; }
openbox >/dev/null 2>&1 & PIDS="$PIDS $!"
sleep 1

xmessage -title NUMZ-TARGET -geometry 500x300+100+100 -bg '#ff3300' -fg '#ff3300' "target" >/dev/null 2>&1 & PIDS="$PIDS $!"
xmessage -title NUMZ-OTHER  -geometry 400x250+700+300 -bg '#0033ff' -fg '#0033ff' "other"  >/dev/null 2>&1 & PIDS="$PIDS $!"
for _ in $(seq 1 50); do xdotool search --name NUMZ-TARGET >/dev/null 2>&1 && xdotool search --name NUMZ-OTHER >/dev/null 2>&1 && break; sleep 0.1; done
TARGET="$(xdotool search --name NUMZ-TARGET | head -1)"; OTHER="$(xdotool search --name NUMZ-OTHER | head -1)"
sleep 0.8; xdotool windowfocus "$OTHER" 2>/dev/null; xdotool mousemove 1234 567; sleep 0.7

snapshot() {
  echo "focus=$(xdotool getwindowfocus) active=$(xdotool getactivewindow 2>/dev/null) mouse=$(xdotool getmouselocation)"
  echo "stacking=$(xprop -root _NET_CLIENT_LIST_STACKING)"
  echo "tree=$(xwininfo -root -tree | grep -c 'x[0-9]*+')"
  echo "mapped=$(xwininfo -root -tree | grep -E '^ +0x' | awk '{print $1}' | sort | tr '\n' ' ')"
}
BEFORE="$(snapshot)"
echo "---- before ----"; echo "$BEFORE"

echo "---- support / windows ----"
"$SHOT" support
"$SHOT" windows | tee "$OUT/windows.txt"
grep -qE "NUMZ-TARGET|Xmessage" "$OUT/windows.txt" && ok "the window list names the real windows" || bad "window list"

start=$(date +%s%N)
"$SHOT" screen "$OUT/screen.png" >"$OUT/screen.txt" 2>&1 && ok "full-screen capture returned ($(cat "$OUT/screen.txt"))" || bad "full-screen capture" "$(cat "$OUT/screen.txt")"
echo "full-screen capture took $(( ($(date +%s%N) - start) / 1000000 )) ms"
"$SHOT" window "$TARGET" "$OUT/window.png" >"$OUT/window.txt" 2>&1 && ok "single-window capture returned ($(cat "$OUT/window.txt"))" || bad "window capture" "$(cat "$OUT/window.txt")"
"$SHOT" window "$OTHER" "$OUT/other-window.png" >/dev/null 2>&1 && ok "a window that is not in front can be captured too" || bad "second window capture"

AFTER="$(snapshot)"
echo "---- after ----"; echo "$AFTER"
[ "$BEFORE" = "$AFTER" ] && ok "the active window, focus, pointer position, window stacking and window tree are unchanged" || { bad "the desktop changed"; diff <(echo "$BEFORE") <(echo "$AFTER"); }
FOC="$(xdotool getwindowfocus)"; [ "$FOC" = "$(echo "$BEFORE" | head -1 | sed 's/.*focus=\([0-9]*\).*/\1/')" ] && ok "keyboard focus is still where it was ($FOC)" || bad "focus moved"
echo "$AFTER" | head -1 | grep -q "x:1234 y:567" && ok "the pointer is exactly where it was (1234,567)" || bad "pointer moved"

pixel() { convert "$1" -crop 1x1+"$2"+"$3" +repage -depth 8 txt:- | tail -1 | grep -o '#[0-9A-F]\{6\}' | head -1; }
W=$(pixel "$OUT/window.png" 100 100); [ "$W" = "#FF3300" ] && ok "the window picture holds the window's real pixels ($W)" || bad "window pixels" "$W"
O=$(pixel "$OUT/other-window.png" 100 100); [ "$O" = "#0033FF" ] && ok "and the other window's ($O)" || bad "other window pixels" "$O"
SW=$(identify -format '%w' "$OUT/screen.png"); SH=$(identify -format '%h' "$OUT/screen.png")
[ "$SW" = "1600" ] && [ "$SH" = "900" ] && ok "the screen picture is the whole 1600x900 display" || bad "screen size" "${SW}x${SH}"
S=$(pixel "$OUT/screen.png" 300 300); [ "$S" = "#FF3300" ] && ok "the screen picture shows the target window where it is on the desktop ($S)" || bad "screen pixels" "$S"
S2=$(pixel "$OUT/screen.png" 850 420); [ "$S2" = "#0033FF" ] && ok "and the other window ($S2)" || bad "screen pixels 2" "$S2"

echo "---- failure handling ----"
"$SHOT" window 99999999 "$OUT/none.png" >"$OUT/none.txt" 2>&1; grep -q "no-such-window" "$OUT/none.txt" && ok "a window that does not exist is reported as such" || bad "no-such-window" "$(cat "$OUT/none.txt")"
"$SHOT" window not-a-number "$OUT/none.png" >"$OUT/none2.txt" 2>&1; grep -q "no-such-window" "$OUT/none2.txt" && ok "a malformed window id is refused" || bad "bad id" "$(cat "$OUT/none2.txt")"
DISPLAY= WAYLAND_DISPLAY= XDG_SESSION_TYPE=tty "$SHOT" screen "$OUT/none.png" >"$OUT/none3.txt" 2>&1; grep -q "unsupported" "$OUT/none3.txt" && ok "with no graphical session the answer is 'unsupported', not a crash" || bad "no session" "$(cat "$OUT/none3.txt")"
kill "$TARGET" 2>/dev/null; xdotool windowclose "$TARGET" 2>/dev/null; sleep 0.5
"$SHOT" window "$TARGET" "$OUT/none.png" >"$OUT/none4.txt" 2>&1; grep -q "no-such-window" "$OUT/none4.txt" && ok "a window closed after it was listed is reported as gone" || bad "closed window" "$(cat "$OUT/none4.txt")"

echo "---- $pass passed, $fail failed ----"
[ "$fail" = 0 ]
