//! Windows: Windows Graphics Capture, one frame. The border and cursor settings are left at the operating system's defaults on purpose:
//! whatever indicator Windows shows while something is being captured is shown, never switched off.

use crate::{Backend, CaptureError, Modes, RgbaImage, Support, WindowInfo};
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

fn one_frame<T>(item: T) -> Result<RgbaImage, CaptureError>
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType>,
{
    let (tx, rx) = sync_channel::<Sent>(1);
    let settings = Settings::new(
        item,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
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

impl Backend for Native {
    fn support(&self) -> Support {
        Support {
            platform: "windows".into(),
            session: "windows".into(),
            modes: Modes { screen: true, window: true, region: true, watch: true },
            permission: "granted".into(),
            note: "Windows may outline what is being captured for a moment.".into(),
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
