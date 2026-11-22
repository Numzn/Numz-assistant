//! Exploration only: how far apart two pictures are, per block of pixels, as the sum of absolute luminance differences. `celldiff a.png b.png`.
use image::RgbaImage;

fn lum(img: &RgbaImage) -> Vec<i32> {
    img.pixels().map(|p| ((299 * p.0[0] as u32 + 587 * p.0[1] as u32 + 114 * p.0[2] as u32) / 1000) as i32).collect()
}
/// Box-average by `f` (exact area average).
fn boxed(l: &[i32], w: usize, h: usize, f: usize) -> (Vec<i32>, usize, usize) {
    let (nw, nh) = (w / f, h / f);
    let mut out = vec![0; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            let mut s = 0;
            for dy in 0..f {
                for dx in 0..f {
                    s += l[(y * f + dy) * w + x * f + dx];
                }
            }
            out[y * nw + x] = s / (f * f) as i32;
        }
    }
    (out, nw, nh)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a = image::open(&args[0]).unwrap().to_rgba8();
    let b = image::open(&args[1]).unwrap().to_rgba8();
    let (w, h) = (a.width() as usize, a.height() as usize);
    let (la, lb) = (lum(&a), lum(&b));
    for f in [1usize, 2, 3] {
        let (pa, nw, nh) = boxed(&la, w, h, f);
        let (pb, _, _) = boxed(&lb, w, h, f);
        for block in [4usize, 6, 8] {
            let (bw, bh) = (nw / block, nh / block);
            let mut sads = vec![];
            for by in 0..bh {
                for bx in 0..bw {
                    let mut sad = 0;
                    for dy in 0..block {
                        for dx in 0..block {
                            let i = (by * block + dy) * nw + bx * block + dx;
                            sad += (pa[i] - pb[i]).abs();
                        }
                    }
                    sads.push(sad);
                }
            }
            let over = |t: i32| sads.iter().filter(|d| **d > t).count();
            let mut top = sads.clone();
            top.sort_unstable_by(|x, y| y.cmp(x));
            println!("avg {f}x{f}, block {block}x{block} (= {}px): max {:4} top {:?}  >20: {:3} >60: {:3} >150: {:3}", f * block, top[0], &top[..4.min(top.len())], over(20), over(60), over(150));
        }
    }
}
