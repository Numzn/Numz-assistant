//! Times the picture preparation of the study watcher on screen-like pictures, in release mode:
//!
//!     cargo run --release --example prepbench -p numz-capture
//!
//! `export` is what the page asks for when a changed screen is to be read (scale to 1600 px, JPEG quality 80); `preview` is the small picture
//! the watcher used to make for every screen it reported (it no longer does; the column shows what that work would cost now). The pictures are made up: white pages with lines of "text", a header and a few colour
//! blocks, so the JPEG has realistic work to do. No screen is read and nothing is written.

use image::{Rgba, RgbaImage};
use numz_capture::encode;
use std::time::Instant;

fn screen(w: u32, h: u32) -> RgbaImage {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut img = RgbaImage::from_pixel(w, h, Rgba([250, 250, 252, 255]));
    // a header bar and a task bar
    for y in 0..(h / 24) {
        for x in 0..w {
            img.put_pixel(x, y, Rgba([221, 225, 232, 255]));
            img.put_pixel(x, h - 1 - y, Rgba([29, 35, 48, 255]));
        }
    }
    // lines of text: short dark dashes in rows
    let line = (h / 54).max(10);
    let mut y = h / 8;
    while y + line < h - h / 20 {
        let mut x = w / 5;
        while x + 12 < w - w / 5 {
            let len = 4 + (next() % 40) as u32;
            let dark = 20 + (next() % 60) as u8;
            for yy in y..y + line / 2 {
                for xx in x..(x + len).min(w - 1) {
                    img.put_pixel(xx, yy, Rgba([dark, dark, dark + 10, 255]));
                }
            }
            x += len + 4 + (next() % 8) as u32;
        }
        y += line + line / 2;
    }
    // colour blocks (buttons, a chart)
    for k in 0..6u32 {
        let (bx, by) = (w / 10 + k * (w / 8), h / 3 + (k % 3) * (h / 6));
        for yy in by..(by + h / 14).min(h) {
            for xx in bx..(bx + w / 12).min(w) {
                img.put_pixel(xx, yy, Rgba([(40 + k * 30) as u8, (120 + k * 20) as u8, 200u8.saturating_sub((k * 20) as u8), 255]));
            }
        }
    }
    img
}

fn median(mut ms: Vec<f64>) -> f64 {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    ms[(ms.len() - 1) / 2]
}

fn stages(img: &RgbaImage) {
    use image::imageops::{self, FilterType};
    let time = |f: &mut dyn FnMut()| {
        let mut v = Vec::new();
        for _ in 0..9 {
            let t = Instant::now();
            f();
            v.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        median(v)
    };
    let (w, h) = img.dimensions();
    let nw = 1600u32;
    let nh = (h as f64 * nw as f64 / w as f64).round() as u32;
    let clone = time(&mut || {
        let _ = img.clone();
    });
    let triangle = time(&mut || {
        let _ = imageops::resize(img, nw, nh, FilterType::Triangle);
    });
    let thumbnail = time(&mut || {
        let _ = imageops::thumbnail(img, nw, nh);
    });
    let small = imageops::resize(img, nw, nh, FilterType::Triangle);
    let jpeg = time(&mut || {
        let _ = encode::jpeg(&small, 80).unwrap();
    });
    println!("    stages at {w}x{h}: clone {clone:.1} | resize Triangle {triangle:.1} | thumbnail {thumbnail:.1} | jpeg(1600) {jpeg:.1}");
}

fn main() {
    println!("{:<12} {:>12} {:>12} {:>12} {:>10}", "screen", "export ms", "preview ms", "both ms", "jpeg KB");
    for (w, h) in [(1366u32, 768u32), (1920, 1080), (2560, 1440), (3840, 2160)] {
        let img = screen(w, h);
        let mut export = Vec::new();
        let mut preview = Vec::new();
        let mut kb = 0;
        for _ in 0..15 {
            let t = Instant::now();
            let out = encode::export(&img, None, 1600, 80).expect("export");
            export.push(t.elapsed().as_secs_f64() * 1000.0);
            kb = out.bytes.len() / 1024;
            let t = Instant::now();
            let _ = encode::preview_data_url(&img).expect("preview");
            preview.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        stages(&img);
        let (e, p) = (median(export), median(preview));
        println!("{:<12} {:>12.1} {:>12.1} {:>12.1} {:>10}", format!("{w}x{h}"), e, p, e + p, kb);
    }
}
