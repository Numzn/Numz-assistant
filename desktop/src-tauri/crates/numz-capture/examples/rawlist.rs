//! Debug aid (Linux): what the X11 backend's library sees for every window, including the ones the app's list leaves out.
#[cfg(target_os = "linux")]
fn main() {
    for w in xcap::Window::all().unwrap_or_default() {
        println!("id={:?} title={:?} app={:?} min={:?} w={:?} h={:?}", w.id(), w.title(), w.app_name(), w.is_minimized(), w.width(), w.height());
    }
}
#[cfg(not(target_os = "linux"))]
fn main() {}
