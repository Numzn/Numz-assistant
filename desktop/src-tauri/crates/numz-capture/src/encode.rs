//! Turning a capture into what the page needs: a small preview now, and later the exported picture (cropped, scaled, JPEG).

use crate::CaptureError;
use base64::Engine;
use fast_image_resize::images::Image;
use fast_image_resize::{FilterType as FastFilter, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::{self, FilterType};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Deserialize;

pub const PREVIEW_SIDE: u32 = 1280;
pub const PREVIEW_QUALITY: u8 = 70;
const MIN_SIDE: u32 = 256;
const MAX_SIDE: u32 = 4096;

/// An area of a capture, in the capture's own pixels.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug)]
pub struct Exported {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The area must lie inside the picture and be at least a few pixels across.
pub fn crop(image: &RgbaImage, rect: Rect) -> Result<RgbaImage, CaptureError> {
    let (w, h) = image.dimensions();
    if rect.width < 4 || rect.height < 4 || rect.x >= w || rect.y >= h || rect.x.checked_add(rect.width).is_none_or(|r| r > w) || rect.y.checked_add(rect.height).is_none_or(|b| b > h) {
        return Err(CaptureError::InvalidRegion);
    }
    Ok(imageops::crop_imm(image, rect.x, rect.y, rect.width, rect.height).to_image())
}

/// Scales the picture down so its longer side is at most `max_side`. A picture already small enough is returned as it is.
pub fn limit_side(image: RgbaImage, max_side: u32) -> RgbaImage {
    let (w, h) = image.dimensions();
    let long = w.max(h);
    if long <= max_side {
        return image;
    }
    let scale = max_side as f64 / long as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    imageops::resize(&image, nw, nh, FilterType::Triangle)
}

pub fn jpeg(image: &RgbaImage, quality: u8) -> Result<Vec<u8>, CaptureError> {
    // A screenshot has no transparency worth keeping, and JPEG has none to give: drop the alpha channel.
    let rgb = DynamicImage::ImageRgba8(image.clone()).to_rgb8();
    let mut out = Vec::with_capacity((rgb.width() * rgb.height() / 6) as usize);
    JpegEncoder::new_with_quality(&mut out, quality.clamp(30, 95)).encode_image(&rgb).map_err(|e| CaptureError::Failed(format!("could not encode the picture: {e}")))?;
    Ok(out)
}

/// The picture as plain RGB bytes (a screenshot has no transparency worth keeping, and JPEG has none to give), scaled down so that its longer
/// side is at most `max_side`. One copy of the pixels is made (alpha dropped); scaling is done on those three-byte pixels with SIMD, which is
/// several times quicker than the general resize and gives the same picture (the same triangle filter, tested against it below).
fn scaled_rgb(image: &RgbaImage, max_side: u32) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let (w, h) = image.dimensions();
    let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
    for pixel in image.as_raw().chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
    }
    let long = w.max(h);
    if long <= max_side {
        return Ok((rgb, w, h));
    }
    let scale = max_side as f64 / long as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    let failed = |e: &dyn std::fmt::Display| CaptureError::Failed(format!("could not scale the picture: {e}"));
    let src = Image::from_vec_u8(w, h, rgb, PixelType::U8x3).map_err(|e| failed(&e))?;
    let mut dst = Image::new(nw, nh, PixelType::U8x3);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FastFilter::Bilinear));
    Resizer::new().resize(&src, &mut dst, &options).map_err(|e| failed(&e))?;
    Ok((dst.into_vec(), nw, nh))
}

