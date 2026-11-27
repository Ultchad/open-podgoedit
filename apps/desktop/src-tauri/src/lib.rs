//! Tauri 2 shell around the shared web editor.
//!
//! The UI is the same static bundle as the web and Android builds. The shell
//! only adds two things: a native libusb transport for the POD Go and a save
//! dialog for exports. See `docs/development/desktop.md`.

mod files;
mod usb;

/// Shell adapter contract version. Keep in sync with `SHELL_API_VERSION` in
/// `apps/web/src/shell.ts` and `API_VERSION` in the Android bridge; CI
/// (`scripts/verify-shell-consumers.mjs`) fails if they drift.
const SHELL_API_VERSION: u32 = 1;

/// Report the adapter version to the bundled web UI's startup handshake.
#[tauri::command]
fn shell_api_version() -> u32 {
    SHELL_API_VERSION
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(usb::UsbState::default())
        .invoke_handler(tauri::generate_handler![
            usb::usb_open,
            usb::usb_close,
            usb::usb_discard,
            usb::usb_read,
            usb::usb_write,
            files::save_file,
            shell_api_version,
        ])
        .run(tauri::generate_context!())
        .expect("the POD Go Editor window could not start");
}
