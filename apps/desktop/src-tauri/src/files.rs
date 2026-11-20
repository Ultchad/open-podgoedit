//! Native file saves for the desktop shell.
//!
//! A `blob:` link cannot be saved from every WebView, so exports go through a
//! native save dialog. The page calls `save_file` and never needs to know which
//! platform it runs on.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Keep only the last path component, so a suggested name can never redirect
/// the destination on its own.
fn suggested_name(name: &str) -> String {
    let trimmed = name
        .rsplit(|character| character == '/' || character == '\\')
        .next()
        .unwrap_or(name)
        .trim();
    if trimmed.is_empty() {
        "export.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Ask where to save `base64` and write it there.
///
/// Resolves to the chosen path, or `None` when the user cancels.
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    name: String,
    base64: String,
) -> Result<Option<String>, String> {
    let bytes = BASE64
        .decode(base64.as_bytes())
        .map_err(|error| format!("invalid base64 payload: {error}"))?;
    let suggested = suggested_name(&name);
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        // Blocking dialog: this runs on a blocking task, never the UI thread.
        let chosen = app
            .dialog()
            .file()
            .set_file_name(&suggested)
            .blocking_save_file();
        let Some(path) = chosen else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|error| format!("invalid save path: {error}"))?;
        std::fs::write(&path, &bytes)
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|error| format!("the save task failed: {error}"))?
}
