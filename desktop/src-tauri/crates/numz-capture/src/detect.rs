//! Local screen-change detection: the cheap half of hybrid capture. It decides, on this machine and without sending anything anywhere,
//! whether the screen has changed in a way that is worth reading, so the cloud model is asked only about new content.
//!
//! A picture is reduced to a grid of average brightness with cells about 6 screen pixels across (a 1920x1080 screen is 320x180 cells; the grid
//! is capped at 640x360), so a single digit, word or token of code that changes moves several cells by a lot, whatever the screen size.
//! Three things are decided from successive looks:
//!
//!  * SETTLED: two looks in a row agree (no cell moved by more than `cell_delta`), so a scroll, a page load or someone typing is waited out;
//!  * NEW: a settled screen is new when at least one cell differs from the screen last reported (any edit to text, numbers or code counts);
//!  * NOT NEW: a settled screen that matches the last reported one, however many times it is seen, is never reported again.
//!
//! Small things that move on their own would defeat both rules (a text caret that blinks never lets the screen settle; a clock that ticks
//! looks like an edit every minute), so places that keep moving are learned and ignored. The screen is divided into tiles of 4x4 cells (about
//! 24 pixels, a character or two); a tile is "flickering" once its recent moves add up to `flicker_score`: a look in which something in it
//! moved back to what it showed two looks earlier (a blink) counts 1.0, any other small move counts 0.5, and the total fades slowly. Only
//! SMALL moves are held against a tile (a scroll or a new page moves thousands of cells and teaches nothing), and a change as big as a new
//! page forgets what was learned. A real edit made once, twice or three times to the same place is never mistaken for flicker.

use image::imageops::{self, FilterType};
use image::RgbaImage;

/// About how many screen pixels one cell covers, across.
const CELL_PX: u32 = 6;
/// Flicker is remembered per tile of this many cells across and down.
const TILE: usize = 4;
const MAX_GRID: (u32, u32) = (640, 360);
const MIN_GRID: (u32, u32) = (32, 18);

#[derive(Clone)]
pub struct Signature {
    width: u32,
    height: u32,
    cells: Vec<u8>,
}

/// The grid for a screen of this size: cells of about `CELL_PX` pixels, never fewer than 32x18 or more than 640x360.
pub fn grid_for(width: u32, height: u32) -> (u32, u32) {
    ((width.div_ceil(CELL_PX)).clamp(MIN_GRID.0, MAX_GRID.0), (height.div_ceil(CELL_PX)).clamp(MIN_GRID.1, MAX_GRID.1))
}

pub fn signature(image: &RgbaImage) -> Signature {
    let (width, height) = grid_for(image.width(), image.height());
    let small = imageops::resize(image, width, height, FilterType::Triangle);
    let cells = small
        .pixels()
        .map(|px| {
            let [r, g, b, _] = px.0;
            ((299 * r as u32 + 587 * g as u32 + 114 * b as u32) / 1000) as u8
        })
        .collect();
    Signature { width, height, cells }
}

#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// A cell counts as changed when its brightness (0..255) moved by more than this.
    pub cell_delta: u8,
    /// How many changed cells (not counting flickering ones) make a settled screen a new one.
    pub change_cells: usize,
    /// Two looks agree (the screen has settled) when at most this many cells moved between them.
    pub settle_cells: usize,
    /// A look-to-look change of at most this many cells is small enough to be held against a cell as flicker.
    pub sparse_cells: usize,
    /// A tile of the screen is ignored once its flicker score reaches this.
    pub flicker_score: f32,
    /// The score is multiplied by this on every look (so the memory fades over some minutes).
    pub flicker_decay: f32,
    /// A change touching this share of the screen is a new page: what was learned about flicker is forgotten.
    pub new_screen_fraction: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self { cell_delta: 16, change_cells: 1, settle_cells: 0, sparse_cells: 200, flicker_score: 1.75, flicker_decay: 0.995, new_screen_fraction: 0.02 }
    }
}

