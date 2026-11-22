//! One backend per platform, chosen at compile time. Each takes a single still picture per call and has no way to send input.

use crate::Backend;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{last_screen_method, request_borderless_access};

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod other;

/// The capture backend of the platform this was built for.
pub fn native_backend() -> Box<dyn Backend> {
    #[cfg(target_os = "linux")]
    return Box::new(linux::Native);
    #[cfg(target_os = "macos")]
    return Box::new(macos::Native);
    #[cfg(windows)]
    return Box::new(windows::Native);
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    return Box::new(other::Native);
}
