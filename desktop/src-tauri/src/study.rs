//! Automatic capture for a study session, as the Tauri app runs it: a background thread around numz_capture::watch::Watcher, started and
//! stopped by the page, and collected from by the page about once a second. All the rules (what is excluded, when a picture counts as
//! new, the dead-man switch) live in the capture crate and are tested there; this file only owns the thread and the commands.
//!
//! While it is watching, the window's own title says so ("NUMZ AI - study session, screen reading on"): the person can see it in the title
//! bar and the task list without anything being drawn over the desktop.

use crate::screenshot::{check, Screens, Trusted};
use numz_capture::watch::{Polled, Status, Tick, WatchConfig, Watcher};
use numz_capture::CaptureError;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const TITLE: &str = "NUMZ AI";
const TITLE_WATCHING: &str = "NUMZ AI - study session, screen reading ON";

#[derive(Default)]
pub struct StudyWatch {
    slot: Arc<Mutex<Option<Watcher>>>,
    generation: Arc<AtomicU64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    status: Status,
    watch_available: bool,
}

fn set_title(app: &AppHandle, title: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(title);
    }
}

fn state(watch: &StudyWatch) -> Status {
    watch.slot.lock().ok().and_then(|g| g.as_ref().map(|w| w.status())).unwrap_or(Status::Stopped)
}

#[tauri::command]
pub async fn screenshot_watch_start(
    app: AppHandle,
    window: WebviewWindow,
    screens: State<'_, Screens>,
    trusted: State<'_, Trusted>,
    watch: State<'_, StudyWatch>,
    interval_ms: Option<u64>,
    exclude_apps: Option<Vec<String>>,
    exclude_titles: Option<Vec<String>>,
) -> Result<WatchState, CaptureError> {
    check(&window, &trusted)?;
    let backend = screens.backend();
    let held = screens.held();
    let config = WatchConfig { exclude_apps: exclude_apps.unwrap_or_default(), exclude_titles: exclude_titles.unwrap_or_default(), ..WatchConfig::default() }.with_interval_ms(interval_ms.unwrap_or(2500));
    let started = {
        let backend = backend.clone();
        tauri::async_runtime::spawn_blocking(move || Watcher::start(&*backend, config, held, Instant::now())).await.map_err(|e| CaptureError::Failed(format!("the watcher could not start: {e}")))??
    };
    let generation = watch.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut slot) = watch.slot.lock() {
        if let Some(old) = slot.as_mut() {
            old.stop() // a second start replaces the first
        }
        *slot = Some(started);
    }
    set_title(&app, TITLE_WATCHING);
    let slot = watch.slot.clone();
    let counter = watch.generation.clone();
    std::thread::Builder::new()
        .name("numz-study-watch".into())
        .spawn(move || loop {
            let interval = {
                let Ok(guard) = slot.lock() else { break };
                match guard.as_ref() {
                    Some(w) if counter.load(Ordering::SeqCst) == generation && w.status() != Status::Stopped => w.interval(),
                    _ => break,
                }
            };
            // Sleep in short steps so pause, stop and a new start take effect quickly.
            let mut waited = Duration::ZERO;
            while waited < interval {
                std::thread::sleep(Duration::from_millis(100));
                waited += Duration::from_millis(100);
                if counter.load(Ordering::SeqCst) != generation {
                    return;
                }
            }
            let outcome = {
                let Ok(mut guard) = slot.lock() else { break };
                match guard.as_mut() {
                    Some(w) if counter.load(Ordering::SeqCst) == generation => w.tick(&*backend, Instant::now()),
                    _ => break,
                }
            };
            if matches!(outcome, Tick::PageGone | Tick::Stopped) {
                break;
            }
        })
        .map_err(|e| CaptureError::Failed(format!("the watcher thread could not start: {e}")))?;
    Ok(WatchState { status: Status::Watching, watch_available: true })
}

#[tauri::command]
pub async fn screenshot_watch_poll(app: AppHandle, window: WebviewWindow, trusted: State<'_, Trusted>, watch: State<'_, StudyWatch>) -> Result<Polled, CaptureError> {
    check(&window, &trusted)?;
    let polled = match watch.slot.lock() {
        Ok(mut guard) => guard.as_mut().map(|w| w.poll(Instant::now())),
        Err(_) => None,
    };
    let polled = polled.unwrap_or(Polled { status: Status::Stopped, pending: None, stats: Default::default(), stopped_because: None, excluded_now: false });
    if polled.status == Status::Stopped {
        set_title(&app, TITLE);
    }
    Ok(polled)
}

#[tauri::command]
pub async fn screenshot_watch_pause(app: AppHandle, window: WebviewWindow, trusted: State<'_, Trusted>, watch: State<'_, StudyWatch>) -> Result<WatchState, CaptureError> {
    check(&window, &trusted)?;
    if let Ok(mut guard) = watch.slot.lock() {
        if let Some(w) = guard.as_mut() {
            w.pause();
        }
    }
    set_title(&app, "NUMZ AI - study session paused");
    Ok(WatchState { status: state(&watch), watch_available: true })
}

#[tauri::command]
pub async fn screenshot_watch_resume(app: AppHandle, window: WebviewWindow, trusted: State<'_, Trusted>, watch: State<'_, StudyWatch>) -> Result<WatchState, CaptureError> {
    check(&window, &trusted)?;
    if let Ok(mut guard) = watch.slot.lock() {
        if let Some(w) = guard.as_mut() {
            w.resume(Instant::now());
        }
    }
    if state(&watch) == Status::Watching {
        set_title(&app, TITLE_WATCHING);
    }
    Ok(WatchState { status: state(&watch), watch_available: true })
}

#[tauri::command]
pub async fn screenshot_watch_stop(app: AppHandle, window: WebviewWindow, trusted: State<'_, Trusted>, watch: State<'_, StudyWatch>) -> Result<WatchState, CaptureError> {
    check(&window, &trusted)?;
    watch.generation.fetch_add(1, Ordering::SeqCst); // the thread notices and ends
    if let Ok(mut guard) = watch.slot.lock() {
        if let Some(w) = guard.as_mut() {
            w.stop();
        }
        *guard = None;
    }
    set_title(&app, TITLE);
    Ok(WatchState { status: Status::Stopped, watch_available: true })
}
