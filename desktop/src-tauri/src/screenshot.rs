//! The screenshot commands the NUMZ AI page can call. Every one is read-only with respect to the desktop: a command takes one picture, or
//! looks at the list of windows, or answers from memory. There is no command that sends input, moves anything or records.
//!
//!   screenshot_status()                           what this desktop session can do, and whether the system will allow it
//!   screenshot_windows()                          the windows that can be captured
//!   screenshot_capture(mode, windowId?)           one picture of the primary display or of one window -> a held capture and a small preview
//!   screenshot_export(captureId, rect?, ...)      the held capture, cropped and scaled, as a JPEG (base64) for the server
//!   screenshot_discard(captureId)                 forget a held capture
//!
//! Captures live in memory only, a couple at a time, for a few minutes (numz_capture::held). Nothing is written to disk.

use base64::Engine;
use numz_capture::encode::{self, Rect};
use numz_capture::held::Held;
use numz_capture::{native_backend, Backend, CaptureError, Support, WindowInfo};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{State, WebviewWindow};

/// The one origin whose pages may use the commands (set at start from the address the window opens).
pub struct Trusted(pub String);

pub struct Screens {
    backend: Arc<dyn Backend>,
    held: Mutex<Held>,
    busy: AtomicBool,
}

impl Screens {
    pub fn new() -> Self {
        Self { backend: Arc::from(native_backend()), held: Mutex::new(Held::default()), busy: AtomicBool::new(false) }
    }
}

/// Defence in depth behind the capability: the caller must be the main window, showing a page of the trusted origin.
fn check(window: &WebviewWindow, trusted: &Trusted) -> Result<(), CaptureError> {
    if window.label() != "main" {
        return Err(CaptureError::Unsupported("not the main window".into()));
    }
    let url = window.url().map_err(|_| CaptureError::Unsupported("the page address is not known".into()))?;
    if url.origin().ascii_serialization() != trusted.0 {
        return Err(CaptureError::Unsupported("this page may not take screenshots".into()));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    capture_id: String,
    width: u32,
    height: u32,
    preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    data: String,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, CaptureError> + Send + 'static) -> Result<T, CaptureError> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| CaptureError::Failed(format!("the capture task failed: {e}")))?
}

#[tauri::command]
pub async fn screenshot_status(window: WebviewWindow, screens: State<'_, Screens>, trusted: State<'_, Trusted>) -> Result<Support, CaptureError> {
    check(&window, &trusted)?;
    Ok(screens.backend.support())
}

#[tauri::command]
pub async fn screenshot_windows(window: WebviewWindow, screens: State<'_, Screens>, trusted: State<'_, Trusted>) -> Result<Vec<WindowInfo>, CaptureError> {
    check(&window, &trusted)?;
    let backend = screens.backend.clone();
    blocking(move || backend.windows()).await
}

#[tauri::command]
pub async fn screenshot_capture(
    window: WebviewWindow,
    screens: State<'_, Screens>,
    trusted: State<'_, Trusted>,
    mode: String,
    window_id: Option<String>,
) -> Result<CaptureMeta, CaptureError> {
    check(&window, &trusted)?;
    // One capture at a time: a second request while one is in progress is refused, not queued.
    if screens.busy.swap(true, Ordering::SeqCst) {
        return Err(CaptureError::Busy);
    }
    let backend = screens.backend.clone();
    let taken = blocking(move || {
        let image = match mode.as_str() {
            "screen" => backend.capture_screen()?,
            "window" => backend.capture_window(&window_id.ok_or(CaptureError::NoSuchWindow)?)?,
            _ => return Err(CaptureError::Failed("unknown capture mode".into())),
        };
        let preview = encode::preview_data_url(&image)?;
        Ok((image, preview))
    })
    .await;
    screens.busy.store(false, Ordering::SeqCst);
    let (image, preview) = taken?;
    let (width, height) = image.dimensions();
    let capture_id = screens.held.lock().map_err(|_| CaptureError::Failed("capture store poisoned".into()))?.insert(image);
    Ok(CaptureMeta { capture_id, width, height, preview })
}

#[tauri::command]
pub async fn screenshot_export(
    window: WebviewWindow,
    screens: State<'_, Screens>,
    trusted: State<'_, Trusted>,
    capture_id: String,
    rect: Option<Rect>,
    max_side: u32,
    quality: u8,
) -> Result<Exported, CaptureError> {
    check(&window, &trusted)?;
    let image = screens.held.lock().map_err(|_| CaptureError::Failed("capture store poisoned".into()))?.get(&capture_id)?;
    blocking(move || {
        let out = encode::export(&image, rect, max_side, quality)?;
        Ok(Exported { data: base64::engine::general_purpose::STANDARD.encode(out.bytes), mime_type: "image/jpeg", width: out.width, height: out.height })
    })
    .await
}

#[tauri::command]
pub async fn screenshot_discard(window: WebviewWindow, screens: State<'_, Screens>, trusted: State<'_, Trusted>, capture_id: String) -> Result<(), CaptureError> {
    check(&window, &trusted)?;
    if let Ok(mut held) = screens.held.lock() {
        held.discard(&capture_id);
    }
    Ok(())
}
