//! Local screen-change detection: the cheap half of hybrid capture. It decides, on this machine and without sending anything anywhere,
//! whether the screen has changed in a way that is worth reading, so the cloud model is asked only about new content.
//!
//! A picture is reduced to a luminance plane (brightness only, averaged down so that it is at most 1280 pixels wide: 1920x1080 is averaged
//! 2x2, 4K 3x3). Two planes are compared in blocks of 4x4 plane pixels, by the SUM of the absolute differences inside each block (not by the
//! difference of the block averages: moving or redrawing a thin stroke leaves an average almost unchanged but changes the sum a lot, and a
//! single digit, word or token of code is exactly that). A block is "moved" when that sum reaches `block_sad`. A capture of an unchanged
//! screen is identical, so any real edit stands out. Three things are decided from successive looks:
//!
//!  * SETTLED: two looks in a row agree (no block moved), so a scroll, a page load or someone typing is waited out;
//!  * NEW: a settled screen is new when at least one block differs from the screen last reported (any edit to text, numbers or code counts);
//!  * NOT NEW: a settled screen that matches the last reported one, however many times it is seen, is never reported again.
//!
//! Small things that move on their own would defeat both rules (a text caret that blinks never lets the screen settle; a clock that ticks
//! looks like an edit every minute), so places that keep moving are learned and ignored. The screen is divided into tiles of 4x4 blocks
//! (a character or two across); a tile is "flickering" once its recent moves add up to `flicker_score`: a look in which something in it
//! moved back to what it showed two looks earlier (a blink) counts 1.0, any other small move counts 0.5, and the total fades slowly. Only
//! SMALL moves are held against a tile (a scroll or a new page moves thousands of blocks and teaches nothing), and a change as big as a new
//! page forgets what was learned. A real edit made once, twice or three times to the same place is never mistaken for flicker.

use image::RgbaImage;

/// The widest plane compared: wider screens are averaged down by a whole number to fit.
const MAX_PLANE_WIDTH: usize = 1280;
/// Plane pixels per block side.
const BLOCK: usize = 4;
/// Flicker is remembered per tile of this many blocks across and down.
const TILE: usize = 4;

#[derive(Clone)]
pub struct Signature {
    width: usize,
    height: usize,
    /// Screen pixels per plane pixel, across and down.
    factor: usize,
    plane: Vec<u8>,
}

/// A rectangle of the screen, in screen pixels (the top-left corner can be off the screen: a window half dragged out of view).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn signature(image: &RgbaImage) -> Signature {
    signature_without(image, &[])
}

/// The signature with some areas left out: every plane pixel inside one is set to a fixed value, so whatever happens inside it, in this look
/// or any other, is never a difference. Used for this app's own window: what NUMZ AI itself shows (an answer arriving, a counter) is not
/// what is being studied and must not make the screen look new.
pub fn signature_without(image: &RgbaImage, ignore: &[Area]) -> Signature {
    let factor = (image.width() as usize).div_ceil(MAX_PLANE_WIDTH).max(1);
    let (width, height) = ((image.width() as usize / factor).max(1), (image.height() as usize / factor).max(1));
    let stride = image.width() as usize * 4;
    let raw = image.as_raw();
    let mut plane = vec![0u8; width * height];
    let weight = (factor * factor) as u32 * 1000;
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0u32;
            for dy in 0..factor {
                let row = (y * factor + dy) * stride + x * factor * 4;
                for dx in 0..factor {
                    let p = row + dx * 4;
                    sum += 299 * raw[p] as u32 + 587 * raw[p + 1] as u32 + 114 * raw[p + 2] as u32;
                }
            }
            plane[y * width + x] = (sum / weight) as u8;
        }
    }
    for area in ignore {
        let f = factor as f64;
        let first_col = (area.x as f64 / f).floor().max(0.0) as usize;
        let first_row = (area.y as f64 / f).floor().max(0.0) as usize;
        let last_col = (((area.x as f64 + area.width as f64) / f).ceil().max(0.0) as usize).min(width);
        let last_row = (((area.y as f64 + area.height as f64) / f).ceil().max(0.0) as usize).min(height);
        for row in first_row..last_row {
            for col in first_col..last_col {
                plane[row * width + col] = 0;
            }
        }
    }
    Signature { width, height, factor, plane }
}

