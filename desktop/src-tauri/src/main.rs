// A release build is a window application: no console window opens behind it on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    numz_ai_desktop_lib::run()
}
