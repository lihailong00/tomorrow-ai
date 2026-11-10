#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod network;
mod sessions;
mod window_style;
mod location;

use tauri::Manager;

fn main() {
    let state = network::DesktopState::new().expect("Cannot initialize desktop network client");
    tauri::Builder::default()
        .manage(state)
        .manage(location::LocationState::default())
        .setup(|app| {
            if let Some(webview) = app.get_webview_window("main") {
                window_style::apply(&webview.as_ref().window());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::ThemeChanged(_) | tauri::WindowEvent::Focused(_)) {
                window_style::apply(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            network::desktop_request,
            network::desktop_stream,
            network::desktop_cancel,
            network::desktop_open_url,
            location::desktop_location_request,
            location::desktop_location_ready,
            location::desktop_location_cancel,
            location::desktop_location_settings,
            sessions::desktop_session_read,
            sessions::desktop_session_write
        ])
        .run(tauri::generate_context!())
        .expect("Cannot start 妥啦 desktop client");
}