#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// A 4x4 block counts as moved when the sum of the absolute brightness differences (0..255 each) inside it reaches this. An unchanged
    /// screen sums to exactly 0; a single changed digit sums to hundreds.
    pub block_sad: u32,
    /// How many moved blocks (not counting flickering ones) make a settled screen a new one.
    pub change_blocks: usize,
    /// Two looks agree (the screen has settled) when at most this many blocks moved between them.
    pub settle_blocks: usize,
    /// A look-to-look change covering at most this many screen pixels (square) is small enough to be held against a tile as flicker.
    pub sparse_area_px: usize,
    /// A tile of the screen is ignored once its flicker score reaches this.
    pub flicker_score: f32,
    /// The score is multiplied by this on every look (so the memory fades over some minutes).
    pub flicker_decay: f32,
    /// A change touching this share of the screen is a new page: what was learned about flicker is forgotten.
    pub new_screen_fraction: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self { block_sad: 40, change_blocks: 1, settle_blocks: 0, sparse_area_px: 8000, flicker_score: 1.75, flicker_decay: 0.995, new_screen_fraction: 0.02 }
    }
}

fn blocks_across(s: &Signature) -> usize {
    s.width.div_ceil(BLOCK)
}
fn blocks_down(s: &Signature) -> usize {
    s.height.div_ceil(BLOCK)
}

/// The sum of the absolute differences between two planes inside one block (blocks at the right and bottom edges may be smaller).
fn block_sad(a: &Signature, b: &Signature, block: usize) -> u32 {
    let across = blocks_across(a);
    let (bx, by) = ((block % across) * BLOCK, (block / across) * BLOCK);
    let (right, bottom) = ((bx + BLOCK).min(a.width), (by + BLOCK).min(a.height));
    let mut sad = 0u32;
    for y in by..bottom {
        let row = y * a.width;
        for x in bx..right {
            sad += a.plane[row + x].abs_diff(b.plane[row + x]) as u32;
        }
    }
    sad
}

/// The blocks whose difference between two planes of the same size reaches `threshold`.
fn moved_blocks(a: &Signature, b: &Signature, threshold: u32) -> Vec<usize> {
    let (across, down) = (blocks_across(a), blocks_down(a));
    let mut moved = vec![];
    for by in 0..down {
        let (top, bottom) = (by * BLOCK, ((by + 1) * BLOCK).min(a.height));
        // The cheap test first: if this whole row of blocks is identical there is nothing to add up (most of an unchanged screen).
        if a.plane[top * a.width..bottom * a.width] == b.plane[top * a.width..bottom * a.width] {
            continue;
        }
        for bx in 0..across {
            let block = by * across + bx;
            if block_sad(a, b, block) >= threshold {
                moved.push(block);
            }
        }
    }
    moved
}

