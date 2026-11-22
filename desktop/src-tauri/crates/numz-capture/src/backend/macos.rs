//! macOS: ScreenCaptureKit (`SCScreenshotManager`, macOS 14 or later). One still image per call.
//!
//! The permission is the system's: the first time something is captured macOS asks the person for "Screen Recording" itself, and shows
//! its own indicator; if they say no, ScreenCaptureKit answers with "user declined" and this reports `permission-denied`. Nothing here
//! tries to get around that prompt, to pre-approve it, or to hide the indicator.

use crate::{Backend, CaptureError, Modes, RgbaImage, Support, WindowInfo};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_core_graphics::{CGDataProvider, CGImage, CGMainDisplayID, CGPreflightScreenCaptureAccess};
use objc2_foundation::{NSArray, NSError, NSOperatingSystemVersion, NSProcessInfo};
use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow};
use std::sync::mpsc::{channel, Sender};
use std::time::Duration;

pub struct Native;

/// ScreenCaptureKit's "the user declined the request" error code.
const USER_DECLINED: isize = -3801;
const WAIT: Duration = Duration::from_secs(15);

/// A retained Objective-C object handed to another thread. ScreenCaptureKit's content objects are immutable once delivered.
struct Handoff<T>(Retained<T>);
// SAFETY: SCShareableContent and its displays/windows are immutable snapshots; they are only read after the hand-off.
unsafe impl<T> Send for Handoff<T> {}

fn supported_here() -> Result<(), CaptureError> {
    let at_least_14 = NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion { majorVersion: 14, minorVersion: 0, patchVersion: 0 });
    if at_least_14 {
        Ok(())
    } else {
        Err(CaptureError::Unsupported("screenshots need macOS 14 or later".into()))
    }
}

fn error_of(error: *mut NSError) -> CaptureError {
    if error.is_null() {
        return CaptureError::Failed("ScreenCaptureKit gave no picture and no error".into());
    }
    // SAFETY: a non-null error pointer handed to a completion handler is a valid NSError for the duration of the call.
    let code = unsafe { (*error).code() };
    if code == USER_DECLINED {
        CaptureError::PermissionDenied
    } else {
        CaptureError::Failed(format!("ScreenCaptureKit error {code}"))
    }
}

/// What is on offer to capture right now (asks for permission the first time, through the system's own prompt).
fn shareable(windows_only_on_screen: bool) -> Result<Retained<SCShareableContent>, CaptureError> {
    supported_here()?;
    let (tx, rx) = channel::<Result<Handoff<SCShareableContent>, CaptureError>>();
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: the content pointer is valid for this call; it is retained before it is kept.
        let answer = match unsafe { Retained::retain(content) } {
            Some(content) => Ok(Handoff(content)),
            None => Err(error_of(error)),
        };
        let _ = tx.send(answer);
    });
    // SAFETY: the block lives until the call returns and ScreenCaptureKit copies it when it needs it for later.
    unsafe {
        if windows_only_on_screen {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, true, &block);
        } else {
            SCShareableContent::getShareableContentWithCompletionHandler(&block);
        }
    }
    match rx.recv_timeout(WAIT) {
        Ok(answer) => answer.map(|h| h.0),
        Err(_) => Err(CaptureError::Failed("ScreenCaptureKit did not answer in time".into())),
    }
}

/// BGRA rows (with whatever padding the system used) into a tightly packed RGBA picture.
fn to_rgba(image: &CGImage) -> Result<RgbaImage, CaptureError> {
    let (width, height) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    let (per_row, bits) = (CGImage::bytes_per_row(Some(image)), CGImage::bits_per_pixel(Some(image)));
    if bits != 32 || width == 0 || height == 0 || per_row < width * 4 {
        return Err(CaptureError::Failed("the picture has an unexpected pixel layout".into()));
    }
    let provider = CGImage::data_provider(Some(image)).ok_or_else(|| CaptureError::Failed("the picture has no pixel data".into()))?;
    let data = CGDataProvider::data(Some(&provider)).ok_or_else(|| CaptureError::Failed("the pixel data could not be read".into()))?;
    let bytes = data.to_vec();
    if bytes.len() < per_row * (height - 1) + width * 4 {
        return Err(CaptureError::Failed("the pixel data is shorter than the picture".into()));
    }
    let mut rgba = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        for px in bytes[row * per_row..row * per_row + width * 4].chunks_exact(4) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    RgbaImage::from_raw(width as u32, height as u32, rgba).ok_or_else(|| CaptureError::Failed("the picture has an unexpected size".into()))
}

