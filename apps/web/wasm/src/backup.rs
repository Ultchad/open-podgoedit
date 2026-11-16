//! Full backup (`.pgbak`) and restore (op-5 streamed writes).
//!
//! The page reads both setlists and every non-empty slot, feeds the raw
//! `l6-helix` bodies to [`BackupBuilder`], and downloads the encoded file.
//! Verification happens entirely in Rust: the container, every per-entry body
//! and the whole-file digest are checked before any restore is allowed.
//!
//! [`RestoreFlow`] replays the read-channel preamble (`READ_SEQUENCE`), then
//! streams one operation-5 message per preset. Protocol decisions stay in
//! `podgo-protocol`; this module only sequences frames and tracks the
//! stream-window cursor.
//!
//! **Restore is not hardware-validated.** The frame layout comes from
//! `reverse/exports/podgo-backup-restore.pcapng`, but no op-5 write from this
//! build has been applied to a pedal yet.

use podgo_domain::backup::Backup;
use podgo_domain::sha256;
use podgo_protocol::handshake::READ_SEQUENCE;
use podgo_protocol::write::{
    decode_write_status, encode_restore_preset, encode_restore_stream, StreamFrame,
    RESTORE_CURSOR_ADVANCE,
};
use wasm_bindgen::prelude::*;

/// Frame timeout while draining a handshake or a stream-window status.
const RESTORE_TIMEOUT_MS: u32 = 2_000;
/// Cursor for the first op-5 message: `SESSION_CHUNK_2` starts at 0x101a.
const RESTORE_FIRST_CURSOR: u32 = 0x101A;
/// Sequence number of the first op-5 frame: the five preamble packets use 0..=5.
const RESTORE_FIRST_SEQ: u8 = 6;

/// Incrementally build a `.pgbak` file from raw preset bodies.
#[wasm_bindgen]
#[derive(Debug)]
pub struct BackupBuilder {
    backup: Backup,
}

#[wasm_bindgen]
impl BackupBuilder {
    /// Create a backup for one product/firmware pair.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(product: String, firmware: String) -> BackupBuilder {
        Self {
            backup: Backup::new(product, firmware),
        }
    }

    /// Set the product and firmware strings recorded in the file header.
    ///
    /// The page learns them from the first preset it reads, so this is called
    /// before [`BackupBuilder::finish`].
    #[wasm_bindgen]
    pub fn set_metadata(&mut self, product: String, firmware: String) {
        self.backup.product = product;
        self.backup.firmware = firmware;
    }

    /// Add one raw `l6-helix` body, exactly as the pedal returned it.
    ///
    /// # Errors
    ///
    /// Returns a message for an unknown setlist, a slot above 127, an
    /// over-long name or body, or a duplicate destination slot.
    pub fn add(&mut self, setlist: u8, slot: u8, name: String, blob: &[u8]) -> Result<(), String> {
        self.backup
            .add(setlist, slot, name, blob.to_vec())
            .map_err(|err| err.to_string())
    }

    /// Number of presets added so far.
    #[wasm_bindgen]
    #[must_use]
    pub fn len(&self) -> usize {
        self.backup.len()
    }

    /// True when no preset has been added.
    #[wasm_bindgen]
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.backup.is_empty()
    }

    /// Sum of all raw preset body lengths.
    #[wasm_bindgen]
    #[must_use]
    pub fn total_bytes(&self) -> usize {
        self.backup.total_blob_bytes()
    }

    /// Encode the container and re-verify it before returning the bytes.
    ///
    /// # Errors
    ///
    /// Returns a message when encoding fails or the encoded file does not
    /// decode back to the same content.
    #[wasm_bindgen]
    pub fn finish(&self) -> Result<Vec<u8>, String> {
        let bytes = self.backup.encode().map_err(|err| err.to_string())?;
        Backup::decode(&bytes).map_err(|err| format!("backup self-check failed: {err}"))?;
        Ok(bytes)
    }
}

/// Verify a `.pgbak` file and return its metadata, entries and digest as JSON.
///
/// The function refuses anything that does not decode cleanly: wrong magic,
/// unknown version, duplicate slot, truncated entry, body digest mismatch or
/// whole-file digest mismatch.
///
/// # Errors
///
/// Returns the domain error message when the file is not a valid backup.
#[wasm_bindgen]
pub fn verify_backup(bytes: &[u8]) -> Result<String, String> {
    let backup = Backup::decode(bytes).map_err(|err| err.to_string())?;
    Ok(render_backup(&backup, bytes))
}