/// Copies one block of `from` into `into`.
fn copy_block(into: &mut Signature, from: &Signature, block: usize) {
    let across = blocks_across(into);
    let (bx, by) = ((block % across) * BLOCK, (block / across) * BLOCK);
    let (right, bottom) = ((bx + BLOCK).min(into.width), (by + BLOCK).min(into.height));
    for y in by..bottom {
        let row = y * into.width;
        into.plane[row + bx..row + right].copy_from_slice(&from.plane[row + bx..row + right]);
    }
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
        if self.previous.as_ref().is_some_and(|p| (p.width, p.height, p.factor) != (now.width, now.height, now.factor)) {
            self.reset();
        }
        let across = blocks_across(&now);
        let tiles_across = across.div_ceil(TILE);
        let tile_of = |block: usize| ((block / across) / TILE) * tiles_across + (block % across) / TILE;
        let tiles = tiles_across * blocks_down(&now).div_ceil(TILE);
        if self.scores.len() != tiles {
            self.scores = vec![0.0; tiles];
        }
        let Some(previous) = self.previous.take() else {
            self.previous = Some(now);
            return Verdict::Settling;
        };
        let before = self.before_previous.take();

        // What moved since the last look, and what that teaches about places that move on their own.
        let moved = moved_blocks(&previous, &now, cfg.block_sad);
        self.scores.iter_mut().for_each(|s| *s *= cfg.flicker_decay);
        let block_px = BLOCK * now.factor;
        let sparse_blocks = (cfg.sparse_area_px / (block_px * block_px)).max(24);
        if moved.len() <= sparse_blocks {
            // One count per tile per look: 1.0 if something in it went back to what it showed two looks ago, otherwise 0.5.
            let mut touched: Vec<(usize, bool)> = moved.iter().map(|&b| (tile_of(b), before.as_ref().is_some_and(|bf| block_sad(bf, &now, b) < cfg.block_sad))).collect();
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
        let flickering = |block: usize| scores[tile_of(block)] >= cfg.flicker_score;
        if moved.iter().filter(|&&b| !flickering(b)).count() > cfg.settle_blocks {
            return Verdict::Settling;
        }

        // Settled. Is it new?
        let Some(reported) = self.reported.as_mut() else {
            self.reported = Some(now);
            return Verdict::Changed;
        };
        let differing_blocks = moved_blocks(reported, &now, cfg.block_sad);
        let mut differing = 0usize;
        for &block in &differing_blocks {
            if flickering(block) {
                copy_block(reported, &now, block); // a place that moves on its own is not part of what was reported
            } else {
                differing += 1;
            }
        }
        if differing >= cfg.change_blocks {
            *reported = now;
            if differing as f32 / (across * blocks_down(reported)) as f32 >= cfg.new_screen_fraction {
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
    /// Real pictures of a real window (GTK text, anti-aliased) on a 1600x900 screen, taken with this crate's own capture.
    fn real(name: &str) -> RgbaImage {
        let bytes: &[u8] = match name {
            "start" => include_bytes!("../tests/fixtures/screen-1-start.png"),
            "again" => include_bytes!("../tests/fixtures/screen-1-again.png"),
            "number" => include_bytes!("../tests/fixtures/screen-2-number.png"),
            "word" => include_bytes!("../tests/fixtures/screen-3-word.png"),
            "code" => include_bytes!("../tests/fixtures/screen-4-code.png"),
            other => panic!("no fixture {other}"),
        };
        image::load_from_memory(bytes).expect("a fixture picture").to_rgba8()
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
        for (w, h) in [(1280, 720), (1600, 900), (1920, 1080), (2560, 1440), (3840, 2160)] {
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
            ("a colon becoming a semicolon", "x = 12 + 7: abc", "x = 12 + 7; abc"),
        ];
        for (what, before, after) in edits {
            let mut d = Detector::new(Config::default());
            feed(&mut d, &with_line(1600, 900, 12, before), 3);
            let verdicts = feed(&mut d, &with_line(1600, 900, 12, after), 3);
            assert_eq!(verdicts, vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "{what}: {before:?} -> {after:?}");
        }
    }

    #[test]
    fn real_anti_aliased_text_one_digit_one_word_one_token_of_code() {
        // Pictures of a real GTK window, 15 px monospace: "total = 12 + 7" -> "13", "abc" -> "abd", "==" -> "!=".
        let mut d = Detector::new(Config::default());
        assert_eq!(feed(&mut d, &real("start"), 3), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged]);
        assert_eq!(feed(&mut d, &real("again"), 3), vec![Verdict::Unchanged; 3], "a second picture of the same screen is not a change");
        assert_eq!(feed(&mut d, &real("number"), 3), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "12 -> 13 is a change");
        assert_eq!(feed(&mut d, &real("word"), 3), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "abc -> abd is a change");
        assert_eq!(feed(&mut d, &real("code"), 3), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "== -> != is a change");
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
        let (base, with_caret) = (signature(&base), signature(&with_caret));
        for _ in 0..3 {
            d.observe(base.clone());
        }
        let blinks: Vec<_> = (0..30).map(|i| d.observe(if i % 2 == 0 { with_caret.clone() } else { base.clone() })).collect();
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
        let (base, with_caret) = (signature(&base), signature(&with_caret));
        for _ in 0..3 {
            d.observe(base.clone());
        }
        let pattern = [1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0];
        let verdicts: Vec<_> = pattern.iter().map(|on| d.observe(if *on == 1 { with_caret.clone() } else { base.clone() })).collect();
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
        assert!(changed_at.iter().all(|m| *m <= 4 || *m == 10), "the ticking digit is ignored from the fifth minute; only the tens digit, changing for the first time at minute 10, is read once more: {changed_at:?}");
    }

    #[test]
    fn a_big_change_forgets_what_was_learned_about_flicker() {
        let mut d = Detector::new(Config::default());
        let base = page(1600, 900, &lines(30));
        let mut with_caret = base.clone();
        caret(&mut with_caret, 700, 400);
        let (base, with_caret) = (signature(&base), signature(&with_caret));
        for _ in 0..3 {
            d.observe(base.clone());
        }
        for i in 0..20 {
            d.observe(if i % 2 == 0 { with_caret.clone() } else { base.clone() });
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
    fn what_changes_inside_an_ignored_area_is_never_a_difference_and_what_changes_outside_it_still_is() {
        let own_window = Area { x: 1000, y: 100, width: 500, height: 600 };
        let screen = |inside: &str, outside: &str| {
            let mut all = lines(30);
            all[14] = outside.to_string(); // at the left of the page: outside the area
            let mut page = page(1600, 900, &all);
            crate::testscreen::draw_text(&mut page, 1020, 300, inside, 2); // inside the area
            signature_without(&page, &[own_window])
        };
        let mut d = Detector::new(Config::default());
        for _ in 0..3 {
            d.observe(screen("last read 12:01", "x = 12 + 7;"));
        }
        let inside: Vec<_> = (0..40).map(|i| d.observe(screen(&format!("last read 12:{:02}", i + 2), "x = 12 + 7;"))).collect();
        assert_eq!(count(&inside, Verdict::Changed), 0, "a counter or a message changing in the ignored area is not a new screen");
        assert_eq!(inside[..], [Verdict::Unchanged; 40], "and it does not keep the screen from settling");
        let outside: Vec<_> = (0..3).map(|_| d.observe(screen("last read 12:59", "x = 13 + 7;"))).collect();
        assert!(outside.contains(&Verdict::Changed), "an edit outside it is: {outside:?}");
    }

    #[test]
    fn an_area_partly_off_the_screen_is_clipped_not_a_crash() {
        let s = signature_without(&page(1600, 900, &lines(30)), &[Area { x: -200, y: -100, width: 500, height: 400 }, Area { x: 1500, y: 800, width: 900, height: 900 }, Area { x: 5000, y: 5000, width: 10, height: 10 }]);
        assert_eq!((s.width, s.height), (800, 450));
    }

    #[test]
    fn a_different_screen_size_is_a_new_screen_not_a_crash() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &page(1600, 900, &lines(30)), 3);
        assert_eq!(feed(&mut d, &page(1920, 1080, &lines(30)), 3), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "another display, or a changed resolution");
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
    fn the_plane_is_averaged_down_to_at_most_1280_wide_and_a_screen_does_not_differ_from_itself() {
        for (w, h, f, pw, ph) in [(1280, 720, 1, 1280, 720), (1600, 900, 2, 800, 450), (1920, 1080, 2, 960, 540), (2560, 1440, 2, 1280, 720), (3840, 2160, 3, 1280, 720)] {
            let s = signature(&page(w, h, &lines(30)));
            assert_eq!((s.factor, s.width, s.height), (f, pw, ph), "{w}x{h}");
            assert!(moved_blocks(&s, &s, 1).is_empty(), "a screen does not differ from itself");
        }
    }
}