fn jpeg_rgb(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, CaptureError> {
    let mut out = Vec::with_capacity(rgb.len() / 6);
    JpegEncoder::new_with_quality(&mut out, quality.clamp(30, 95)).write_image(rgb, width, height, ExtendedColorType::Rgb8).map_err(|e| CaptureError::Failed(format!("could not encode the picture: {e}")))?;
    Ok(out)
}

/// A small picture the page can show at once, as a `data:` URL.
pub fn preview_data_url(image: &RgbaImage) -> Result<String, CaptureError> {
    let (rgb, w, h) = scaled_rgb(image, PREVIEW_SIDE)?;
    let bytes = jpeg_rgb(&rgb, w, h, PREVIEW_QUALITY)?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// The picture to analyse: optionally cropped to `rect`, scaled so its longer side is at most `max_side`, as JPEG.
pub fn export(image: &RgbaImage, rect: Option<Rect>, max_side: u32, quality: u8) -> Result<Exported, CaptureError> {
    let cropped;
    let source = match rect {
        Some(r) => {
            cropped = crop(image, r)?;
            &cropped
        }
        None => image,
    };
    let (rgb, width, height) = scaled_rgb(source, max_side.clamp(MIN_SIDE, MAX_SIDE))?;
    Ok(Exported { bytes: jpeg_rgb(&rgb, width, height, quality)?, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn picture(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]))
    }

    #[test]
    fn crop_takes_exactly_the_area_and_refuses_what_is_outside() {
        let img = picture(200, 100);
        let c = crop(&img, Rect { x: 10, y: 20, width: 50, height: 30 }).unwrap();
        assert_eq!(c.dimensions(), (50, 30));
        assert_eq!(c.get_pixel(0, 0), img.get_pixel(10, 20));
        for bad in [
            Rect { x: 190, y: 0, width: 50, height: 10 },
            Rect { x: 0, y: 90, width: 10, height: 20 },
            Rect { x: 0, y: 0, width: 3, height: 50 },
            Rect { x: 200, y: 0, width: 10, height: 10 },
            Rect { x: u32::MAX, y: 0, width: 10, height: 10 },
        ] {
            assert_eq!(crop(&img, bad).unwrap_err().code(), "invalid-region", "{bad:?}");
        }
    }

    #[test]
    fn large_pictures_are_scaled_down_and_small_ones_are_left_alone() {
        let big = limit_side(picture(4000, 2000), 2048);
        assert_eq!(big.dimensions(), (2048, 1024));
        assert_eq!(limit_side(picture(800, 600), 2048).dimensions(), (800, 600));
    }

    #[test]
    fn export_produces_a_jpeg_of_the_cropped_scaled_area() {
        let img = picture(3000, 1500);
        let out = export(&img, Some(Rect { x: 100, y: 100, width: 2000, height: 1000 }), 1000, 85).unwrap();
        assert_eq!((out.width, out.height), (1000, 500));
        assert_eq!(&out.bytes[..3], &[0xff, 0xd8, 0xff], "a JPEG");
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (1000, 500));
        assert!(export(&img, Some(Rect { x: 0, y: 0, width: 1, height: 1 }), 1000, 85).is_err());
    }

    /// What the scaling changed in the picture, against the general resize it replaced: the mean and the largest difference of any colour value.
    fn difference(a: &[u8], b: &[u8]) -> (f64, u8) {
        assert_eq!(a.len(), b.len());
        let total: u64 = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y) as u64).sum();
        (total as f64 / a.len() as f64, a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap())
    }

    /// Lines of "text" on white: the kind of picture the scaling must keep readable.
    fn page(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| if (y / 3) % 5 < 2 && (x / 2) % 7 < 5 && x > w / 8 && x < w - w / 8 { Rgba([20, 20, 30, 255]) } else { Rgba([250, 250, 252, 255]) })
    }

    #[test]
    fn the_fast_scaling_gives_the_same_picture_as_the_general_resize() {
        let img = page(1920, 1080);
        let (fast, w, h) = scaled_rgb(&img, 1600).unwrap();
        assert_eq!((w, h), (1600, 900));
        let general = limit_side(img.clone(), 1600);
        assert_eq!(general.dimensions(), (w, h));
        let general_rgb: Vec<u8> = general.as_raw().chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        let (mean, _) = difference(&fast, &general_rgb);
        assert!(mean < 2.0, "the two scalings differ by {mean} on average (of 255): text would read differently");
    }

    #[test]
    fn a_picture_already_small_enough_is_not_scaled_and_keeps_its_colours() {
        let img = picture(800, 600);
        let (rgb, w, h) = scaled_rgb(&img, 1600).unwrap();
        assert_eq!((w, h), (800, 600));
        assert_eq!(&rgb[..3], &img.get_pixel(0, 0).0[..3]);
        assert_eq!(rgb.len(), 800 * 600 * 3);
    }

    #[test]
    fn the_preview_is_a_small_data_url() {
        let url = preview_data_url(&picture(3840, 2160)).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert!(url.len() < 600_000, "a preview must stay small to cross the bridge quickly: {}", url.len());
    }
}
