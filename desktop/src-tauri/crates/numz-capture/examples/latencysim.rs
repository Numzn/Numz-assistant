//! How long after a screen changes does the page have the picture, and what does each look cost? Runs the REAL watcher (change detection,
//! settling, the minimum gap) against a made-up desktop on a virtual clock, so the numbers are exact for the logic and say nothing about the
//! operating system's own capture time (which this does not call).
//!
//!     cargo run --release --example latencysim -p numz-capture
//!
//! For each look interval and page poll period it changes the screen at random moments (a page of text replaced by another, as when a student
//! moves to the next question) and reports the time from the change until `poll` hands the picture over: the median and the 90th percentile.

use numz_capture::held::Held;
use numz_capture::watch::{Tick, WatchConfig, Watcher};
use numz_capture::{Backend, CaptureError, Modes, RgbaImage, Support, WindowInfo};
use image::Rgba;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Desktop {
    screen: Mutex<RgbaImage>,
}

impl Backend for Desktop {
    fn support(&self) -> Support {
        Support { platform: "sim".into(), session: "x11".into(), modes: Modes { screen: true, window: true, region: true, watch: true }, permission: "granted".into(), note: String::new() }
    }
    fn windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        Ok(vec![])
    }
    fn capture_screen(&self) -> Result<RgbaImage, CaptureError> {
        Ok(self.screen.lock().unwrap().clone())
    }
    fn capture_window(&self, _id: &str) -> Result<RgbaImage, CaptureError> {
        Err(CaptureError::Unsupported("sim".into()))
    }
}

/// A page of "text": which lines are drawn depends on `seed`, so two seeds are two different pages.
fn page(seed: u32, w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let line = y / 24;
        let on = (y % 24) < 10 && x > 120 && x < w - 120 && ((x / 9 + line * 7 + seed * 13) % 5) < 3;
        if on { Rgba([22, 22, 30, 255]) } else { Rgba([250, 250, 252, 255]) }
    })
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn main() {
    let (w, h) = (1920u32, 1080u32);
    let pages = [page(1, w, h), page(2, w, h)];
    println!("{:<12} {:<12} {:>14} {:>14} {:>16}", "look every", "poll every", "median s", "90th pct s", "CPU per look ms");
    for (interval_ms, poll_ms) in [(2500u64, 1500u64), (1500, 1500), (1500, 500), (2500, 500)] {
        let mut waits = Vec::new();
        let mut look_cost = Vec::new();
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        for trial in 0..120u64 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let change_at = 20_000 + (seed % (interval_ms * 4)) / 50 * 50; // ms after the start, at a random moment between looks
            let desktop = Desktop { screen: Mutex::new(pages[0].clone()) };
            let held = Arc::new(Mutex::new(Held::new(Duration::from_secs(300), 4)));
            let base = Instant::now();
            let at = |ms: u64| base + Duration::from_millis(ms);
            let config = WatchConfig { min_gap: Duration::from_secs(10), ..WatchConfig::default() }.with_interval_ms(interval_ms);
            let mut watcher = Watcher::start(&desktop, config, held, at(0)).unwrap();
            let poll_phase = ((seed >> 9) % (poll_ms / 50)) * 50; // the page's polls fall on the same 50 ms grid as this simulation
            let mut changed = false;
            let mut found = None;
            let mut t = 0u64;
            while t < 60_000 && found.is_none() {
                if t == 0 || t % interval_ms == 0 {
                    if t >= change_at && !changed {
                        *desktop.screen.lock().unwrap() = pages[1].clone();
                        changed = true;
                    }
                    let started = Instant::now();
                    let tick = watcher.tick(&desktop, at(t));
                    if trial == 0 {
                        look_cost.push(started.elapsed().as_secs_f64() * 1000.0);
                    }
                    let _ = matches!(tick, Tick::Reported);
                }
                if t >= poll_phase && (t - poll_phase) % poll_ms == 0 {
                    let polled = watcher.poll(at(t));
                    if changed && polled.pending.is_some() {
                        found = Some(t);
                    }
                }
                t += 50;
            }
            // the change happens at the first multiple of 50 ms at or after `change_at`, between looks
            if let Some(t) = found {
                waits.push((t as f64 - change_at as f64) / 1000.0);
            } else {
                eprintln!("  (no picture within a minute for a change at {change_at} ms)");
            }
        }
        let cost = look_cost.iter().cloned().fold(0.0, f64::max);
        println!("{:<12} {:<12} {:>14.2} {:>14.2} {:>16.1}", format!("{interval_ms} ms"), format!("{poll_ms} ms"), percentile(&mut waits.clone(), 0.5), percentile(&mut waits, 0.9), cost);
    }
}
