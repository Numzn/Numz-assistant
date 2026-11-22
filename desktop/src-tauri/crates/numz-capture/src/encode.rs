//! Turning a capture into what the page needs: a small preview now, and later the exported picture (cropped, scaled, JPEG).

use crate::CaptureError;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::{self, FilterType};
use image::{DynamicImage, RgbaImage};
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

/// A small picture the page can show at once, as a `data:` URL.
pub fn preview_data_url(image: &RgbaImage) -> Result<String, CaptureError> {
    let small = limit_side(image.clone(), PREVIEW_SIDE);
    let bytes = jpeg(&small, PREVIEW_QUALITY)?;
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
    let scaled = limit_side(source.clone(), max_side.clamp(MIN_SIDE, MAX_SIDE));
    let (width, height) = scaled.dimensions();
    Ok(Exported { bytes: jpeg(&scaled, quality)?, width, height })
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

    #[test]
    fn the_preview_is_a_small_data_url() {
        let url = preview_data_url(&picture(3840, 2160)).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert!(url.len() < 600_000, "a preview must stay small to cross the bridge quickly: {}", url.len());
    }
}
