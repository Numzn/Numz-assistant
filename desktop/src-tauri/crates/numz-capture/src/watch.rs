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

use crate::detect::{signature_without, Area, Config as DetectConfig, Detector, Verdict};
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
    /// Applications whose windows are left out of change detection (not out of the picture): this app's own, so that what it shows about the
    /// study session (counters, answers arriving) cannot make the screen look new. Matched against the window's application name.
    pub ignore_apps: Vec<String>,
    pub detect: DetectConfig,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self { interval: Duration::from_millis(2500), min_gap: Duration::from_secs(10), poll_timeout: Duration::from_secs(20), exclude_apps: vec![], exclude_titles: vec![], ignore_apps: vec![], detect: DetectConfig::default() }
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

    /// Where the ignored applications' windows are on the screen (those whose position the desktop reports).
    fn ignored_areas(&self, windows: &[crate::WindowInfo]) -> Vec<Area> {
        let wanted: Vec<String> = self.config.ignore_apps.iter().map(|a| a.trim().to_lowercase()).filter(|a| a.len() >= 3).collect();
        windows
            .iter()
            .filter(|w| {
                let app = w.app.to_lowercase();
                wanted.iter().any(|a| app.contains(a.as_str()))
            })
            .filter_map(|w| Some(Area { x: w.x?, y: w.y?, width: w.width, height: w.height }))
            .collect()
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
        let ignored = self.ignored_areas(&windows);
        match self.detector.observe(signature_without(&image, &ignored)) {
            Verdict::Settling => Tick::Settling,
            Verdict::Unchanged => Tick::Unchanged,
            Verdict::Changed => {
                let (width, height) = image.dimensions();
                // No preview picture: a study session never shows the screen it read, and making one cost a full resize and encode of the
                // screen for every report (about as long as preparing the picture to read), on the thread that looks at the screen.
                let preview = String::new();
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
        WindowInfo { id: "1".into(), title: title.into(), app: app.into(), width: 800, height: 600, x: None, y: None }
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
        assert!(polled.pending.as_ref().is_some_and(|p| p.preview.is_empty() && p.capture_id.starts_with("cap-")), "a reported screen carries no preview picture");
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

    // ---- the automatic flow: unchanged screens, edits, stability, the gap ---------------------------------------------------------

    /// A 1280x720 question page whose line 6 reads `answer`.
    fn question_page(answer: &str) -> RgbaImage {
        let mut all = crate::testscreen::lines(28);
        all[6] = answer.to_string();
        crate::testscreen::page(1280, 720, &all)
    }
    fn secs(t0: Instant, s: f32) -> Instant {
        t0 + Duration::from_secs_f32(s)
    }

    #[test]
    fn an_unchanged_screen_is_looked_at_all_session_and_captured_exactly_once() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(question_page("x = 12 + 7;"));
        let mut reported = 0;
        for i in 0..80 {
            let now = secs(t0, i as f32 * 2.5);
            if w.tick(&fake, now) == Tick::Reported {
                reported += 1;
            }
            w.poll(now); // the page keeps asking, so the watcher stays alive
        }
        assert_eq!(reported, 1, "the same screen is one capture, not one every ten seconds");
        assert!(fake.captures.load(Ordering::SeqCst) >= 70, "but it is still being looked at every interval");
    }

    #[test]
    fn a_small_edit_is_captured_by_itself_after_the_screen_settles() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(question_page("x = 12 + 7;"));
        assert_eq!(w.tick(&fake, secs(t0, 0.0)), Tick::Settling);
        assert_eq!(w.tick(&fake, secs(t0, 2.5)), Tick::Reported, "the first screen");
        assert!(w.poll(secs(t0, 3.0)).pending.is_some());
        // one digit changes after the minimum gap has passed
        fake.show(question_page("x = 13 + 7;"));
        assert_eq!(w.tick(&fake, secs(t0, 15.0)), Tick::Settling, "the screen has changed: wait until it has stopped");
        assert_eq!(w.tick(&fake, secs(t0, 17.5)), Tick::Reported, "and then it is captured, with nobody asking");
        let polled = w.poll(secs(t0, 18.0));
        assert!(polled.pending.is_some_and(|p| p.capture_id.starts_with("cap-")));
        assert_eq!(polled.stats.reported, 2);
        assert_eq!(w.tick(&fake, secs(t0, 30.0)), Tick::Unchanged, "and it is not captured again");
    }

    #[test]
    fn a_screen_that_is_still_changing_is_never_captured_until_it_stops() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(question_page("x = 1"));
        w.tick(&fake, secs(t0, 0.0));
        w.tick(&fake, secs(t0, 2.5));
        w.poll(secs(t0, 3.0));
        let typing = ["x = 12", "x = 12 +", "x = 12 + 7", "x = 12 + 7;"];
        for (i, text) in typing.iter().enumerate() {
            fake.show(question_page(text));
            let now = secs(t0, 15.0 + i as f32 * 2.5);
            assert_eq!(w.tick(&fake, now), Tick::Settling, "while characters keep arriving nothing is captured: {text:?}");
            w.poll(now);
        }
        assert_eq!(w.tick(&fake, secs(t0, 25.0)), Tick::Reported, "the first look that matches the one before it: the finished line, once, after the typing stopped");
        assert_eq!(w.poll(secs(t0, 26.0)).stats.reported, 2, "one capture for the whole edit");
        assert_eq!(w.tick(&fake, secs(t0, 40.0)), Tick::Unchanged);
    }

    #[test]
    fn captures_are_never_closer_together_than_the_minimum_gap_and_a_change_made_inside_it_is_not_lost() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(question_page("x = 12 + 7;"));
        let mut report_times = vec![];
        let mut t = 0.0f32;
        while t <= 120.0 {
            // something different on the page changes every 8 seconds, a new place each time: faster than captures are allowed
            let n = (t / 8.0) as usize;
            let mut all = crate::testscreen::lines(28);
            all[2 + n % 14] = format!("x = {} + 7;", n % 10);
            fake.show(crate::testscreen::page(1280, 720, &all));
            if w.tick(&fake, secs(t0, t)) == Tick::Reported {
                report_times.push(t);
            }
            w.poll(secs(t0, t));
            t += 2.5;
        }
        assert!(report_times.len() >= 5, "changes are captured, not dropped: {report_times:?}");
        assert!(report_times.windows(2).all(|pair| pair[1] - pair[0] >= 10.0), "never two captures within ten seconds: {report_times:?}");
        // one specific change inside the gap: made 2 s after a capture, taken as soon as the gap is over
        let fake2 = Fake::new(true);
        let mut v = watcher(&fake2, t0);
        fake2.show(question_page("x = 12 + 7;"));
        v.tick(&fake2, secs(t0, 0.0));
        assert_eq!(v.tick(&fake2, secs(t0, 2.5)), Tick::Reported);
        fake2.show(question_page("x = 19 + 7;"));
        for now in [5.0, 7.5, 10.0, 12.0] {
            assert_eq!(v.tick(&fake2, secs(t0, now)), Tick::Throttled, "inside the gap at {now}");
            v.poll(secs(t0, now));
        }
        assert_eq!(v.tick(&fake2, secs(t0, 13.0)), Tick::Settling);
        assert_eq!(v.tick(&fake2, secs(t0, 15.5)), Tick::Reported, "the change made inside the gap is captured right after it");
    }

    #[test]
    fn a_change_made_while_something_excluded_is_open_is_never_captured_and_is_read_after_it_closes() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(question_page("x = 12 + 7;"));
        w.tick(&fake, secs(t0, 0.0));
        assert_eq!(w.tick(&fake, secs(t0, 2.5)), Tick::Reported);
        w.poll(secs(t0, 3.0));
        let before = fake.captures.load(Ordering::SeqCst);
        fake.windows.lock().unwrap().push(win("1Password", "Vault"));
        fake.show(question_page("x = 13 + 7;"));
        for i in 0..8 {
            let now = secs(t0, 15.0 + i as f32 * 2.5);
            assert_eq!(w.tick(&fake, now), Tick::Skipped(Reason::PasswordManagerOrSignIn));
            w.poll(now);
        }
        assert_eq!(fake.captures.load(Ordering::SeqCst), before, "not one picture while it is open, whatever changed");
        fake.windows.lock().unwrap().pop();
        assert_eq!(w.tick(&fake, secs(t0, 40.0)), Tick::Settling);
        assert_eq!(w.tick(&fake, secs(t0, 42.5)), Tick::Reported, "the screen as it is now");
    }

    #[test]
    fn nothing_is_captured_while_paused_even_if_the_screen_changes_and_after_stop_nothing_is_kept() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        fake.show(question_page("x = 12 + 7;"));
        w.tick(&fake, secs(t0, 0.0));
        w.tick(&fake, secs(t0, 2.5));
        w.poll(secs(t0, 3.0));
        w.pause();
        fake.show(question_page("x = 13 + 7;"));
        let looks = fake.captures.load(Ordering::SeqCst);
        for i in 0..6 {
            assert_eq!(w.tick(&fake, secs(t0, 15.0 + i as f32 * 2.5)), Tick::Paused);
        }
        assert_eq!(fake.captures.load(Ordering::SeqCst), looks, "no picture while paused");
        w.resume(secs(t0, 31.0));
        assert_eq!(w.tick(&fake, secs(t0, 32.0)), Tick::Settling);
        assert_eq!(w.tick(&fake, secs(t0, 34.5)), Tick::Reported);
        w.stop();
        fake.show(question_page("x = 14 + 7;"));
        let looks = fake.captures.load(Ordering::SeqCst);
        assert_eq!(w.tick(&fake, secs(t0, 50.0)), Tick::Stopped);
        assert_eq!(fake.captures.load(Ordering::SeqCst), looks, "and none after the session ends");
        assert!(w.poll(secs(t0, 51.0)).pending.is_none());
    }

    #[test]
    fn someone_paging_and_scrolling_through_material_is_captured_at_every_view_that_rests_and_never_closer_than_the_gap() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let mut w = watcher(&fake, t0);
        let doc = crate::testscreen::lines(80);
        let view = |first: usize| crate::testscreen::page(1280, 720, &doc[first..first + 24]);
        // seconds -> the view on screen: rests, scrolls (changing at every look), rests, jumps back, rests
        let script: Vec<(f32, usize)> = (0..60)
            .map(|i| {
                let t = i as f32 * 2.5;
                let first = match t {
                    t if t < 20.0 => 0,                                  // rests on the first view
                    t if t < 30.0 => ((t - 20.0) / 2.5) as usize * 5 + 5, // scrolls: a different view at every look
                    t if t < 60.0 => 22,                                  // rests further down
                    t if t < 90.0 => 47,                                  // rests further down still (the sample text repeats every 18 lines)
                    _ => 0,                                               // goes back to the top
                };
                (t, first)
            })
            .collect();
        let mut reported = vec![];
        for (t, first) in &script {
            fake.show(view(*first));
            let tick = w.tick(&fake, secs(t0, *t));
            if tick == Tick::Reported {
                reported.push((*t, *first));
            }
            w.poll(secs(t0, *t));
        }
        let views: Vec<usize> = reported.iter().map(|(_, first)| *first).collect();
        assert_eq!(views, vec![0, 22, 47, 0], "each view that rested was captured once, in order, and the scroll in between was not: {reported:?}");
        assert!(reported.windows(2).all(|pair| pair[1].0 - pair[0].0 >= 10.0), "never closer than the minimum gap: {reported:?}");
    }

    #[test]
    fn what_this_app_shows_about_the_study_session_does_not_make_the_screen_look_new() {
        let fake = Fake::new(true);
        let t0 = Instant::now();
        let config = WatchConfig { ignore_apps: vec!["numz-ai-desktop".into()], ..WatchConfig::default() };
        let mut w = Watcher::start(&fake, config, Arc::new(Mutex::new(Held::default())), t0).unwrap();
        // this app's window sits at the right of the screen, and shows a counter that changes every look
        *fake.windows.lock().unwrap() = vec![win("firefox", "Lecture 3"), WindowInfo { id: "9".into(), title: "NUMZ AI".into(), app: "numz-ai-desktop".into(), width: 440, height: 700, x: Some(800), y: Some(10) }];
        let screen = |counter: u32, answer: &str| {
            let mut s = question_page(answer);
            crate::testscreen::draw_text(&mut s, 840, 120, &format!("sent {counter} read {counter}"), 2);
            s
        };
        fake.show(screen(0, "x = 12 + 7;"));
        w.tick(&fake, secs(t0, 0.0));
        assert_eq!(w.tick(&fake, secs(t0, 2.5)), Tick::Reported);
        w.poll(secs(t0, 3.0));
        let mut reported_again = 0;
        for i in 1..=40 {
            fake.show(screen(i, "x = 12 + 7;"));
            let now = secs(t0, 3.0 + i as f32 * 2.5);
            if w.tick(&fake, now) == Tick::Reported {
                reported_again += 1;
            }
            w.poll(now);
        }
        assert_eq!(reported_again, 0, "the app's own counters and messages are never a reason to read the screen again");
        // but a change on the person's own page, beside it, is
        fake.show(screen(41, "x = 13 + 7;"));
        let mut seen = vec![];
        for i in 0..4 {
            let now = secs(t0, 110.0 + i as f32 * 2.5);
            seen.push(w.tick(&fake, now));
            w.poll(now);
        }
        assert!(seen.contains(&Tick::Reported), "{seen:?}");
    }

    #[test]
    fn the_defaults_are_the_ones_the_study_session_promises() {
        let config = WatchConfig::default();
        assert_eq!(config.interval, Duration::from_millis(2500), "a look every 2.5 seconds");
        assert_eq!(config.min_gap, Duration::from_secs(10), "captures at least 10 seconds apart");
        assert_eq!(config.poll_timeout, Duration::from_secs(20), "a page that stops asking for 20 seconds is gone");
    }

    #[test]
    fn the_interval_is_kept_within_bounds() {
        assert_eq!(WatchConfig::default().with_interval_ms(10).interval, Duration::from_millis(1500));
        assert_eq!(WatchConfig::default().with_interval_ms(999_999).interval, Duration::from_secs(30));
        assert_eq!(WatchConfig::default().with_interval_ms(4000).interval, Duration::from_secs(4));
    }
}
