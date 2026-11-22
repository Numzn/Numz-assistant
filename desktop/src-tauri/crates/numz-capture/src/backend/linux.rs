//! Linux. On X11 the pictures are taken with read-only requests on the display (GetImage on the root window or on one window): nothing
//! is raised, focused or moved, and the X server shows nothing. On Wayland the desktop portal's Screenshot interface is used (through
//! `xcap`): the desktop itself decides whether to ask the person, and shows its own indicator if it does.

use crate::{classify, Backend, CaptureError, Modes, RgbaImage, Support, WindowInfo};

pub struct Native;

/// `wayland`, `x11` or `none`.
fn session() -> &'static str {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty()) || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"));
    let x11 = std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty());
    if wayland {
        "wayland"
    } else if x11 {
        "x11"
    } else {
        "none"
    }
}

fn fail<E: std::fmt::Display>(e: E) -> CaptureError {
    classify(&e.to_string())
}

impl Backend for Native {
    fn support(&self) -> Support {
        let session = session();
        let (modes, permission, note) = match session {
            "x11" => (Modes { screen: true, window: true, region: true, watch: true }, "granted", ""),
            "wayland" => (
                Modes { screen: true, window: false, region: true, watch: false },
                "prompt",
                "Your desktop may ask once for permission to take screenshots. Choosing a single window is not possible on Wayland.",
            ),
            _ => (Modes { screen: false, window: false, region: false, watch: false }, "unknown", "No graphical desktop session was found."),
        };
        Support { platform: "linux".into(), session: session.into(), modes, permission: permission.into(), note: note.into() }
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        if session() != "x11" {
            return Err(CaptureError::Unsupported("a window cannot be chosen from the list on this desktop session".into()));
        }
        let all = xcap::Window::all().map_err(fail)?;
        Ok(all
            .iter()
            .filter_map(|w| {
                if w.is_minimized().unwrap_or(true) {
                    return None;
                }
                let (width, height) = (w.width().ok()?, w.height().ok()?);
                let app = w.app_name().unwrap_or_default();
                let title = w.title().unwrap_or_default();
                // Some programs set no title: their name stands in for it. A window with neither is not worth offering.
                let title = if title.trim().is_empty() { app.clone() } else { title };
                if width < 80 || height < 60 || title.trim().is_empty() {
                    return None;
                }
                Some(WindowInfo { id: w.id().ok()?.to_string(), title, app, width, height })
            })
            .collect())
    }

    fn capture_screen(&self) -> Result<RgbaImage, CaptureError> {
        if session() == "none" {
            return Err(CaptureError::Unsupported("no graphical session".into()));
        }
        let monitors = xcap::Monitor::all().map_err(fail)?;
        let monitor = monitors.iter().find(|m| m.is_primary().unwrap_or(false)).or_else(|| monitors.first()).ok_or_else(|| CaptureError::Unsupported("no display found".into()))?;
        monitor.capture_image().map_err(fail)
    }

    fn capture_window(&self, id: &str) -> Result<RgbaImage, CaptureError> {
        if session() != "x11" {
            return Err(CaptureError::Unsupported("a window cannot be captured on this desktop session".into()));
        }
        let wanted: u32 = id.parse().map_err(|_| CaptureError::NoSuchWindow)?;
        let all = xcap::Window::all().map_err(fail)?;
        let window = all.iter().find(|w| w.id().ok() == Some(wanted)).ok_or(CaptureError::NoSuchWindow)?;
        if window.is_minimized().unwrap_or(false) {
            return Err(CaptureError::Failed("that window is minimized, so there is nothing to capture".into()));
        }
        window.capture_image().map_err(fail)
    }
}
