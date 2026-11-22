//! The watcher: automatic capture during a study session, kept deliberately small. At a modest interval it takes ONE still (never video),
//! and only if nothing on screen is excluded; it reduces the still to a signature, and reports a picture only when the screen has changed and
//! settled. Everything else is dropped on the spot. It holds at most one finished picture for the page to collect.
//!
//! Safeguards, all enforced here and not in the page:
//!  - no picture is taken while any open window matches an exclusion (password managers, sign-in screens, private browsing, and the
//!    person's own list); this includes windows behind others, because a full-screen picture would show whatever is visible;
//!  - it starts only where windows can be listed (so exclusions can be honoured): not on Wayland;
//!  - a minimum gap between reported pictures, and a minimum interval between looks;
//!  - a dead-man switch: if the page stops asking for results (it closed, crashed or navigated away) the watcher stops itself, so the screen
//!    is never watched on behalf of a page that is not there;
//!  - pause and stop take effect before the next look.

use crate::detect::{signature, Config as DetectConfig, Detector, Verdict};
use crate::encode;
use crate::exclusion::{Exclusions, Reason};
use crate::held::Held;
use crate::{Backend, CaptureError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct WatchConfig {
    pub interval: Duration,
    pub min_gap: Duration,
    pub poll_timeout: Duration,
    pub exclude_apps: Vec<String>,
    pub exclude_titles: Vec<String>,
    pub detect: DetectConfig,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self { interval: Duration::from_millis(2500), min_gap: Duration::from_secs(10), poll_timeout: Duration::from_secs(20), exclude_apps: vec![], exclude_titles: vec![], detect: DetectConfig::default() }
    }
}

impl WatchConfig {
    /// The interval is kept between 1.5 and 30 seconds whatever is asked.
    pub fn with_interval_ms(mut self, ms: u64) -> Self {
        self.interval = Duration::from_millis(ms.clamp(1500, 30_000));
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Watching,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub capture_id: String,
    pub width: u32,
    pub height: u32,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub looks: u64,
    pub reported: u64,
    pub skipped_excluded: u64,
}

#[derive(Debug, PartialEq)]
pub enum Tick {
    Stopped,
    Paused,
    /// A picture was not taken because an open window is excluded.
    Skipped(Reason),
    Throttled,
    Settling,
    Unchanged,
    Reported,
    PageGone,
    Failed(String),
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Polled {
    pub status: Status,
    pub pending: Option<Pending>,
    pub stats: Stats,
    /// Why it is not watching right now, when that is not the person's doing: `page-gone`, `unsupported`.
    pub stopped_because: Option<&'static str>,
    /// Set while something excluded is open: nothing is being captured.
    pub excluded_now: bool,
}

pub struct Watcher {
    config: WatchConfig,
    detector: Detector,
    exclusions: Exclusions,
    status: Status,
    pending: Option<Pending>,
    stats: Stats,
    last_report: Option<Instant>,
    last_poll: Instant,
    stopped_because: Option<&'static str>,
    excluded_now: bool,
    held: Arc<Mutex<Held>>,
}

impl Watcher {
    /// Starts watching, if this desktop allows exclusions to be honoured (the windows can be listed).
    pub fn start(backend: &dyn Backend, config: WatchConfig, held: Arc<Mutex<Held>>, now: Instant) -> Result<Self, CaptureError> {
        let support = backend.support();
        if !support.modes.screen {
            return Err(CaptureError::Unsupported("this desktop session cannot be captured".into()));
        }
        backend.windows().map_err(|_| CaptureError::Unsupported("automatic capture needs the list of open windows, so that excluded ones can be respected; this desktop session does not provide it".into()))?;
        Ok(Self {
            detector: Detector::new(config.detect),
            exclusions: Exclusions::new(&config.exclude_apps, &config.exclude_titles),
            config,
            status: Status::Watching,
            pending: None,
            stats: Stats::default(),
            last_report: None,
            last_poll: now,
            stopped_because: None,
            excluded_now: false,
            held,
        })
    }

    pub fn interval(&self) -> Duration {
        self.config.interval
    }

    pub fn status(&self) -> Status {
        self.status
    }

    pub fn pause(&mut self) {
        if self.status == Status::Watching {
            self.status = Status::Paused;
        }
    }

    pub fn resume(&mut self, now: Instant) {
        if self.status == Status::Paused {
            self.status = Status::Watching;
            self.last_poll = now;
            self.detector.reset(); // what is on screen after a pause is read afresh
        }
    }

    pub fn stop(&mut self) {
        self.status = Status::Stopped;
        self.discard_pending();
    }

    fn discard_pending(&mut self) {
        if let Some(old) = self.pending.take() {
            if let Ok(mut held) = self.held.lock() {
                held.discard(&old.capture_id);
            }
        }
    }