fn moved_cells(a: &Signature, b: &Signature, delta: u8) -> Vec<usize> {
    a.cells.iter().zip(b.cells.iter()).enumerate().filter(|(_, (x, y))| x.abs_diff(**y) > delta).map(|(i, _)| i).collect()
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Verdict {
    /// The screen is the one already reported (or nothing worth reporting has changed).
    Unchanged,
    /// The screen is still changing: wait for it to settle.
    Settling,
    /// A new screen, settled: read it.
    Changed,
}

pub struct Detector {
    config: Config,
    reported: Option<Signature>,
    previous: Option<Signature>,
    before_previous: Option<Signature>,
    /// Flicker score per tile.
    scores: Vec<f32>,
}

impl Detector {
    pub fn new(config: Config) -> Self {
        Self { config, reported: None, previous: None, before_previous: None, scores: Vec::new() }
    }

    /// Forget what was reported and what was learned (a new session, or a pause): the next settled screen is reported.
    pub fn reset(&mut self) {
        self.reported = None;
        self.previous = None;
        self.before_previous = None;
        self.scores.clear();
    }

    pub fn observe(&mut self, now: Signature) -> Verdict {
        let cfg = self.config;
        // A different screen size (another display, a changed resolution) is a different screen: start again.
        if self.previous.as_ref().is_some_and(|p| (p.width, p.height) != (now.width, now.height)) {
            self.reset();
        }
        let (width, tiles_across) = (now.width as usize, (now.width as usize).div_ceil(TILE));
        let tile_of = |c: usize| (c / width / TILE) * tiles_across + (c % width) / TILE;
        let tiles = tiles_across * (now.height as usize).div_ceil(TILE);
        if self.scores.len() != tiles {
            self.scores = vec![0.0; tiles];
        }
        let Some(previous) = self.previous.take() else {
            self.previous = Some(now);
            return Verdict::Settling;
        };
        let before = self.before_previous.take();

        // What moved since the last look, and what that teaches about cells that move on their own.
        let moved = moved_cells(&previous, &now, cfg.cell_delta);
        self.scores.iter_mut().for_each(|s| *s *= cfg.flicker_decay);
        if moved.len() <= cfg.sparse_cells {
            // One count per tile per look: 1.0 if something in it went back to what it showed two looks ago, otherwise 0.5.
            let mut touched: Vec<(usize, bool)> = moved
                .iter()
                .map(|&c| (tile_of(c), before.as_ref().is_some_and(|b| b.cells[c].abs_diff(now.cells[c]) <= cfg.cell_delta)))
                .collect();
            touched.sort_unstable();
            touched.dedup_by(|next, kept| next.0 == kept.0 && {
                kept.1 |= next.1;
                true
            });
            for (tile, back_to_before) in touched {
                self.scores[tile] += if back_to_before { 1.0 } else { 0.5 };
            }
        }
        self.before_previous = Some(previous);
        self.previous = Some(now.clone());

        let scores = &self.scores;
        let flickering = |c: usize| scores[tile_of(c)] >= cfg.flicker_score;
        if moved.iter().filter(|&&c| !flickering(c)).count() > cfg.settle_cells {
            return Verdict::Settling;
        }

        // Settled. Is it new?
        let Some(reported) = self.reported.as_mut() else {
            self.reported = Some(now);
            return Verdict::Changed;
        };
        let mut differing = 0usize;
        let cells = now.cells.len();
        for c in 0..cells {
            if flickering(c) {
                reported.cells[c] = now.cells[c]; // a cell that moves on its own is not part of what was reported
            } else if reported.cells[c].abs_diff(now.cells[c]) > cfg.cell_delta {
                differing += 1;
            }
        }
        if differing >= cfg.change_cells {
            *reported = now;
            if differing as f32 / cells as f32 >= cfg.new_screen_fraction {
                self.scores.iter_mut().for_each(|s| *s = 0.0);
            }
            Verdict::Changed
        } else {
            Verdict::Unchanged
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testscreen::{caret, clock, lines, page};
    use image::Rgba;

    /// The same screen seen `times` times in a row (its signature is made once: the pictures are large).
    fn feed(detector: &mut Detector, image: &RgbaImage, times: usize) -> Vec<Verdict> {
        let sig = signature(image);
        (0..times).map(|_| detector.observe(sig.clone())).collect()
    }
    fn count(verdicts: &[Verdict], wanted: Verdict) -> usize {
        verdicts.iter().filter(|v| **v == wanted).count()
    }
    /// A full page of text in which line `at` reads `text`.
    fn with_line(width: u32, height: u32, at: usize, text: &str) -> RgbaImage {
        let mut all = lines(30);
        all[at] = text.to_string();
        page(width, height, &all)
    }

    #[test]
    fn the_first_screen_is_reported_once_it_has_settled_and_not_again() {
        let mut d = Detector::new(Config::default());
        let s = page(1600, 900, &lines(30));
        assert_eq!(feed(&mut d, &s, 4), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged, Verdict::Unchanged]);
    }

    #[test]
    fn an_unchanged_screen_is_never_reported_twice_however_long_it_is_watched() {
        let mut d = Detector::new(Config::default());
        let verdicts = feed(&mut d, &page(1920, 1080, &lines(40)), 60);
        assert_eq!(count(&verdicts, Verdict::Changed), 1, "once, and never again");
        assert_eq!(count(&verdicts, Verdict::Settling), 1, "only the very first look is waiting");
    }

    #[test]
    fn a_new_page_is_reported_once_and_only_after_it_stops_changing() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &page(1600, 900, &lines(10)), 3);
        let loading = [page(1600, 900, &lines(14)), page(1600, 900, &lines(20)), page(1600, 900, &lines(26)), page(1600, 900, &lines(26)), page(1600, 900, &lines(26))];
        let verdicts: Vec<_> = loading.iter().map(|s| d.observe(signature(s))).collect();
        assert_eq!(verdicts, vec![Verdict::Settling, Verdict::Settling, Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "a page still loading is waited out");
    }

    #[test]
    fn a_single_changed_digit_on_a_full_page_is_noticed_at_every_common_screen_size() {
        for (w, h) in [(1280, 720), (1600, 900), (1920, 1080), (2560, 1440)] {
            let mut d = Detector::new(Config::default());
            feed(&mut d, &with_line(w, h, 9, "x = 12 + 7; (4 + 5) = 9"), 3);
            let verdicts = feed(&mut d, &with_line(w, h, 9, "x = 13 + 7; (4 + 5) = 9"), 3);
            assert_eq!(verdicts, vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "12 -> 13 at {w}x{h}");
        }
    }

    #[test]
    fn changes_to_numbers_text_and_code_are_not_ignored() {
        let edits = [
            ("a number in a sum", "x = 12 + 7; abc de", "x = 12 + 9; abc de"),
            ("a digit in a result", "(4 + 5) = 9 dead", "(4 + 5) = 8 dead"),
            ("a letter in a word", "bead cab dead cede", "beac cab dead cede"),
            ("a variable in code", "a = b + c; e = 3 + 8;", "a = b + d; e = 3 + 8;"),
            ("a closing bracket", "(4 + 5) = 9 x = 1;", "(4 + 5 = 9 x = 1;"),
            ("one added character", "cab dead ace", "cab dead acee"),
            ("the first character of a line", "6 + 2 = 8 abc", "5 + 2 = 8 abc"),
        ];
        for (what, before, after) in edits {
            let mut d = Detector::new(Config::default());
            feed(&mut d, &with_line(1600, 900, 12, before), 3);
            let verdicts = feed(&mut d, &with_line(1600, 900, 12, after), 3);
            assert_eq!(verdicts, vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "{what}: {before:?} -> {after:?}");
        }
    }

    #[test]
    fn an_edit_in_progress_is_waited_out_and_read_once_when_it_stops() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &with_line(1600, 900, 5, "x = 1"), 3);
        let typing = ["x = 12", "x = 12 +", "x = 12 + 7", "x = 12 + 7;", "x = 12 + 7;", "x = 12 + 7;"];
        let verdicts: Vec<_> = typing.iter().map(|t| d.observe(signature(&with_line(1600, 900, 5, t)))).collect();
        assert_eq!(count(&verdicts, Verdict::Changed), 1, "{verdicts:?}");
        assert_eq!(verdicts[..4], [Verdict::Settling; 4], "while characters keep arriving it waits");
        assert_eq!(verdicts[4], Verdict::Changed, "and reads the finished line");
    }

    #[test]
    fn editing_the_same_place_twice_is_noticed_both_times() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &with_line(1600, 900, 8, "x = 12 + 7;"), 3);
        assert!(feed(&mut d, &with_line(1600, 900, 8, "x = 13 + 7;"), 3).contains(&Verdict::Changed));
        assert!(feed(&mut d, &with_line(1600, 900, 8, "x = 14 + 7;"), 3).contains(&Verdict::Changed), "a second edit is not mistaken for flicker");
        assert!(feed(&mut d, &with_line(1600, 900, 8, "x = 12 + 7;"), 3).contains(&Verdict::Changed), "and going back to what it said before is an edit too");
    }

    #[test]
    fn a_blinking_text_caret_neither_blocks_the_screen_settling_nor_counts_as_a_new_screen() {
        let mut d = Detector::new(Config::default());
        let base = page(1600, 900, &lines(30));
        let mut with_caret = base.clone();
        caret(&mut with_caret, 700, 400);
        feed(&mut d, &base, 3);
        let blinks: Vec<_> = (0..30).map(|i| d.observe(signature(if i % 2 == 0 { &with_caret } else { &base }))).collect();
        assert!(count(&blinks[..], Verdict::Changed) <= 1, "at most one read while the caret is still being learned: {blinks:?}");
        assert_eq!(count(&blinks[10..], Verdict::Changed), 0, "never once it is known");
        assert_eq!(blinks[20..], [Verdict::Unchanged; 10], "and the screen settles");
    }

    #[test]
    fn an_irregular_blink_is_learned_too() {
        let mut d = Detector::new(Config::default());
        let base = page(1600, 900, &lines(30));
        let mut with_caret = base.clone();
        caret(&mut with_caret, 700, 400);
        feed(&mut d, &base, 3);
        let pattern = [1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0];
        let verdicts: Vec<_> = pattern.iter().map(|on| d.observe(signature(if *on == 1 { &with_caret } else { &base }))).collect();
        assert!(count(&verdicts, Verdict::Changed) <= 2, "{verdicts:?}");
        assert_eq!(count(&verdicts[18..], Verdict::Changed), 0, "{verdicts:?}");
    }

    #[test]
    fn a_clock_ticking_every_look_is_learned_and_ignored_but_a_real_edit_beside_it_is_not() {
        let mut d = Detector::new(Config::default());
        let screens: Vec<Signature> = (0..60)
            .map(|s| {
                let mut screen = page(1600, 900, &lines(30));
                clock(&mut screen, &format!("12:00:{s:02}"));
                signature(&screen)
            })
            .collect();
        for _ in 0..3 {
            d.observe(screens[0].clone());
        }
        let verdicts: Vec<_> = screens[1..].iter().map(|s| d.observe(s.clone())).collect();
        assert!(count(&verdicts, Verdict::Changed) <= 4, "a ticking clock costs a few reads while it is learned, not one per tick: {verdicts:?}");
        assert_eq!(count(&verdicts[40..], Verdict::Changed), 0, "and none once it is known: {verdicts:?}");
        assert_eq!(verdicts[44..], [Verdict::Unchanged; 15], "the screen is not held unsettled by it");
        // the page is edited while the clock keeps ticking
        let mut edited = with_line(1600, 900, 11, "x = 13 + 7;");
        clock(&mut edited, "12:01:00");
        let after = feed(&mut d, &edited, 3);
        assert!(after.contains(&Verdict::Changed), "{after:?}");
    }

    #[test]
    fn a_clock_that_ticks_once_a_minute_is_read_a_few_times_and_then_ignored() {
        let mut d = Detector::new(Config::default());
        let screen = |minute: u32| {
            let mut s = page(1600, 900, &lines(30));
            clock(&mut s, &format!("12:{:02}", minute % 60));
            signature(&s)
        };
        let first = screen(0);
        for _ in 0..3 {
            d.observe(first.clone());
        }
        let mut changed_at = vec![];
        for minute in 1..=12 {
            // 24 looks (a minute at the 2.5 s interval) of the same minute, the first of which sees the tick
            let sig = screen(minute);
            let verdicts: Vec<_> = (0..24).map(|_| d.observe(sig.clone())).collect();
            if verdicts.contains(&Verdict::Changed) {
                changed_at.push(minute);
            }
        }
        assert!(changed_at.len() <= 5, "a ticking clock must stop costing reads: read at minutes {changed_at:?}");
        assert!(changed_at.iter().all(|m| *m <= 6), "and from the sixth minute on it is ignored: {changed_at:?}");
    }

    #[test]
    fn a_big_change_forgets_what_was_learned_about_flicker() {
        let mut d = Detector::new(Config::default());
        let base = page(1600, 900, &lines(30));
        let mut with_caret = base.clone();
        caret(&mut with_caret, 700, 400);
        feed(&mut d, &base, 3);
        for i in 0..20 {
            d.observe(signature(if i % 2 == 0 { &with_caret } else { &base }));
        }
        // a completely different page arrives, and the caret is in the same place on it
        let mut next = page(1600, 900, &lines(24));
        caret(&mut next, 700, 400);
        assert!(feed(&mut d, &next, 3).contains(&Verdict::Changed));
        let mut edited = next.clone();
        for x in 700..712 {
            for y in 400..414 {
                edited.put_pixel(x, y, Rgba([240, 240, 240, 255]));
            }
        }
        assert!(feed(&mut d, &edited, 3).contains(&Verdict::Changed), "text where the caret used to blink counts again");
    }

    #[test]
    fn reset_forgets_what_was_reported() {
        let mut d = Detector::new(Config::default());
        let s = page(1600, 900, &lines(30));
        feed(&mut d, &s, 3);
        d.reset();
        assert_eq!(feed(&mut d, &s, 2), vec![Verdict::Settling, Verdict::Changed]);
    }

    #[test]
    fn the_grid_follows_the_screen_size_at_about_six_pixels_a_cell_and_is_capped() {
        assert_eq!(grid_for(1920, 1080), (320, 180));
        assert_eq!(grid_for(1280, 720), (214, 120));
        assert_eq!(grid_for(3840, 2160), (640, 360), "a 4K screen is capped (cells of 6 px would be 640x360)");
        assert_eq!(grid_for(7680, 4320), (640, 360));
        assert_eq!(grid_for(100, 50), (32, 18), "and never smaller than 32x18");
        let a = signature(&page(1600, 900, &lines(30)));
        assert_eq!((a.width, a.height), (267, 150));
        assert_eq!(a.cells.len(), 267 * 150);
        assert!(moved_cells(&a, &a, 0).is_empty(), "a screen does not differ from itself");
    }

    #[test]
    fn a_different_screen_size_is_a_new_screen_not_a_crash() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &page(1600, 900, &lines(30)), 3);
        assert_eq!(feed(&mut d, &page(1920, 1080, &lines(30)), 3), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "another display, or a changed resolution");
    }
}
