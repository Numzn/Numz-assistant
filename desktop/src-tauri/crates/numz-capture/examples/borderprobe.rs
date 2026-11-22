//! Windows only, for the verification workflow: holds a capture of the primary screen open for a while with the outline requested, not
//! requested or left to the system, and says whether Windows accepted that. `borderprobe default|none|with <seconds>`. Not part of the app.

#[cfg(windows)]
fn main() {
    use std::time::Duration;
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};

    struct Idle;
    impl GraphicsCaptureApiHandler for Idle {
        type Flags = ();
        type Error = Box<dyn std::error::Error + Send + Sync>;
        fn new(_ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self)
        }
        fn on_frame_arrived(&mut self, _frame: &mut Frame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    let border = match args.first().map(String::as_str) {
        Some("none") => DrawBorderSettings::WithoutBorder,
        Some("with") => DrawBorderSettings::WithBorder,
        _ => DrawBorderSettings::Default,
    };
    if args.first().map(String::as_str) == Some("none") {
        println!("asking Windows for borderless access: {}", numz_capture::request_borderless_access());
    }
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(10);
    let monitor = Monitor::primary().expect("a primary monitor");
    let settings = Settings::new(monitor, CursorCaptureSettings::Default, border, SecondaryWindowSettings::Default, MinimumUpdateIntervalSettings::Default, DirtyRegionSettings::Default, ColorFormat::Rgba8, ());
    match Idle::start_free_threaded(settings) {
        Ok(control) => {
            println!("started: Windows accepted {:?}", border);
            std::thread::sleep(Duration::from_secs(seconds));
            let _ = control.stop();
            println!("stopped");
        }
        Err(e) => {
            println!("start failed with {:?}: {}", border, e);
            std::process::exit(3);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("borderprobe runs on Windows only");
}