fn render_backup(backup: &Backup, bytes: &[u8]) -> String {
    let mut out = String::with_capacity(256 + backup.entries.len() * 96);
    out.push_str("{\"product\":");
    crate::write::push_json_string(&mut out, &backup.product);
    out.push_str(",\"firmware\":");
    crate::write::push_json_string(&mut out, &backup.firmware);
    out.push_str(",\"digest\":");
    crate::write::push_json_string(&mut out, &sha256::hex_digest(bytes));
    out.push_str(",\"entries\":[");
    for (index, entry) in backup.entries.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"setlist\":");
        out.push_str(&entry.setlist.to_string());
        out.push_str(",\"slot\":");
        out.push_str(&entry.slot.to_string());
        out.push_str(",\"name\":");
        crate::write::push_json_string(&mut out, &entry.name);
        out.push_str(",\"size\":");
        out.push_str(&entry.blob.len().to_string());
        out.push_str(",\"sha256\":");
        crate::write::push_json_string(&mut out, &sha256::hex_digest(&entry.blob));
        out.push('}');
    }
    out.push_str("]}");
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Preamble(usize),
    Streaming,
    Done,
}

/// One op-5 restore sequence, driven frame by frame by the page.
///
/// Usage from JavaScript:
///
/// ```text
/// flow = new RestoreFlow(backupBytes, transactionStart)
/// while not flow.is_finished():
///     request = flow.next_request()
///     if request is None: break
///     await device.send(request)
///     while flow.expects_response():
///         response = await device.readRead(flow.timeout_ms())
///         if response is None: flow.accept_timeout()
///         else: flow.accept_response(response)
/// result = flow.result_json()
/// ```
#[wasm_bindgen]
#[derive(Debug)]
pub struct RestoreFlow {
    entries: Vec<podgo_domain::backup::BackupEntry>,
    index: usize,
    stage: Stage,
    seq: u8,
    cursor: u32,
    frames: Vec<StreamFrame>,
    frame_index: usize,
    transaction: u64,
    waiting: bool,
    outcome: Option<Result<(), String>>,
}

