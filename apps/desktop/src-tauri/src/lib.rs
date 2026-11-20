//! Tauri 2 shell around the shared web editor.
//!
//! The UI is the same static bundle as the web and Android builds. The shell
//! only adds two things: a native libusb transport for the POD Go and a save
//! dialog for exports. See `docs/development/desktop.md`.

mod files;
mod usb;

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
        ])
        .run(tauri::generate_context!())
        .expect("the POD Go Editor window could not start");
}
