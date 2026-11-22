//! Windows: Windows Graphics Capture, one frame.
//!
//! Windows draws a yellow outline around the screen or window being captured. For a screenshot that flashes at the edge of the screen on every
//! capture, and a study session that reads the screen every few seconds would flash it all the time. So each capture first asks Windows for
//! NO outline (`IsBorderRequired = false`); if this Windows will not allow it (older than Windows 10 2104, or the person's privacy settings say
//! no), that is remembered and the capture is made with the outline, because a screenshot that works with an outline beats none. The
//! application's own indicator (the window title and the panel's "screen reading ON") says when the screen is being read.
//! The cursor setting is left at the system default.

use crate::{Backend, CaptureError, Modes, RgbaImage, Support, WindowInfo};
use std::sync::atomic::{AtomicU8, Ordering};
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

/// What Windows said when asked for a capture without the outline: 0 not asked yet, 1 allowed, 2 refused (the outline is shown).
static BORDERLESS: AtomicU8 = AtomicU8::new(0);

/// True when a capture can be made with no outline on this Windows (as far as it has been found out).
pub fn borderless_allowed() -> Option<bool> {
    match BORDERLESS.load(Ordering::Relaxed) {
        1 => Some(true),
        2 => Some(false),
        _ => None,
    }
}

/// How many times a capture without the outline failed where one with the outline then worked (two in a row means Windows is refusing).
static BORDERLESS_MISSES: AtomicU8 = AtomicU8::new(0);

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

fn one_frame<T>(item: T) -> Result<RgbaImage, CaptureError>
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Clone,
{
    let state = BORDERLESS.load(Ordering::Relaxed);
    if state != 2 {
        match try_frame(item.clone(), DrawBorderSettings::WithoutBorder) {
            Ok(image) => {
                BORDERLESS.store(1, Ordering::Relaxed);
                BORDERLESS_MISSES.store(0, Ordering::Relaxed);
                return Ok(image);
            }
            // Known to work here, so this failure is a real one (a closed window, no permission): report it as it is.
            Err(failure) if state == 1 => return Err(failure),
            // Not known to work yet: it may be the setting. Try once more with the outline; only if that works is the setting to blame.
            Err(_) => {}
        }
    }
    let image = try_frame(item, DrawBorderSettings::Default)?;
    if state != 2 && BORDERLESS_MISSES.fetch_add(1, Ordering::Relaxed) + 1 >= 2 {
        BORDERLESS.store(2, Ordering::Relaxed);
    }
    Ok(image)
}

impl Backend for Native {
    fn support(&self) -> Support {
        Support {
            platform: "windows".into(),
            session: "windows".into(),
            modes: Modes { screen: true, window: true, region: true, watch: true },
            permission: "granted".into(),
            note: match borderless_allowed() {
                Some(false) => "Windows shows an outline around what is captured. To remove it: Settings > Privacy & security > Screenshot borders.".into(),
                _ => String::new(),
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
                Some(WindowInfo { id: (w.as_raw_hwnd() as usize).to_string(), title, app, width: width as u32, height: height as u32 })
            })
            .collect())
    }

    fn capture_screen(&self) -> Result<RgbaImage, CaptureError> {
        let monitor = Monitor::primary().map_err(|e| CaptureError::Failed(e.to_string()))?;
        one_frame(monitor)
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