#[wasm_bindgen]
impl RestoreFlow {
    /// Parse a verified backup and prepare the first op-5 message.
    ///
    /// `transaction_start` is the request id of the first message; it is
    /// incremented for each preset.
    ///
    /// # Errors
    ///
    /// Returns a message when the file is not a valid backup, contains no
    /// preset, or the first body cannot be encoded.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], transaction_start: u32) -> Result<RestoreFlow, String> {
        let backup = Backup::decode(bytes).map_err(|err| err.to_string())?;
        if backup.is_empty() {
            return Err("the backup contains no preset".to_owned());
        }
        let mut flow = Self {
            entries: backup.entries,
            index: 0,
            stage: Stage::Preamble(0),
            seq: RESTORE_FIRST_SEQ,
            cursor: RESTORE_FIRST_CURSOR,
            frames: Vec::new(),
            frame_index: 0,
            transaction: u64::from(transaction_start),
            waiting: false,
            outcome: None,
        };
        flow.prepare_entry()?;
        Ok(flow)
    }

    /// Replay the preamble from its first packet after a timeout.
    #[wasm_bindgen]
    pub fn restart_handshake(&mut self) {
        if let Stage::Preamble(_) = self.stage {
            self.stage = Stage::Preamble(0);
        }
    }

    /// Current phase: `preamble`, `stream` or `done`.
    #[wasm_bindgen]
    #[must_use]
    pub fn phase(&self) -> String {
        match self.stage {
            Stage::Preamble(_) => "preamble",
            Stage::Streaming => "stream",
            Stage::Done => "done",
        }
        .to_owned()
    }

    /// Timeout the page should apply when it reads a response.
    #[wasm_bindgen]
    #[must_use]
    pub fn timeout_ms(&self) -> u32 {
        RESTORE_TIMEOUT_MS
    }

    /// Next frame to send, or `undefined` when the flow is finished.
    #[wasm_bindgen]
    #[must_use]
    pub fn next_request(&mut self) -> Option<Vec<u8>> {
        if self.outcome.is_some() || self.stage == Stage::Done {
            return None;
        }
        match self.stage {
            Stage::Preamble(index) => {
                let packet = READ_SEQUENCE.get(index)?.to_vec();
                self.waiting = true;
                Some(packet)
            }
            Stage::Streaming => {
                self.maybe_finish();
                if self.stage == Stage::Done {
                    return None;
                }
                if self.frame_index >= self.frames.len() {
                    self.index += 1;
                    if let Err(message) = self.prepare_entry() {
                        self.fail(message);
                        return None;
                    }
                }
                let frame = self.frames.get(self.frame_index)?;
                self.frame_index += 1;
                self.waiting = frame.window_end;
                let bytes = frame.bytes.clone();
                self.maybe_finish();
                Some(bytes)
            }
            Stage::Done => None,
        }
    }

    /// True when the page must read a response before sending the next frame.
    #[wasm_bindgen]
    #[must_use]
    pub fn expects_response(&self) -> bool {
        self.waiting
    }

    /// Consume one read-channel response.
    ///
    /// Bare acknowledgements are ignored while waiting for a window status.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is already finished or the device
    /// reports a status that is not a window grant.
    #[wasm_bindgen]
    pub fn accept_response(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("restore flow is already finished".to_owned());
        }
        match self.stage {
            Stage::Preamble(index) => {
                if let Some(status) = decode_write_status(bytes) {
                    if !status.is_ok() {
                        let message = format!(
                            "the pedal rejected the restore preamble: status {}",
                            status.status
                        );
                        self.fail(message.clone());
                        return Err(message);
                    }
                }
                self.waiting = false;
                if index + 1 >= READ_SEQUENCE.len() {
                    self.stage = Stage::Streaming;
                } else {
                    self.stage = Stage::Preamble(index + 1);
                }
                Ok(())
            }
            Stage::Streaming => {
                let Some(status) = decode_write_status(bytes) else {
                    // Bare chunk acknowledgement; keep waiting for the
                    // framed window status.
                    return Ok(());
                };
                match status.status {
                    1 => {
                        self.waiting = false;
                        self.maybe_finish();
                        Ok(())
                    }
                    0 => {
                        // The device says the message is complete. Accept it;
                        // the post-restore setlist read is the real check.
                        self.waiting = false;
                        self.maybe_finish();
                        Ok(())
                    }
                    _ => {
                        let message = match status.code {
                            Some(code) => format!(
                                "the pedal rejected the restore stream: status {}, code {}",
                                status.status, code
                            ),
                            None => format!(
                                "the pedal rejected the restore stream: status {}",
                                status.status
                            ),
                        };
                        self.waiting = false;
                        self.fail(message.clone());
                        Err(message)
                    }
                }
            }
            Stage::Done => Err("restore flow is already finished".to_owned()),
        }
    }

    /// Signal that the pending read timed out.
    ///
    /// # Errors
    ///
    /// A handshake or window timeout aborts the flow with a message.
    #[wasm_bindgen]
    pub fn accept_timeout(&mut self) -> Result<(), String> {
        if !self.waiting {
            return Ok(());
        }
        self.waiting = false;
        let message = match self.stage {
            Stage::Preamble(_) => "the pedal did not answer the restore preamble".to_owned(),
            _ => "the pedal did not acknowledge the restore stream window".to_owned(),
        };
        self.fail(message.clone());
        Err(message)
    }

    /// True when every preset has been sent (or the flow failed).
    #[wasm_bindgen]
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.outcome.is_some() || self.stage == Stage::Done
    }

    /// Number of presets started so far.
    #[wasm_bindgen]
    #[must_use]
    pub fn progress(&self) -> usize {
        self.index
    }

    /// Total number of presets in the backup.
    #[wasm_bindgen]
    #[must_use]
    pub fn total(&self) -> usize {
        self.entries.len()
    }

    /// JSON description of the preset currently being sent.
    #[wasm_bindgen]
    #[must_use]
    pub fn current_json(&self) -> String {
        let Some(entry) = self.entries.get(self.index) else {
            return "null".to_owned();
        };
        let mut out = String::from("{\"setlist\":");
        out.push_str(&entry.setlist.to_string());
        out.push_str(",\"slot\":");
        out.push_str(&entry.slot.to_string());
        out.push_str(",\"name\":");
        crate::write::push_json_string(&mut out, &entry.name);
        out.push('}');
        out
    }

    /// JSON result: `{"ok":true,"entries":N}` or `{"ok":false,"message":"…"}`.
    #[wasm_bindgen]
    #[must_use]
    pub fn result_json(&self) -> Option<String> {
        let outcome = self.outcome.as_ref()?;
        Some(match outcome {
            Ok(()) => format!("{{\"ok\":true,\"entries\":{}}}", self.entries.len()),
            Err(message) => {
                let mut out = String::from("{\"ok\":false,\"message\":");
                crate::write::push_json_string(&mut out, message);
                out.push('}');
                out
            }
        })
    }

    /// Build the frames of the preset at `index`.
    fn prepare_entry(&mut self) -> Result<(), String> {
        let entry = self
            .entries
            .get(self.index)
            .ok_or_else(|| "restore index is out of range".to_owned())?;
        let body = encode_restore_preset(entry.setlist, entry.slot, &entry.blob, self.transaction)
            .map_err(|err| err.to_string())?;
        let frames =
            encode_restore_stream(&body, self.seq, self.cursor).map_err(|err| err.to_string())?;
        let frame_count = u8::try_from(frames.len())
            .map_err(|_| "restore message has too many frames".to_owned())?;
        self.seq = self.seq.wrapping_add(frame_count);
        let windows = frames.iter().filter(|frame| frame.window_end).count() as u32;
        self.cursor = self
            .cursor
            .wrapping_add(windows.saturating_mul(RESTORE_CURSOR_ADVANCE));
        self.transaction = self.transaction.wrapping_add(1);
        self.frames = frames;
        self.frame_index = 0;
        Ok(())
    }

    /// Mark the flow complete once the last frame of the last preset has been
    /// handed out (and acknowledged, for a window-ending frame).
    fn maybe_finish(&mut self) {
        if self.stage == Stage::Streaming
            && !self.waiting
            && self.frame_index >= self.frames.len()
            && self.index + 1 >= self.entries.len()
        {
            self.stage = Stage::Done;
            self.outcome = Some(Ok(()));
        }
    }

    fn fail(&mut self, message: String) {
        self.stage = Stage::Done;
        self.outcome = Some(Err(message));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use podgo_domain::sha256;

    fn sample_backup() -> Vec<u8> {
        let mut builder = BackupBuilder::new("P34".to_owned(), "v2.50".to_owned());
        let mut blob = vec![0xa9, b'l', b'6', b'-', b'h', b'e', b'l', b'i', b'x', 0];
        blob.resize(300, 0x5a);
        builder.add(1, 7, "Lead".to_owned(), &blob).unwrap();
        builder.finish().unwrap()
    }

    #[test]
    fn builder_round_trips_and_verifies() {
        let bytes = sample_backup();
        let json = verify_backup(&bytes).unwrap();
        assert!(json.contains("\"product\":\"P34\""), "{json}");
        assert!(json.contains("\"firmware\":\"v2.50\""), "{json}");
        assert!(json.contains("\"setlist\":1"), "{json}");
        assert!(json.contains("\"slot\":7"), "{json}");
        assert!(json.contains("\"name\":\"Lead\""), "{json}");
        assert!(json.contains("\"size\":300"), "{json}");
        assert!(json.contains(&format!("\"digest\":\"{}\"", sha256::hex_digest(&bytes))));
    }

    #[test]
    fn verify_rejects_tampering() {
        let bytes = sample_backup();
        let mut changed = bytes.clone();
        changed[70] ^= 0xff;
        assert!(verify_backup(&changed).is_err());
        assert!(verify_backup(&[]).is_err());
    }

    #[test]
    fn builder_rejects_duplicates_and_out_of_range_slots() {
        let mut builder = BackupBuilder::new(String::new(), String::new());
        builder.add(0, 0, "A".to_owned(), &[1]).unwrap();
        assert!(builder.add(0, 0, "B".to_owned(), &[2]).is_err());
        assert!(builder.add(2, 0, "C".to_owned(), &[3]).is_err());
        assert!(builder.add(0, 128, "D".to_owned(), &[4]).is_err());
    }

    #[test]
    fn restore_flow_sends_the_preamble_then_one_op5_message() {
        let bytes = sample_backup();
        let mut flow = RestoreFlow::new(&bytes, 2000).unwrap();
        assert_eq!(flow.phase(), "preamble");
        assert_eq!(flow.total(), 1);

        for expected in READ_SEQUENCE {
            let request = flow.next_request().unwrap();
            assert_eq!(request, expected);
            assert!(flow.expects_response());
            flow.accept_response(&[0u8; 16]).unwrap();
        }
        assert_eq!(flow.phase(), "stream");
        assert!(!flow.expects_response());

        let frame = flow.next_request().unwrap();
        assert_eq!(&frame[4..8], &[0x01, 0x10, 0xef, 0x03]);
        assert_eq!(frame[9], RESTORE_FIRST_SEQ);
        assert_eq!(&frame[12..16], &RESTORE_FIRST_CURSOR.to_le_bytes());
        assert_eq!(&frame[16..20], &podgo_protocol::write::RESTORE_SUBHEADER);
        assert!(!flow.expects_response());
        assert!(flow.is_finished());
        assert_eq!(
            flow.result_json().as_deref(),
            Some("{\"ok\":true,\"entries\":1}")
        );
    }

    #[test]
    fn restore_flow_waits_for_the_window_status() {
        // 2000 bytes force the 1536-byte window and a status read.
        let mut blob = vec![0x11u8; 2000];
        blob[0] = 0xa9;
        let mut builder = BackupBuilder::new(String::new(), String::new());
        builder.add(0, 3, "Big".to_owned(), &blob).unwrap();
        let bytes = builder.finish().unwrap();
        let mut flow = RestoreFlow::new(&bytes, 1).unwrap();
        for expected in READ_SEQUENCE {
            let request = flow.next_request().unwrap();
            assert_eq!(request, expected);
            flow.accept_response(&[0u8; 16]).unwrap();
        }

        let mut saw_window = false;
        while let Some(frame) = flow.next_request() {
            // Frames sent after the window carry the advanced cursor.
            let cursor = u32::from_le_bytes(frame[12..16].try_into().unwrap());
            if saw_window {
                assert_eq!(cursor, RESTORE_FIRST_CURSOR + RESTORE_CURSOR_ADVANCE);
            } else {
                assert_eq!(cursor, RESTORE_FIRST_CURSOR);
            }
            if flow.expects_response() {
                saw_window = true;
                let status = framed_status(1, 1);
                flow.accept_response(&status).unwrap();
            }
        }
        assert!(saw_window);
        assert!(flow.is_finished());
        assert_eq!(flow.progress(), 0);
    }

    #[test]
    fn a_window_timeout_aborts_with_a_message() {
        let mut blob = vec![0x22u8; 2000];
        blob[0] = 0xa9;
        let mut builder = BackupBuilder::new(String::new(), String::new());
        builder.add(0, 0, "Big".to_owned(), &blob).unwrap();
        let bytes = builder.finish().unwrap();
        let mut flow = RestoreFlow::new(&bytes, 1).unwrap();
        for _ in READ_SEQUENCE {
            flow.next_request().unwrap();
            flow.accept_response(&[0u8; 16]).unwrap();
        }
        while !flow.expects_response() {
            if flow.next_request().is_none() {
                break;
            }
        }
        assert!(flow.expects_response());
        assert!(flow.accept_timeout().is_err());
        assert!(flow.is_finished());
        let result = flow.result_json().unwrap();
        assert!(result.contains("\"ok\":false"), "{result}");
        assert!(result.contains("window"), "{result}");
    }

    fn framed_status(response: u32, status: u64) -> Vec<u8> {
        use podgo_domain::msgpack::{self, Value};
        let body = msgpack::encode(&Value::map(vec![
            (Value::uint(102), Value::uint(u64::from(response))),
            (Value::uint(103), Value::uint(status)),
            (Value::uint(104), Value::Nil),
        ]))
        .unwrap();
        let mut frame = vec![0u8; 16];
        frame[0..2].copy_from_slice(&(8u16 + body.len() as u16).to_le_bytes());
        frame[3] = 0x18;
        frame[4..8].copy_from_slice(&[0xef, 0x03, 0x01, 0x10]);
        frame.extend_from_slice(&[0x00, 0x00, 0x02, 0x00]);
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        frame
    }
}
