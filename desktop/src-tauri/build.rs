// The screenshot commands are registered with their own permissions, so that a page can use them only where capabilities/ says it may
// (the NUMZ AI address and nowhere else).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "screenshot_status",
        "screenshot_windows",
        "screenshot_capture",
        "screenshot_export",
        "screenshot_discard",
    ])))
    .expect("failed to run the Tauri build step");
}