/// One still of whatever the filter selects, at its native pixel size.
fn still(filter: &SCContentFilter) -> Result<RgbaImage, CaptureError> {
    // SAFETY: plain property reads on a filter we own (macOS 14, checked by `shareable`).
    let (rect, scale) = unsafe { (filter.contentRect(), filter.pointPixelScale() as f64) };
    let (width, height) = ((rect.size.width * scale).round() as usize, (rect.size.height * scale).round() as usize);
    if width == 0 || height == 0 {
        return Err(CaptureError::Failed("there is nothing to capture".into()));
    }
    let (tx, rx): (Sender<Result<RgbaImage, CaptureError>>, _) = channel();
    let block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        // SAFETY: the image pointer is valid for this call; it is converted to owned bytes before the call ends.
        let answer = match unsafe { image.as_ref() } {
            Some(image) => to_rgba(image),
            None => Err(error_of(error)),
        };
        let _ = tx.send(answer);
    });
    // SAFETY: configuration setters on an object we own, then the documented one-shot screenshot call.
    unsafe {
        let config = SCStreamConfiguration::new();
        config.setWidth(width);
        config.setHeight(height);
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(filter, &config, Some(&block));
    }
    match rx.recv_timeout(WAIT) {
        Ok(answer) => answer,
        Err(_) => Err(CaptureError::Failed("ScreenCaptureKit did not answer in time".into())),
    }
}

fn describe(window: &SCWindow) -> Option<WindowInfo> {
    // SAFETY: property reads on a window object from a ShareableContent snapshot.
    unsafe {
        if !window.isOnScreen() || window.windowLayer() != 0 {
            return None;
        }
        let frame = window.frame();
        let app = window.owningApplication().map(|a| a.applicationName().to_string()).unwrap_or_default();
        let title = window.title().map(|t| t.to_string()).unwrap_or_default();
        let title = if title.trim().is_empty() { app.clone() } else { title };
        if frame.size.width < 80.0 || frame.size.height < 60.0 || title.trim().is_empty() {
            return None;
        }
        Some(WindowInfo { id: window.windowID().to_string(), title, app, width: frame.size.width as u32, height: frame.size.height as u32 })
    }
}

impl Backend for Native {
    fn support(&self) -> Support {
        let granted = CGPreflightScreenCaptureAccess();
        let supported = supported_here().is_ok();
        Support {
            platform: "macos".into(),
            session: "macos".into(),
            modes: Modes { screen: supported, window: supported, region: supported, watch: supported },
            permission: if granted { "granted" } else { "prompt" }.into(),
            note: if !supported {
                "Screenshots need macOS 14 or later.".into()
            } else if granted {
                String::new()
            } else {
                "macOS will ask for Screen Recording permission the first time. You can change it later in System Settings > Privacy & Security.".into()
            },
        }
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        let content = shareable(true)?;
        // SAFETY: reading the window list of a snapshot we hold.
        let windows = unsafe { content.windows() };
        Ok(windows.iter().filter_map(|w| describe(&w)).collect())
    }

    fn capture_screen(&self) -> Result<RgbaImage, CaptureError> {
        let content = shareable(false)?;
        // SAFETY: reading the display list of a snapshot we hold; the filter is built from a display of that snapshot.
        let filter = unsafe {
            let displays = content.displays();
            let main = CGMainDisplayID();
            let display = displays.iter().find(|d| d.displayID() == main).or_else(|| displays.iter().next()).ok_or_else(|| CaptureError::Unsupported("no display found".into()))?;
            SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &NSArray::new())
        };
        still(&filter)
    }

    fn capture_window(&self, id: &str) -> Result<RgbaImage, CaptureError> {
        let wanted: u32 = id.parse().map_err(|_| CaptureError::NoSuchWindow)?;
        let content = shareable(true)?;
        // SAFETY: as above.
        let filter = unsafe {
            let windows = content.windows();
            let window = windows.iter().find(|w| w.windowID() == wanted).ok_or(CaptureError::NoSuchWindow)?;
            SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
        };
        still(&filter)
    }
}
