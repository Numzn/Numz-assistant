//! Test screens: pages of real-looking text drawn with a tiny 5x7 bitmap font, so the change detector and the watcher can be tested against
//! what they are for: a single digit, a word or a token of code changing on an otherwise unchanged page. Used by tests only.

use image::{Rgba, RgbaImage};

const INK: Rgba<u8> = Rgba([28, 28, 30, 255]);
const PAPER: Rgba<u8> = Rgba([246, 246, 244, 255]);

/// The 5x7 shape of a character: seven rows, the low five bits of each (leftmost pixel = bit 4). Unknown characters are blank.
fn glyph(c: char) -> [u8; 7] {
    let rows: [&str; 7] = match c {
        '0' => [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
        '1' => ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
        '2' => [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
        '3' => ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
        '4' => ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
        '5' => ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
        '6' => ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
        '7' => ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
        '8' => [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
        '9' => [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
        'a' => [".....", ".....", ".###.", "....#", ".####", "#...#", ".####"],
        'b' => ["#....", "#....", "#.##.", "##..#", "#...#", "##..#", "#.##."],
        'c' => [".....", ".....", ".###.", "#....", "#....", "#...#", ".###."],
        'd' => ["....#", "....#", ".##.#", "#..##", "#...#", "#..##", ".##.#"],
        'e' => [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
        'x' => [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
        '+' => [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
        '=' => [".....", ".....", "#####", ".....", "#####", ".....", "....."],
        ';' => [".....", ".....", "..#..", ".....", "..#..", "..#..", ".#..."],
        ':' => [".....", "..#..", ".....", ".....", "..#..", ".....", "....."],
        '(' => ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
        ')' => [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
        _ => [".....", ".....", ".....", ".....", ".....", ".....", "....."],
    };
    let mut out = [0u8; 7];
    for (i, row) in rows.iter().enumerate() {
        out[i] = row.chars().fold(0u8, |acc, ch| (acc << 1) | u8::from(ch == '#'));
    }
    out
}

/// Draws `text` with its top-left corner at (x, y); each font pixel is `scale` screen pixels, so a character is 5*scale by 7*scale.
pub fn draw_text(image: &mut RgbaImage, x: u32, y: u32, text: &str, scale: u32) {
    for (n, c) in text.chars().enumerate() {
        let left = x + n as u32 * 6 * scale;
        for (row, bits) in glyph(c).iter().enumerate() {
            for col in 0..5u32 {
                if bits & (1 << (4 - col)) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let (px, py) = (left + col * scale + dx, y + row as u32 * scale + dy);
                            if px < image.width() && py < image.height() {
                                image.put_pixel(px, py, INK);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// A light page of `width` x `height` with the lines of text drawn down the left (glyphs 10x14 px, a line every 22 px).
pub fn page(width: u32, height: u32, lines: &[String]) -> RgbaImage {
    let mut image = RgbaImage::from_pixel(width, height, PAPER);
    for (i, line) in lines.iter().enumerate() {
        let y = 40 + i as u32 * 22;
        if y + 14 >= height {
            break;
        }
        draw_text(&mut image, 60, y, line, 2);
    }
    image
}

/// `n` lines of dense, varied text and numbers, the way a question page looks: the same every time it is asked for.
pub fn lines(n: usize) -> Vec<String> {
    let words = ["abc", "de", "cab", "x = 12 + 7;", "bead", "(4 + 5) = 9", "a = b + c;", "dead", "e = 3 + 8;", "cede", "6 + 2 = 8", "ace"];
    (0..n)
        .map(|i| {
            (0..7).map(|j| words[(i * 5 + j * 3 + i / 3) % words.len()]).collect::<Vec<_>>().join(" ")
        })
        .collect()
}

/// A text cursor: a thin dark bar, as a blinking caret draws.
pub fn caret(image: &mut RgbaImage, x: u32, y: u32) {
    for dx in 0..2 {
        for dy in 0..16 {
            if x + dx < image.width() && y + dy < image.height() {
                image.put_pixel(x + dx, y + dy, INK);
            }
        }
    }
}

/// A small clock in the top-right corner, such as the one in a taskbar.
pub fn clock(image: &mut RgbaImage, text: &str) {
    let x = image.width().saturating_sub(10 + text.chars().count() as u32 * 12);
    draw_text(image, x, 8, text, 2);
}
