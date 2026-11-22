use crate::{Backend, CaptureError, Modes, RgbaImage, Support, WindowInfo};

pub struct Native;

impl Backend for Native {
    fn support(&self) -> Support {
        Support {
            platform: std::env::consts::OS.to_string(),
            session: "none".into(),
            modes: Modes { screen: false, window: false, region: false, watch: false },
            permission: "unknown".into(),
            note: "Screenshots are not supported on this operating system.".into(),
        }
    }
    fn windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        Err(CaptureError::Unsupported("unsupported operating system".into()))
    }
    fn capture_screen(&self) -> Result<RgbaImage, CaptureError> {
        Err(CaptureError::Unsupported("unsupported operating system".into()))
    }
    fn capture_window(&self, _id: &str) -> Result<RgbaImage, CaptureError> {
        Err(CaptureError::Unsupported("unsupported operating system".into()))
    }
}
