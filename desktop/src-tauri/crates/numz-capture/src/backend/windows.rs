//! Windows: Windows Graphics Capture, one frame.
//!
//! Windows draws a yellow outline around the screen or window being captured. For a screenshot that flashes at the edge of the screen on every
//! capture, and a study session that reads the screen every few seconds would flash it all the time.
//!
//! The screen is therefore captured through Desktop Duplication (DXGI), which draws no outline and needs no setting. Only if that cannot work
//! on this machine does it fall back to Windows Graphics Capture, and a WINDOW is always taken that way (an outline appears for a moment).
//! Windows lets a Graphics Capture app drop the outline only after the app has ASKED (`GraphicsCaptureAccess`, Borderless) and the system, or
//! the person in Settings > Privacy & security > Screenshot borders, has allowed it; setting `IsBorderRequired = false` without that is
//! accepted and silently ignored (measured on a Windows machine: the outline stayed). So that is asked once, and used only if allowed.
//! The application's own indicator (the window title and the panel's "screen reading ON") says when the screen is being read.
//! The cursor is not part of a Desktop Duplication picture, and is left at the system default in the fallback.

use crate::{Backend, CaptureError, Modes, RgbaImage, Support, WindowInfo};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::time::Duration;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

pub struct Native;

type Sent = Result<RgbaImage, String>;

/// Takes the first frame that arrives, sends it, and stops the capture: this is a screenshot, never a recording.
struct OneFrame {
    out: SyncSender<Sent>,
}

impl GraphicsCaptureApiHandler for OneFrame {
    type Flags = SyncSender<Sent>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { out: ctx.flags })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        let (width, height) = (frame.width(), frame.height());
        let sent = match frame.buffer() {
            Ok(buffer) => {
                let mut scratch = Vec::new();
                let pixels = buffer.as_nopadding_buffer(&mut scratch).to_vec();
                RgbaImage::from_raw(width, height, pixels).ok_or_else(|| "the frame had an unexpected size".to_string())
            }
            Err(e) => Err(e.to_string()),
        };
        let _ = self.out.send(sent);
        control.stop();
        Ok(())
    }
}

static ACCESS: OnceLock<String> = OnceLock::new();

/// Asks Windows (once) whether this app may capture without the outline, and returns its answer: "Allowed", "DeniedByUser", "DeniedBySystem",
/// "NotDeclaredByApp", ... or "unavailable: ..." on a Windows that has no such question. May show Windows' own consent prompt the first time.
pub fn request_borderless_access() -> &'static str {
    ACCESS.get_or_init(|| {
        use windows::Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind};
        match GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless).and_then(|op| op.join()) {
            Ok(status) => format!("{status:?}"),
            Err(e) => format!("unavailable: {e}"),
        }
    })
}

fn borderless_allowed() -> Option<bool> {
    ACCESS.get().map(|status| status.eq_ignore_ascii_case("Allowed"))
}

fn try_frame<T>(item: T, border: DrawBorderSettings) -> Result<RgbaImage, CaptureError>
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType>,
{
    let (tx, rx) = sync_channel::<Sent>(1);
    let settings = Settings::new(
        item,
        CursorCaptureSettings::Default,
        border,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        tx,
    );
    // `start` runs the capture on this thread until the handler stops it; the answer is waiting in the channel by then.
    OneFrame::start(settings).map_err(|e| crate::classify(&e.to_string()))?;
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(image)) => Ok(image),
        Ok(Err(why)) => Err(CaptureError::Failed(why)),
        Err(_) => Err(CaptureError::Failed("no frame arrived".into())),
    }
}

/// How the last picture of the screen was taken: "dxgi" (no outline), "graphics-capture" (Windows may outline it), or "" before the first.
static LAST_METHOD: Mutex<&'static str> = Mutex::new("");
static DXGI_FAILS: AtomicU8 = AtomicU8::new(0);

pub fn last_screen_method() -> &'static str {
    LAST_METHOD.lock().map(|m| *m).unwrap_or("")
}

