//! Updates of this app. The page (the NUMZ AI site, and only it) can ask two things:
//!
//!   app_update_check()     is a newer version published? -> { current, available, version?, notes? }
//!   app_update_install()   download it, check its signature, install it and start the new version
//!
//! Nothing is installed without the person pressing the button in the update line: the page asks, the person answers. What is installed is
//! checked by the updater plugin against the public key in tauri.conf.json (`plugins.updater.pubkey`): a download that was not signed with
//! the matching private key is refused, whoever serves it. The address that lists the newest version is in the same file.
//!
//! A debug build also honours NUMZ_UPDATE_URL (a list of versions on this computer, for desktop/e2e/update.mjs); a release build always asks
//! the address in tauri.conf.json.

use crate::screenshot::Trusted;
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

/// Why an update did not happen, in a word the page can act on, and a sentence for the person.
#[derive(Debug, Serialize)]
pub struct UpdateError {
    pub code: &'static str,
    pub message: String,
}

impl UpdateError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// What the updater said, in the person's words. The updater's own text can carry addresses and paths, so only a fixed sentence is passed on.
pub(crate) fn describe(err: &tauri_plugin_updater::Error) -> UpdateError {
    use tauri_plugin_updater::Error as E;
    match err {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => UpdateError::new("unverified", "The update was not signed by NUMZ AI, so it was not installed."),
        E::Network(_) | E::Reqwest(_) | E::Http(_) | E::ReleaseNotFound | E::EmptyEndpoints => UpdateError::new("unreachable", "The update could not be reached. Check the connection and try again."),
        E::UnsupportedArch | E::UnsupportedOs | E::TargetNotFound(_) | E::TargetsNotFound(_) => UpdateError::new("unsupported", "There is no update for this computer."),
        _ => UpdateError::new("failed", "The update could not be installed."),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

/// Defence in depth behind the capability: the caller must be the main window, showing a page of the trusted origin.
fn trusted(window: &WebviewWindow, trusted: &Trusted) -> Result<(), UpdateError> {
    if window.label() != "main" {
        return Err(UpdateError::new("forbidden", "not the main window"));
    }
    let url = window.url().map_err(|_| UpdateError::new("forbidden", "the page address is not known"))?;
    if url.origin().ascii_serialization() != trusted.0 {
        return Err(UpdateError::new("forbidden", "this page may not update the app"));
    }
    Ok(())
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, UpdateError> {
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var("NUMZ_UPDATE_URL").ok().and_then(|v| v.parse::<tauri::Url>().ok()) {
        return app.updater_builder().endpoints(vec![url]).map_err(|e| describe(&e))?.build().map_err(|e| describe(&e));
    }
    app.updater().map_err(|e| describe(&e))
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle, window: WebviewWindow, trust: State<'_, Trusted>) -> Result<UpdateInfo, UpdateError> {
    trusted(&window, &trust)?;
    let current = app.package_info().version.to_string();
    match updater(&app)?.check().await.map_err(|e| describe(&e))? {
        Some(update) => Ok(UpdateInfo { current, available: true, version: Some(update.version), notes: update.body.map(|b| b.chars().take(600).collect()) }),
        None => Ok(UpdateInfo { current, available: false, version: None, notes: None }),
    }
}

#[tauri::command]
pub async fn app_update_install(app: AppHandle, window: WebviewWindow, trust: State<'_, Trusted>) -> Result<(), UpdateError> {
    trusted(&window, &trust)?;
    let update = updater(&app)?.check().await.map_err(|e| describe(&e))?.ok_or_else(|| UpdateError::new("none", "There is no newer version."))?;
    // Downloaded, its signature checked against the public key, then installed. On Windows the installer closes this app and starts the new one.
    update.download_and_install(|_chunk, _total| {}, || {}).await.map_err(|e| describe(&e))?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_updater_says_is_turned_into_a_fixed_sentence_and_a_code() {
        let e = describe(&tauri_plugin_updater::Error::EmptyEndpoints);
        assert_eq!(e.code, "unreachable");
        assert!(!e.message.contains("endpoint"), "the updater's own words are not passed on");
        assert_eq!(describe(&tauri_plugin_updater::Error::UnsupportedOs).code, "unsupported");
        assert_eq!(describe(&tauri_plugin_updater::Error::InsecureTransportProtocol).code, "failed");
    }

    #[test]
    fn errors_serialize_with_a_code_and_a_sentence() {
        let json = serde_json::to_value(UpdateError::new("unverified", "x")).unwrap();
        assert_eq!(json["code"], "unverified");
        assert_eq!(json["message"], "x");
    }
}