    /// One look. Never blocks on anything but the capture itself.
    pub fn tick(&mut self, backend: &dyn Backend, now: Instant) -> Tick {
        match self.status {
            Status::Stopped => return Tick::Stopped,
            Status::Paused => return Tick::Paused,
            Status::Watching => {}
        }
        if now.duration_since(self.last_poll) > self.config.poll_timeout {
            self.stop();
            self.stopped_because = Some("page-gone");
            return Tick::PageGone;
        }
        let windows = match backend.windows() {
            Ok(list) => list,
            Err(e) => return Tick::Failed(e.detail()), // exclusions cannot be checked, so nothing is captured
        };
        if let Some((_, reason)) = self.exclusions.blocking(&windows) {
            self.stats.skipped_excluded += 1;
            self.excluded_now = true;
            return Tick::Skipped(reason);
        }
        self.excluded_now = false;
        if self.last_report.is_some_and(|t| now.duration_since(t) < self.config.min_gap) {
            return Tick::Throttled;
        }
        let image = match backend.capture_screen() {
            Ok(image) => image,
            Err(e) => return Tick::Failed(e.detail()),
        };
        self.stats.looks += 1;
        match self.detector.observe(signature(&image)) {
            Verdict::Settling => Tick::Settling,
            Verdict::Unchanged => Tick::Unchanged,
            Verdict::Changed => {
                let (width, height) = image.dimensions();
                let preview = match encode::preview_data_url(&image) {
                    Ok(p) => p,
                    Err(e) => return Tick::Failed(e.detail()),
                };
                self.discard_pending();
                let capture_id = match self.held.lock() {
                    Ok(mut held) => held.insert(image),
                    Err(_) => return Tick::Failed("capture store poisoned".into()),
                };
                self.pending = Some(Pending { capture_id, width, height, preview });
                self.last_report = Some(now);
                self.stats.reported += 1;
                Tick::Reported
            }
        }
    }

