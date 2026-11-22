//! What is never captured. Full-screen capture photographs everything that is visible, so exclusions cannot be applied to the picture;
//! they are applied BEFORE it: if any window that is open on screen matches an exclusion, no picture is taken at all for as long as it is.
//! There is a built-in list (password managers, sign-in and verification screens, private browsing) that cannot be switched off, and the
//! person can add applications and window-title words of their own.

use crate::WindowInfo;

const BUILT_IN_APPS: &[&str] = &[
    "1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "enpass", "nordpass", "keeper", "roboform", "proton pass", "seahorse", "gnome-keyring", "credential manager",
];
const BUILT_IN_TITLES: &[&str] = &[
    "password", "passcode", "sign in", "sign-in", "log in", "login", "authenticate", "authentication", "two-factor", "2fa", "verification code", "one-time code", "security code",
    "private browsing", "incognito", "inprivate",
];

#[derive(Debug, Clone, Default)]
pub struct Exclusions {
    apps: Vec<String>,
    titles: Vec<String>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Reason {
    PasswordManagerOrSignIn,
    ChosenByThePerson,
}

fn clean(list: &[String]) -> Vec<String> {
    list.iter().map(|s| s.trim().to_lowercase()).filter(|s| s.len() >= 2 && s.len() <= 80).take(50).collect()
}

impl Exclusions {
    pub fn new(apps: &[String], titles: &[String]) -> Self {
        Self { apps: clean(apps), titles: clean(titles) }
    }

    /// Why a window must not be photographed, if it must not.
    pub fn reason(&self, window: &WindowInfo) -> Option<Reason> {
        let app = window.app.to_lowercase();
        let title = window.title.to_lowercase();
        if BUILT_IN_APPS.iter().any(|a| app.contains(a) || title.contains(a)) || BUILT_IN_TITLES.iter().any(|t| title.contains(t)) {
            return Some(Reason::PasswordManagerOrSignIn);
        }
        if self.apps.iter().any(|a| app.contains(a.as_str())) || self.titles.iter().any(|t| title.contains(t.as_str())) {
            return Some(Reason::ChosenByThePerson);
        }
        None
    }

    /// The first window on screen that rules a picture out.
    pub fn blocking<'a>(&self, windows: &'a [WindowInfo]) -> Option<(&'a WindowInfo, Reason)> {
        windows.iter().find_map(|w| self.reason(w).map(|r| (w, r)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(app: &str, title: &str) -> WindowInfo {
        WindowInfo { id: "1".into(), title: title.into(), app: app.into(), width: 800, height: 600 }
    }

    #[test]
    fn password_managers_and_sign_in_screens_are_never_captured() {
        let none = Exclusions::default();
        for (app, title) in [("1Password", "Vault"), ("keepassxc", "Database"), ("firefox", "Sign in to your account"), ("chrome", "Enter your password"), ("firefox", "Mozilla Firefox (Private Browsing)"), ("code", "login.js - project"), ("term", "Bitwarden CLI")] {
            assert_eq!(none.reason(&win(app, title)), Some(Reason::PasswordManagerOrSignIn), "{app} / {title}");
        }
        for (app, title) in [("firefox", "Database Systems - Lecture 3"), ("evince", "notes.pdf"), ("code", "chunking.rs"), ("gedit", "essay draft")] {
            assert_eq!(none.reason(&win(app, title)), None, "{app} / {title}");
        }
    }

    #[test]
    fn the_person_can_add_applications_and_title_words_but_not_remove_the_built_in_ones() {
        let ex = Exclusions::new(&["Slack".into(), " ".into(), "x".into()], &["salary".into()]);
        assert_eq!(ex.reason(&win("Slack", "general")), Some(Reason::ChosenByThePerson));
        assert_eq!(ex.reason(&win("chrome", "Salary review 2026")), Some(Reason::ChosenByThePerson));
        assert_eq!(ex.reason(&win("chrome", "Lecture")), None);
        assert_eq!(ex.reason(&win("bitwarden", "x")), Some(Reason::PasswordManagerOrSignIn));
        assert_eq!(Exclusions::new(&[], &[]).reason(&win("1password", "")), Some(Reason::PasswordManagerOrSignIn));
    }

    #[test]
    fn one_excluded_window_anywhere_on_screen_rules_the_picture_out() {
        let ex = Exclusions::new(&[], &[]);
        let windows = [win("firefox", "Lecture 3"), win("evince", "Slides"), win("keepassxc", "Passwords")];
        let (blocking, reason) = ex.blocking(&windows).expect("one blocks");
        assert_eq!(blocking.app, "keepassxc");
        assert_eq!(reason, Reason::PasswordManagerOrSignIn);
        assert!(ex.blocking(&windows[..2]).is_none());
        assert!(ex.blocking(&[]).is_none());
    }
}
