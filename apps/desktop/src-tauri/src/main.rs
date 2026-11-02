#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod network;
mod sessions;

fn main() {
    let state = network::DesktopState::new().expect("Cannot initialize desktop network client");
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            network::desktop_request,
            network::desktop_stream,
            network::desktop_cancel,
            network::desktop_open_url,
            sessions::desktop_session_read,
            sessions::desktop_session_write
        ])
        .run(tauri::generate_context!())
        .expect("Cannot start 妥啦 desktop client");
}