    /// What the page asks for, about once a second: the state, and the finished picture if there is one (handed over once). Asking keeps the
    /// watcher alive; not asking for `poll_timeout` stops it.
    pub fn poll(&mut self, now: Instant) -> Polled {
        self.last_poll = now;
        Polled { status: self.status, pending: self.pending.take(), stats: self.stats, stopped_because: self.stopped_because, excluded_now: self.excluded_now }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Modes, RgbaImage, Support, WindowInfo};
    use image::Rgba;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        windows: Mutex<Vec<WindowInfo>>,
        images: Mutex<Vec<RgbaImage>>,
        captures: AtomicUsize,
        can_list: bool,
    }
    impl Fake {
        fn new(can_list: bool) -> Self {
            Self { windows: Mutex::new(vec![win("firefox", "Lecture 3")]), images: Mutex::new(vec![]), captures: AtomicUsize::new(0), can_list }
        }
        fn show(&self, image: RgbaImage) {
            *self.images.lock().unwrap() = vec![image];
        }
    }
    impl Backend for Fake {
        fn support(&self) -> Support {
            Support { platform: "test".into(), session: "x11".into(), modes: Modes { screen: true, window: true, region: true, watch: true }, permission: "granted".into(), note: String::new() }
        }
        fn windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
            if self.can_list { Ok(self.windows.lock().unwrap().clone()) } else { Err(CaptureError::Unsupported("no list".into())) }
        }
        fn capture_screen(&self) -> Result<RgbaImage, CaptureError> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            self.images.lock().unwrap().first().cloned().ok_or(CaptureError::Failed("nothing to show".into()))
        }
        fn capture_window(&self, _id: &str) -> Result<RgbaImage, CaptureError> {
            Err(CaptureError::Unsupported("not used".into()))
        }
    }
    fn win(app: &str, title: &str) -> WindowInfo {
        WindowInfo { id: "1".into(), title: title.into(), app: app.into(), width: 800, height: 600 }
    }
    fn page(lines: u32) -> RgbaImage {
        RgbaImage::from_fn(800, 450, |x, y| if (y / 20) % 2 == 0 && y / 20 < lines * 2 && x > 50 && x < 750 { Rgba([20, 20, 20, 255]) } else { Rgba([240, 240, 240, 255]) })
    }
    fn watcher(fake: &Fake, now: Instant) -> Watcher {
        let config = WatchConfig { min_gap: Duration::from_secs(10), poll_timeout: Duration::from_secs(20), ..WatchConfig::default() };
        Watcher::start(fake, config, Arc::new(Mutex::new(Held::default())), now).unwrap()
    }

    #[test]
    fn a_new_screen_is_reported_once_it_has_settled_and_handed_to_the_page_once() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(page(5));
        assert_eq!(w.tick(&fake, t0), Tick::Settling);
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(3)), Tick::Reported);
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(6)), Tick::Throttled, "not again within the minimum gap");
        let polled = w.poll(t0 + Duration::from_secs(7));
        assert!(polled.pending.as_ref().is_some_and(|p| p.preview.starts_with("data:image/jpeg;base64,") && p.capture_id.starts_with("cap-")));
        assert_eq!(polled.stats.reported, 1);
        assert!(w.poll(t0 + Duration::from_secs(8)).pending.is_none(), "a picture is handed over once");
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(20)), Tick::Unchanged, "the same screen is not reported again");
    }

    #[test]
    fn nothing_is_captured_while_an_excluded_window_is_open_even_behind_others() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(page(5));
        fake.windows.lock().unwrap().push(win("keepassxc", "Passwords"));
        for i in 0..4 {
            assert_eq!(w.tick(&fake, t0 + Duration::from_secs(i * 3)), Tick::Skipped(Reason::PasswordManagerOrSignIn));
        }
        assert_eq!(fake.captures.load(Ordering::SeqCst), 0, "not one picture was taken");
        let polled = w.poll(t0 + Duration::from_secs(10));
        assert!(polled.excluded_now);
        assert_eq!(polled.stats.skipped_excluded, 4);
        assert_eq!(polled.stats.looks, 0);
        fake.windows.lock().unwrap().pop();
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(12)), Tick::Settling);
        assert!(!w.poll(t0 + Duration::from_secs(13)).excluded_now);
    }

    #[test]
    fn the_persons_own_exclusions_apply_too() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let config = WatchConfig { exclude_apps: vec!["slack".into()], exclude_titles: vec!["payroll".into()], ..WatchConfig::default() };
        let mut w = Watcher::start(&fake, config, Arc::new(Mutex::new(Held::default())), t0).unwrap();
        fake.show(page(3));
        fake.windows.lock().unwrap().push(win("Slack", "general"));
        assert_eq!(w.tick(&fake, t0), Tick::Skipped(Reason::ChosenByThePerson));
        *fake.windows.lock().unwrap() = vec![win("calc", "Payroll 2026")];
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(3)), Tick::Skipped(Reason::ChosenByThePerson));
    }

    #[test]
    fn it_will_not_start_where_exclusions_cannot_be_honoured() {
        let fake = Fake::new(false);
        let err = Watcher::start(&fake, WatchConfig::default(), Arc::new(Mutex::new(Held::default())), Instant::now()).err().expect("refused");
        assert_eq!(err.code(), "unsupported");
        assert!(err.detail().contains("excluded ones can be respected"));
    }

    #[test]
    fn pause_stops_looking_at_once_and_resume_reads_the_screen_afresh() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(page(5));
        w.tick(&fake, t0);
        w.pause();
        assert_eq!(w.status(), Status::Paused);
        let before = fake.captures.load(Ordering::SeqCst);
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(3)), Tick::Paused);
        assert_eq!(fake.captures.load(Ordering::SeqCst), before, "no picture while paused");
        w.resume(t0 + Duration::from_secs(5));
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(6)), Tick::Settling);
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(9)), Tick::Reported, "the same screen is read again after a pause");
        w.stop();
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(12)), Tick::Stopped);
        assert!(w.poll(t0 + Duration::from_secs(13)).pending.is_none(), "stopping drops what was waiting");
    }

    #[test]
    fn if_the_page_stops_asking_the_watcher_stops_itself() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(page(5));
        w.tick(&fake, t0 + Duration::from_secs(5));
        w.poll(t0 + Duration::from_secs(10));
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(25)), Tick::Reported, "asked 15 seconds ago: still watching");
        assert_eq!(w.tick(&fake, t0 + Duration::from_secs(40)), Tick::PageGone, "nobody asked for 30 seconds");
        assert_eq!(w.status(), Status::Stopped);
        let polled = w.poll(t0 + Duration::from_secs(41));
        assert_eq!(polled.stopped_because, Some("page-gone"));
        let held_after = fake.captures.load(Ordering::SeqCst);
        w.tick(&fake, t0 + Duration::from_secs(50));
        assert_eq!(fake.captures.load(Ordering::SeqCst), held_after, "and takes no more pictures");
    }

    #[test]
    fn a_failing_capture_or_window_list_is_a_failed_look_not_a_crash_and_takes_no_picture_it_cannot_vet() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        assert!(matches!(w.tick(&fake, t0), Tick::Failed(_)), "nothing to capture");
        let blind = Fake::new(true);
        let mut v = watcher(&blind, t0);
        let flaky = Fake { can_list: false, ..Fake::new(false) };
        assert!(matches!(v.tick(&flaky, t0), Tick::Failed(_)));
        assert_eq!(flaky.captures.load(Ordering::SeqCst), 0, "if exclusions cannot be checked, no picture is taken");
    }

    #[test]
    fn the_interval_is_kept_within_bounds() {
        assert_eq!(WatchConfig::default().with_interval_ms(10).interval, Duration::from_millis(1500));
        assert_eq!(WatchConfig::default().with_interval_ms(999_999).interval, Duration::from_secs(30));
        assert_eq!(WatchConfig::default().with_interval_ms(4000).interval, Duration::from_secs(4));
    }
}