/// The primary screen through Desktop Duplication: no outline is ever drawn. The first frame after the duplication is made carries the whole
/// desktop; a frame with no present time is only a pointer move, so it is skipped. Any failure is reported so the caller can fall back.
fn dxgi_screen() -> Result<RgbaImage, String> {
    use windows_capture::dxgi_duplication_api::{DxgiDuplicationApi, DxgiDuplicationFormat};
    let monitor = Monitor::primary().map_err(|e| e.to_string())?;
    let mut duplication = DxgiDuplicationApi::new_options(monitor, &[DxgiDuplicationFormat::Bgra8]).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(2500) {
        match duplication.acquire_next_frame(100) {
            Ok(mut frame) => {
                if frame.frame_info().LastPresentTime == 0 {
                    continue;
                }
                let (width, height) = (frame.width(), frame.height());
                let buffer = frame.buffer().map_err(|e| e.to_string())?;
                let mut scratch = Vec::new();
                let mut pixels = buffer.as_nopadding_buffer(&mut scratch).to_vec();
                for px in pixels.chunks_exact_mut(4) {
                    px.swap(0, 2); // BGRA -> RGBA
                    px[3] = 255;
                }
                return RgbaImage::from_raw(width, height, pixels).ok_or_else(|| "the frame had an unexpected size".to_string());
            }
            Err(windows_capture::dxgi_duplication_api::Error::Timeout) => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("no frame arrived".into())
}

fn one_frame<T>(item: T) -> Result<RgbaImage, CaptureError>
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Clone,
{
    if request_borderless_access().eq_ignore_ascii_case("Allowed") {
        if let Ok(image) = try_frame(item.clone(), DrawBorderSettings::WithoutBorder) {
            return Ok(image);
        }
        // Allowed, yet it failed: try once more the plain way, so a capture is never lost to this setting. A real failure (a closed window,
        // no permission) fails the same way here and is reported as it is.
    }
    try_frame(item, DrawBorderSettings::Default)
}

impl Backend for Native {
    fn support(&self) -> Support {
        Support {
            platform: "windows".into(),
            session: "windows".into(),
            modes: Modes { screen: true, window: true, region: true, watch: true },
            permission: "granted".into(),
            note: if last_screen_method() == "graphics-capture" || borderless_allowed() == Some(false) {
                "Windows may outline a window while it is captured. To stop that, allow NUMZ AI under Settings > Privacy & security > Screenshot borders.".into()
            } else {
                String::new()
            },
        }
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        let all = Window::enumerate().map_err(|e| CaptureError::Failed(e.to_string()))?;
        Ok(all
            .iter()
            .filter(|w| w.is_valid())
            .filter_map(|w| {
                let app = w.process_name().unwrap_or_default();
                let title = w.title().unwrap_or_default();
                let title = if title.trim().is_empty() { app.clone() } else { title };
                let (width, height) = (w.width().ok()?, w.height().ok()?);
                if title.trim().is_empty() || width < 80 || height < 60 {
                    return None;
                }
                let origin = w.rect().ok();
                Some(WindowInfo { id: (w.as_raw_hwnd() as usize).to_string(), title, app, width: width as u32, height: height as u32, x: origin.map(|r| r.left), y: origin.map(|r| r.top) })
            })
            .collect())
    }

    fn capture_screen(&self) -> Result<RgbaImage, CaptureError> {
        // No outline first. Two failures in a row mean Desktop Duplication does not work on this machine: stop trying it.
        if DXGI_FAILS.load(Ordering::Relaxed) < 2 {
            match dxgi_screen() {
                Ok(image) => {
                    DXGI_FAILS.store(0, Ordering::Relaxed);
                    if let Ok(mut method) = LAST_METHOD.lock() {
                        *method = "dxgi";
                    }
                    return Ok(image);
                }
                Err(_) => {
                    DXGI_FAILS.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        let monitor = Monitor::primary().map_err(|e| CaptureError::Failed(e.to_string()))?;
        let image = one_frame(monitor)?;
        if let Ok(mut method) = LAST_METHOD.lock() {
            *method = "graphics-capture";
        }
        Ok(image)
    }

    fn capture_window(&self, id: &str) -> Result<RgbaImage, CaptureError> {
        let raw: usize = id.parse().map_err(|_| CaptureError::NoSuchWindow)?;
        let window = Window::from_raw_hwnd(raw as *mut std::ffi::c_void);
        if !window.is_valid() {
            return Err(CaptureError::NoSuchWindow);
        }
        one_frame(window)
    }
}
