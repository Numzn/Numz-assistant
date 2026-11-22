//! Local screen-change detection: the cheap half of hybrid capture. It decides, on this machine and without sending anything anywhere,
//! whether the screen has changed in a way that is worth reading, so the cloud model is asked only about new content.
//!
//! A picture is reduced to a 32x18 grid of average brightness (576 numbers). A change is real when the grid differs by enough on average OR
//! enough cells differ a lot (a new page of text moves many cells; a blinking cursor moves one). It is reported only once the screen has
//! SETTLED (two looks in a row that agree), so a scroll or a page load in progress is waited out, and once per distinct screen: the same
//! screen seen again is not reported again.

use image::imageops::{self, FilterType};
use image::RgbaImage;

pub const GRID_W: u32 = 32;
pub const GRID_H: u32 = 18;
const CELLS: usize = (GRID_W * GRID_H) as usize;

#[derive(Clone)]
pub struct Signature {
    cells: [u8; CELLS],
}

pub fn signature(image: &RgbaImage) -> Signature {
    let small = imageops::resize(image, GRID_W, GRID_H, FilterType::Triangle);
    let mut cells = [0u8; CELLS];
    for (i, px) in small.pixels().enumerate() {
        let [r, g, b, _] = px.0;
        cells[i] = ((299 * r as u32 + 587 * g as u32 + 114 * b as u32) / 1000) as u8;
    }
    Signature { cells }
}

#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// Mean absolute brightness difference (0..255) that counts as a change on its own.
    pub mean_threshold: f32,
    /// Share of cells (0..1) that differ by more than `cell_delta` and count as a change on their own.
    pub cell_fraction: f32,
    pub cell_delta: u8,
    /// Two looks agree (the screen has settled) when they differ by less than this on average.
    pub settle_tolerance: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self { mean_threshold: 2.0, cell_fraction: 0.05, cell_delta: 12, settle_tolerance: 1.0 }
    }
}

pub fn mean_difference(a: &Signature, b: &Signature) -> f32 {
    a.cells.iter().zip(b.cells.iter()).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as f32).sum::<f32>() / CELLS as f32
}

fn changed_cells(a: &Signature, b: &Signature, delta: u8) -> f32 {
    a.cells.iter().zip(b.cells.iter()).filter(|(x, y)| (**x as i32 - **y as i32).unsigned_abs() as u8 > delta).count() as f32 / CELLS as f32
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
    candidate: Option<Signature>,
}

impl Detector {
    pub fn new(config: Config) -> Self {
        Self { config, reported: None, candidate: None }
    }

    /// Forget what was reported (a new session): the next settled screen is reported.
    pub fn reset(&mut self) {
        self.reported = None;
        self.candidate = None;
    }

    fn differs(&self, a: &Signature, b: &Signature) -> bool {
        mean_difference(a, b) >= self.config.mean_threshold || changed_cells(a, b, self.config.cell_delta) >= self.config.cell_fraction
    }

    pub fn observe(&mut self, now: Signature) -> Verdict {
        let settled = match &self.candidate {
            Some(previous) => mean_difference(previous, &now) < self.config.settle_tolerance,
            None => false,
        };
        self.candidate = Some(now.clone());
        if !settled {
            return Verdict::Settling;
        }
        let is_new = match &self.reported {
            None => true,
            Some(reported) => self.differs(reported, &now),
        };
        if is_new {
            self.reported = Some(now);
            Verdict::Changed
        } else {
            Verdict::Unchanged
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// A "screen": a light page with `lines` dark text bars.
    fn screen(lines: u32) -> RgbaImage {
        RgbaImage::from_fn(1600, 900, |x, y| {
            let bar = (y / 40) % 2 == 0 && y / 40 < lines * 2 && x > 100 && x < 1500;
            if bar { Rgba([30, 30, 30, 255]) } else { Rgba([245, 245, 245, 255]) }
        })
    }

    fn feed(detector: &mut Detector, image: &RgbaImage, times: usize) -> Vec<Verdict> {
        (0..times).map(|_| detector.observe(signature(image))).collect()
    }

    #[test]
    fn the_first_screen_is_reported_once_it_has_settled_and_not_again() {
        let mut d = Detector::new(Config::default());
        let s = screen(5);
        assert_eq!(feed(&mut d, &s, 4), vec![Verdict::Settling, Verdict::Changed, Verdict::Unchanged, Verdict::Unchanged]);
    }

    #[test]
    fn a_new_screen_is_reported_once_and_only_after_it_stops_changing() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &screen(5), 3);
        let verdicts: Vec<_> = [screen(8), screen(10), screen(12), screen(12), screen(12)].iter().map(|s| d.observe(signature(s))).collect();
        assert_eq!(verdicts, vec![Verdict::Settling, Verdict::Settling, Verdict::Settling, Verdict::Changed, Verdict::Unchanged], "a page still loading is waited out");
    }

    #[test]
    fn a_blinking_cursor_or_a_clock_is_not_a_new_screen() {
        let mut d = Detector::new(Config::default());
        let base = screen(6);
        feed(&mut d, &base, 3);
        let mut blink = base.clone();
        for x in 1000..1012 {
            for y in 400..420 {
                blink.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        assert_eq!(feed(&mut d, &blink, 3), vec![Verdict::Unchanged, Verdict::Unchanged, Verdict::Unchanged], "a blink does not even unsettle the screen");
        assert_eq!(feed(&mut d, &base, 2), vec![Verdict::Unchanged, Verdict::Unchanged]);
    }

    #[test]
    fn a_new_page_of_the_same_kind_is_noticed_and_going_back_to_an_earlier_screen_is_a_change() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &screen(3), 3);
        assert!(feed(&mut d, &screen(9), 3).contains(&Verdict::Changed));
        assert!(feed(&mut d, &screen(3), 3).contains(&Verdict::Changed), "the question the person returned to is read again if it is the screen now");
    }

    #[test]
    fn reset_forgets_what_was_reported() {
        let mut d = Detector::new(Config::default());
        feed(&mut d, &screen(5), 3);
        d.reset();
        assert_eq!(feed(&mut d, &screen(5), 2), vec![Verdict::Settling, Verdict::Changed]);
    }

    #[test]
    fn the_signature_is_small_and_the_difference_is_symmetric() {
        let a = signature(&screen(2));
        let b = signature(&screen(9));
        assert_eq!(mean_difference(&a, &a), 0.0);
        assert!((mean_difference(&a, &b) - mean_difference(&b, &a)).abs() < f32::EPSILON);
        assert_eq!(std::mem::size_of::<Signature>(), 576);
    }
}
