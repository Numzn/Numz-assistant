//! Screenshot Intelligence takes pictures and does nothing else to the desktop. This test reads the source of the whole desktop layer
//! (the capture crate and the Tauri app) and fails if any API that could send keys or mouse events, move the pointer, change focus or
//! raise a window, play a sound or show a notification is named anywhere outside this test.

use std::fs;
use std::path::{Path, PathBuf};

/// Names of APIs and crates that synthesise input or disturb the desktop, per platform.
const FORBIDDEN: &[&str] = &[
    // cross-platform input libraries
    "enigo", "rdev", "autopilot", "robotjs", "mouse_position::set", "inputbot",
    // Windows
    "SendInput", "keybd_event", "mouse_event", "SetCursorPos", "SetForegroundWindow", "SetFocus(", "BringWindowToTop", "SetActiveWindow", "ShowWindow(", "FlashWindow", "MessageBeep", "PlaySound",
    // macOS
    "CGEventCreate", "CGEventPost", "CGWarpMouseCursorPosition", "CGDisplayMoveCursorToPoint", "NSSound", "NSUserNotification", "UNUserNotificationCenter",
    // X11
    "XTestFake", "xtest", "XWarpPointer", "warp_pointer", "XSetInputFocus", "set_input_focus", "XRaiseWindow", "XMapRaised", "configure_window", "send_event", "XSendEvent", "SetInputFocus",
    // Wayland / D-Bus / Linux
    "uinput", "wtype", "ydotool", "xdotool", "libei", "RemoteDesktop", "notify-rust", "Notification::new",
    // video: this is a screenshot feature
    "video_recorder", "VideoRecorder", "VideoEncoder",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if name != "target" && name != "node_modules" && name != "gen" {
                rust_files(&path, out);
            }
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
}

#[test]
fn nothing_in_the_desktop_layer_can_send_input_or_disturb_the_desktop() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = here.ancestors().nth(2).expect("src-tauri"); // crates/numz-capture -> src-tauri
    let mut files = Vec::new();
    rust_files(root, &mut files);
    assert!(files.len() >= 6, "the scan found too few files ({}): {root:?}", files.len());
    let this = here.join("tests").join("no_input.rs");
    let mut hits = Vec::new();
    for file in files.into_iter().filter(|f| *f != this) {
        let text = fs::read_to_string(&file).unwrap_or_default();
        for (n, line) in text.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            for word in FORBIDDEN {
                if code.contains(word) {
                    hits.push(format!("{}:{}: {word}", file.strip_prefix(root).unwrap_or(&file).display(), n + 1));
                }
            }
        }
    }
    assert!(hits.is_empty(), "forbidden APIs in the desktop layer:\n{}", hits.join("\n"));
}

#[test]
fn the_dependency_list_has_no_input_or_recording_crates() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(here.join("Cargo.toml")).unwrap();
    for name in ["enigo", "rdev", "autopilot", "inputbot", "notify-rust", "rodio", "cpal"] {
        assert!(!manifest.contains(name), "{name} must not be a dependency of the capture crate");
    }
}
