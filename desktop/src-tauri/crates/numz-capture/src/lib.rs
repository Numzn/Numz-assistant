//! Native screenshots for NUMZ AI.
//!
//! One still picture per request, taken through the operating system's own capture interface:
//!
//! | platform | interface |
//! |----------|-----------|
//! | Windows  | Windows Graphics Capture (the system's own border and cursor defaults are left as they are) |
//! | macOS    | ScreenCaptureKit (`SCScreenshotManager`, macOS 14 or later); the system asks for Screen Recording permission itself |
//! | Linux    | X11: read-only requests on the display. Wayland: the desktop portal's Screenshot interface (the desktop asks the person) |
//!
//! What this crate never does, anywhere: send a key or a mouse event, move the pointer, raise or focus a window, draw on the desktop,
//! dim or freeze it, play a sound, show a notification, record video or keep capturing. A request takes one picture and returns.
//! `tests/no_input.rs` checks the source for every API that could.
//!
//! The picture stays in memory ([`held::Held`]), is handed to the page as a small preview, and is exported (cropped, scaled, JPEG)
//! only when the person asks for it to be analysed.

pub mod detect;
pub mod encode;
pub mod exclusion;
pub mod held;
pub mod watch;

mod backend;

pub use backend::native_backend;
pub use image::RgbaImage;
use serde::Serialize;

/// A window that can be captured, as the person sees it in the list.
#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub app: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Modes {
    pub screen: bool,
    pub window: bool,
    /// A region is a crop of a whole-screen capture, chosen on the preview inside the app: always available when `screen` is.
    pub region: bool,
    /// Automatic capture during a study session is possible: the screen can be looked at on a timer AND the open windows can be listed, so
    /// excluded ones are respected. Never true where the windows cannot be listed (Wayland).
    pub watch: bool,
}

/// What this desktop session can do, and whether the system will allow it.
#[derive(Debug, Clone, Serialize)]
pub struct Support {
    pub platform: String,
    /// `windows`, `macos`, `x11`, `wayland` or `none` (no graphical session found).
    pub session: String,
    pub modes: Modes,
    /// `granted`, `denied`, `prompt` (the system will ask when the first picture is taken) or `unknown`.
    pub permission: String,
    /// A sentence for the person, when there is something they should know (an indicator the system shows, a limit).
    pub note: String,
}

/// Why a capture did not happen. `code()` is the stable name the page acts on.
#[derive(Debug, Clone)]
pub enum CaptureError {
    PermissionDenied,
    Unsupported(String),
    Cancelled,
    NoSuchWindow,
    Failed(String),
    Busy,
    Expired,
    InvalidRegion,
}

impl CaptureError {
    pub fn code(&self) -> &'static str {
        match self {
            CaptureError::PermissionDenied => "permission-denied",
            CaptureError::Unsupported(_) => "unsupported",
            CaptureError::Cancelled => "cancelled",
            CaptureError::NoSuchWindow => "no-such-window",
            CaptureError::Failed(_) => "capture-failed",
            CaptureError::Busy => "busy",
            CaptureError::Expired => "expired",
            CaptureError::InvalidRegion => "invalid-region",
        }
    }

    /// Words fit for a log. Never shown to the person as they are: the page has its own wording for each code.
    pub fn detail(&self) -> String {
        match self {
            CaptureError::Unsupported(why) | CaptureError::Failed(why) => why.clone(),
            other => other.code().to_string(),
        }
    }
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.detail())
    }
}

impl std::error::Error for CaptureError {}

impl Serialize for CaptureError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("CaptureError", 2)?;
        s.serialize_field("code", self.code())?;
        // A message of our own, not the operating system's words (they can carry paths and window titles).
        s.serialize_field("message", self.code())?;
        s.end()
    }
}

/// One platform's way of taking a picture. Every method is read-only with respect to the desktop.
pub trait Backend: Send + Sync {
    fn support(&self) -> Support;
    fn windows(&self) -> Result<Vec<WindowInfo>, CaptureError>;
    /// The whole primary display.
    fn capture_screen(&self) -> Result<RgbaImage, CaptureError>;
    fn capture_window(&self, id: &str) -> Result<RgbaImage, CaptureError>;
}

/// Maps the words of an operating-system error to what it means for the person.
#[allow(dead_code)] // used by the Linux backend; the other platforms report their errors directly
pub(crate) fn classify(message: &str) -> CaptureError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("cancel") || lower.contains("dismiss") {
        CaptureError::Cancelled
    } else if lower.contains("denied") || lower.contains("not allowed") || lower.contains("not authorized") || lower.contains("permission") || lower.contains("declined") {
        CaptureError::PermissionDenied
    } else {
        CaptureError::Failed(message.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operating_system_words_are_classified() {
        assert_eq!(classify("The user cancelled the request").code(), "cancelled");
        assert_eq!(classify("Permission denied by portal").code(), "permission-denied");
        assert_eq!(classify("the user declined to share").code(), "permission-denied");
        assert_eq!(classify("device lost").code(), "capture-failed");
    }

    #[test]
    fn errors_serialize_with_a_code_and_no_system_words() {
        let json = serde_json::to_string(&CaptureError::Failed("/home/someone/secret path".into())).unwrap();
        assert!(json.contains("\"code\":\"capture-failed\""));
        assert!(!json.contains("secret"), "the operating system's words never leave the native layer: {json}");
    }
}
