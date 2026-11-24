//! NUMZ AI as a desktop app: the NUMZ AI site in a native window, and the one native thing the site cannot do for itself - take
//! screenshots (see `screenshot.rs`). The app has no screen of its own and no assistant of its own: it opens the site.
//!
//! Trust: the site's origin (https://lab.numz.site) is the only origin allowed to call the screenshot commands. That is enforced twice:
//! by the capability in `capabilities/default.json` (Tauri refuses the call before it reaches this code) and again in every command
//! (`screenshot::check` compares the calling page's own origin). The window may not navigate away from the site, except to Google's
//! sign-in page, which has no access to the commands.

mod screenshot;
mod study;
mod update;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const SITE: &str = "https://lab.numz.site/ai/";
/// The only other place the window may go: the Google account chooser, as part of signing in. It is given no access to the commands.
const SIGN_IN_HOST: &str = "accounts.google.com";

/// Where the window opens. A debug build also honours NUMZ_AI_URL, so the app can be tried against a local copy of the site; a release
/// build always opens the real site.
fn start_url() -> tauri::Url {
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var("NUMZ_AI_URL").ok().and_then(|v| v.parse().ok()) {
        return url;
    }
    SITE.parse().expect("the site address is valid")
}

fn allowed_navigation(url: &tauri::Url, site_origin: &str) -> bool {
    url.origin().ascii_serialization() == site_origin || (url.scheme() == "https" && url.host_str() == Some(SIGN_IN_HOST)) || url.scheme() == "about"
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(screenshot::Screens::new())
        .manage(study::StudyWatch::default())
        .invoke_handler(tauri::generate_handler![
            screenshot::screenshot_status,
            screenshot::screenshot_windows,
            screenshot::screenshot_capture,
            screenshot::screenshot_export,
            screenshot::screenshot_discard,
            study::screenshot_watch_start,
            study::screenshot_watch_poll,
            study::screenshot_watch_pause,
            study::screenshot_watch_resume,
            study::screenshot_watch_stop,
            update::app_update_check,
            update::app_update_install,
        ])
        .setup(|app| {
            let url = start_url();
            let origin = url.origin().ascii_serialization();
            app.manage(screenshot::Trusted(origin.clone()));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("NUMZ AI")
                .inner_size(1280.0, 860.0)
                .min_inner_size(720.0, 520.0)
                .on_navigation(move |next| allowed_navigation(next, &origin))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the NUMZ AI desktop app failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_stays_on_the_site_apart_from_the_google_sign_in() {
        let site = "https://lab.numz.site";
        let ok = |u: &str| allowed_navigation(&u.parse().unwrap(), site);
        assert!(ok("https://lab.numz.site/ai/"));
        assert!(ok("https://lab.numz.site/auth/broker/authorize?x=1"));
        assert!(ok("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"));
        assert!(ok("about:blank"));
        assert!(!ok("https://evil.example/"));
        assert!(!ok("https://lab.numz.site.evil.example/"));
        assert!(!ok("http://lab.numz.site/ai/"), "the same host over http is a different origin");
        assert!(!ok("https://lab.numz.site:8443/ai/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("http://accounts.google.com/"));
    }
}
