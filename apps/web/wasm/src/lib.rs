//! Browser bindings for the read-only POD Go core.
//!
//! This crate is intentionally small: it exposes the same reports as
//! `podgo-probe` plus packet-in/packet-out flows for the setlist and the active
//! preset. The flows build requests and interpret responses with the Rust
//! protocol and domain crates; the JavaScript side only moves bytes over
//! WebUSB. It performs no device I/O and no network access itself.

mod backup;
mod events;
mod preset;
mod write;

pub use backup::{verify_backup, BackupBuilder, RestoreFlow};
pub use preset::{preset_structure, PresetFlow};
pub use write::{
    BypassFlow, ChainWriteFlow, ModelWriteFlow, ParamWriteFlow, RecallFlow, RemoveEffectFlow,
    SavePresetFlow, SnapshotFlow,
};

use podgo_domain::preset_list::scan_preset_entries;
use podgo_protocol::constants::{
    CHUNK_FIRST_SEQ, CHUNK_OFFSET_STEP, FIRST_APP_SEQ, FIRST_DATA_HEADER_LEN, MAX_CHUNKS,
    MAX_STREAM_BYTES, OP_TIMEOUT_MS, PRESET_COUNT, STREAM_BASE_OFFSET,
};
use podgo_protocol::frame::{Frame, HEADER_LEN};
use podgo_protocol::handshake::{
    build_chunk_request, build_open_stream, OPEN_PRESETS, READ_SEQUENCE,
};
use wasm_bindgen::prelude::*;

/// Parse an `l6-helix` preset blob and return the probe report.
///
/// # Errors
///
/// Returns the domain error message as a string when the blob is malformed.
#[wasm_bindgen]
pub fn inspect_preset(bytes: &[u8]) -> Result<String, String> {
    podgo_cli::inspect(bytes)
        .map(|report| podgo_cli::render(&report))
        .map_err(|err| err.to_string())
}

/// Parse a streamed setlist buffer and return the probe report.
///
/// # Errors
///
/// Returns the domain error message as a string when no entry is found.
#[wasm_bindgen]
pub fn inspect_setlist(bytes: &[u8]) -> Result<String, String> {
    podgo_cli::inspect_setlist(bytes)
        .map(|report| podgo_cli::render_setlist(&report))
        .map_err(|err| err.to_string())
}

/// Setlist entries of a streamed buffer, as JSON.
///
/// # Errors
///
/// Returns a message when no entry can be found.
#[wasm_bindgen]
pub fn setlist_entries_json(bytes: &[u8]) -> Result<String, String> {
    let entries = scan_preset_entries(bytes);
    if entries.is_empty() {
        return Err("no preset entries found in the stream".to_owned());
    }
    Ok(render_entries_from(&entries))
}

/// Move one processing block inside an `l6-helix` container.
///
/// `from` and `to` are **raw** chain indices (input is 0), so a processing
/// slot shown as `0` in the UI is raw `1`. The returned container keeps every
/// unknown field and is ready for an op-21 upload.
///
/// # Errors
///
/// Returns a message when the container is malformed, an index is out of range
/// or either index is the input/output stage.
#[wasm_bindgen]
pub fn move_chain_entry(bytes: &[u8], from: u32, to: u32) -> Result<Vec<u8>, String> {
    podgo_domain::l6helix::move_chain_entry(bytes, from as usize, to as usize)
        .map_err(|err| err.to_string())
}

/// Render scanned entries (`slot` = stream position).
fn render_entries(buffer: &[u8]) -> String {
    render_entries_from(&scan_preset_entries(buffer))
}

fn render_entries_from(entries: &[(u16, String)]) -> String {
    let mut out = String::with_capacity(entries.len() * 32);
    out.push('[');
    for (slot, (_, name)) in entries.iter().enumerate() {
        if slot > 0 {
            out.push(',');
        }
        out.push_str("{\"slot\":");
        out.push_str(&slot.to_string());
        out.push_str(",\"name\":\"");
        for ch in name.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
                ch => out.push(ch),
            }
        }
        out.push_str("\"}");
    }
    out.push(']');
    out
}

/// Version of the core package embedded in the WASM module.
#[wasm_bindgen]
#[must_use]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Handshake timeout used by the reference implementation.
///
/// The device often ignores the first attempt after connecting, so the caller
/// retries the whole five-packet handshake with a short timeout instead of
/// waiting two seconds per packet.
const HANDSHAKE_TIMEOUT_MS: u32 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Handshake,
    OpenPresets,
    OpenStream,
    Chunks,
    Done,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Handshake => "handshake",
            Self::OpenPresets => "open-presets",
            Self::OpenStream => "open-stream",
            Self::Chunks => "chunks",
            Self::Done => "done",
        }
    }
}

/// One read-only setlist stream, driven packet by packet.
///
/// Usage from JavaScript:
///
/// ```text
/// flow = new ReadFlow(setlist)
/// while not flow.is_finished():
///     request = flow.next_request()
///     response = await device.request(request, flow.timeout_ms())
///     flow.accept_response(response)
/// report = flow.report()
/// ```
///
/// The flow mirrors `podgo-session`'s stream reader: five handshake packets,
/// `OPEN_PRESETS`, `OPEN_STREAM` with the setlist selector, then absolute
/// offset chunk requests until the payload is empty or 128 entries are visible.
#[wasm_bindgen]
pub struct ReadFlow {
    setlist: u8,
    phase: Phase,
    handshake_index: usize,
    seq: u8,
    offset: u32,
    head_len: usize,
    buffer: Vec<u8>,
    chunks: usize,
    finished: bool,
    truncated: bool,
}

#[wasm_bindgen]
impl ReadFlow {
    /// Create a flow for one setlist (`0` = Factory, `1` = User).
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(setlist: u8) -> Self {
        Self {
            setlist,
            phase: Phase::Handshake,
            handshake_index: 0,
            seq: FIRST_APP_SEQ,
            offset: STREAM_BASE_OFFSET,
            head_len: 0,
            buffer: Vec::new(),
            chunks: 0,
            finished: false,
            truncated: false,
        }
    }

    /// Next request to write to the device, or `undefined` when finished.
    #[wasm_bindgen]
    #[must_use]
    pub fn next_request(&self) -> Option<Vec<u8>> {
        match self.phase {
            Phase::Handshake => READ_SEQUENCE
                .get(self.handshake_index)
                .map(|packet| packet.to_vec()),
            Phase::OpenPresets => Some(OPEN_PRESETS.to_vec()),
            Phase::OpenStream => build_open_stream(self.setlist).ok(),
            Phase::Chunks => Some(build_chunk_request(self.seq, self.offset)),
            Phase::Done => None,
        }
    }

    /// Timeout to apply to the next request.
    #[wasm_bindgen]
    #[must_use]
    pub fn timeout_ms(&self) -> u32 {
        if self.phase == Phase::Handshake {
            HANDSHAKE_TIMEOUT_MS
        } else {
            u32::try_from(OP_TIMEOUT_MS).unwrap_or(2_000)
        }
    }

    /// Consume one response for the last request.
    ///
    /// # Errors
    ///
    /// Returns a message when the response is too short, arrives in the wrong
    /// phase, exceeds the stream size limit, or the flow already finished.
    #[wasm_bindgen]
    pub fn accept_response(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.phase == Phase::Done {
            return Err(format!(
                "flow is already {}; no response expected",
                self.phase.as_str()
            ));
        }
        if bytes.len() < HEADER_LEN {
            return Err(format!(
                "response too short: {} B (the protocol header is {} B)",
                bytes.len(),
                HEADER_LEN
            ));
        }
        let frame = Frame::parse(bytes).map_err(|err| err.to_string())?;

        match self.phase {
            Phase::Handshake => {
                self.handshake_index += 1;
                if self.handshake_index >= READ_SEQUENCE.len() {
                    self.phase = Phase::OpenPresets;
                    self.seq = FIRST_APP_SEQ;
                }
                Ok(())
            }
            Phase::OpenPresets => {
                self.phase = Phase::OpenStream;
                self.seq = self.seq.wrapping_add(1);
                Ok(())
            }
            Phase::OpenStream => {
                let head_start = FIRST_DATA_HEADER_LEN - HEADER_LEN;
                let head = frame.body().get(head_start..).unwrap_or_default();
                if head.len() > MAX_STREAM_BYTES {
                    return Err(format!(
                        "open response carried {} B, above the {} B stream limit",
                        head.len(),
                        MAX_STREAM_BYTES
                    ));
                }
                self.head_len = head.len();
                self.buffer.clear();
                self.buffer.extend_from_slice(head);
                self.phase = Phase::Chunks;
                self.offset = STREAM_BASE_OFFSET;
                self.seq = CHUNK_FIRST_SEQ;
                self.chunks = 0;
                Ok(())
            }
            Phase::Chunks => {
                let payload = frame.body();
                if payload.is_empty() {
                    self.finish();
                    return Ok(());
                }

                let relative = usize::try_from(self.offset.saturating_sub(STREAM_BASE_OFFSET))
                    .unwrap_or(usize::MAX);
                let start = self.head_len.saturating_add(relative);
                let end = start.saturating_add(payload.len());
                if end > MAX_STREAM_BYTES {
                    return Err(format!(
                        "preset stream exceeded the {} B limit at {} B",
                        MAX_STREAM_BYTES, end
                    ));
                }
                if end > self.buffer.len() {
                    self.buffer.resize(end, 0);
                }
                self.buffer[start..end].copy_from_slice(payload);
                self.chunks += 1;

                if scan_preset_entries(&self.buffer).len() >= PRESET_COUNT {
                    self.finish();
                } else if self.chunks >= MAX_CHUNKS {
                    self.truncated = true;
                    self.finish();
                } else {
                    self.offset = self.offset.wrapping_add(CHUNK_OFFSET_STEP);
                    self.seq = self.seq.wrapping_add(1);
                }
                Ok(())
            }
            Phase::Done => unreachable!("guarded above"),
        }
    }

    /// Whether the flow has nothing more to request.
    #[wasm_bindgen]
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Human-readable phase name (`handshake`, `open-presets`, …).
    #[wasm_bindgen]
    #[must_use]
    pub fn phase(&self) -> String {
        self.phase.as_str().to_owned()
    }

    /// Number of chunk responses consumed so far.
    #[wasm_bindgen]
    #[must_use]
    pub fn chunks(&self) -> usize {
        self.chunks
    }

    /// Setlist entries as JSON: `[{"slot":0,"name":"..."}]`.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is not finished.
    #[wasm_bindgen]
    pub fn entries_json(&self) -> Result<String, String> {
        if !self.finished {
            return Err(format!(
                "setlist is not finished (phase: {})",
                self.phase.as_str()
            ));
        }
        Ok(render_entries(&self.buffer))
    }

    /// Whether the stream hit the 64-chunk cap before 128 entries appeared.
    #[wasm_bindgen]
    #[must_use]
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Reassembled raw setlist bytes, for diagnostics or a local dump.
    #[wasm_bindgen]
    #[must_use]
    pub fn raw(&self) -> Vec<u8> {
        self.buffer.clone()
    }

    /// Render the reassembled setlist with the same report as `podgo-probe`.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is not finished or no entry was found.
    #[wasm_bindgen]
    pub fn report(&self) -> Result<String, String> {
        if !self.finished {
            return Err(format!(
                "stream is not finished (phase: {})",
                self.phase.as_str()
            ));
        }
        podgo_cli::inspect_setlist(&self.buffer)
            .map(|report| podgo_cli::render_setlist(&report))
            .map_err(|err| err.to_string())
    }

    fn finish(&mut self) {
        self.phase = Phase::Done;
        self.finished = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRESET: &[u8] = include_bytes!("../../../../fixtures/spec02_obj22_blob.bin");
    const SETLIST: &[u8] = include_bytes!("../../../../fixtures/user_setlist.bin");

    fn response(request: &[u8], body: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; HEADER_LEN];
        out[3] = 0x18;
        out[4..6].copy_from_slice(&request[6..8]);
        out[6..8].copy_from_slice(&request[4..6]);
        out[11] = 0x04;
        out.extend_from_slice(body);
        out
    }

    fn ack() -> Vec<u8> {
        vec![0u8; HEADER_LEN]
    }

    fn drive(setlist: u8, fixture: &[u8], ack_head: &[u8], payload_len: usize) -> ReadFlow {
        let mut flow = ReadFlow::new(setlist);
        for _ in 0..READ_SEQUENCE.len() {
            let request = flow.next_request().unwrap();
            flow.accept_response(&response(&request, &[])).unwrap();
        }

        let request = flow.next_request().unwrap();
        assert_eq!(request, OPEN_PRESETS);
        flow.accept_response(&ack()).unwrap();

        let request = flow.next_request().unwrap();
        let mut open_body = vec![0u8; FIRST_DATA_HEADER_LEN - HEADER_LEN];
        open_body.extend_from_slice(ack_head);
        flow.accept_response(&response(&request, &open_body))
            .unwrap();

        let mut guard = 0;
        while !flow.is_finished() {
            let request = flow.next_request().unwrap();
            let cursor =
                u32::from_le_bytes([request[12], request[13], request[14], request[15]]) as usize;
            let relative = cursor - STREAM_BASE_OFFSET as usize;
            let start = ack_head.len() + relative;
            let payload = if start >= fixture.len() {
                &[][..]
            } else {
                let end = (start + payload_len).min(fixture.len());
                &fixture[start..end]
            };
            flow.accept_response(&response(&request, payload)).unwrap();
            guard += 1;
            assert!(guard < 200, "flow did not terminate");
        }
        flow
    }

    #[test]
    fn preset_report_matches_the_cli() {
        let text = inspect_preset(PRESET).unwrap();
        assert!(text.contains("container: l6-helix"));
        assert!(text.contains("round-trip: byte-identical"));
    }

    #[test]
    fn setlist_report_lists_every_slot() {
        let text = inspect_setlist(SETLIST).unwrap();
        assert!(text.contains("setlist:   128 entries"));
        assert!(text.contains("slot 127"));
    }

    #[test]
    fn setlist_entries_json_lists_slots_in_order() {
        let json = setlist_entries_json(SETLIST).unwrap();
        assert!(json.starts_with("[{\"slot\":0,\"name\":"));
        assert!(json.contains("{\"slot\":127,"));
        let flow = drive(1, SETLIST, &[], 496);
        assert_eq!(flow.entries_json().unwrap(), json);
    }

    #[test]
    fn malformed_input_returns_a_message() {
        let err = inspect_preset(b"not a preset").unwrap_err();
        assert!(err.contains("invalid container"));
        let err = inspect_setlist(b"no entries").unwrap_err();
        assert!(err.contains("no preset entries"));
    }

    #[test]
    fn request_sequence_matches_the_reference_flow() {
        let mut flow = ReadFlow::new(1);
        assert_eq!(flow.phase(), "handshake");
        assert_eq!(flow.timeout_ms(), HANDSHAKE_TIMEOUT_MS);

        for (index, packet) in READ_SEQUENCE.iter().enumerate() {
            assert_eq!(flow.next_request().unwrap(), *packet);
            assert_eq!(flow.chunks(), 0);
            flow.accept_response(&response(READ_SEQUENCE[index], &[]))
                .unwrap();
        }

        assert_eq!(flow.phase(), "open-presets");
        assert_eq!(flow.timeout_ms(), u32::try_from(OP_TIMEOUT_MS).unwrap());
        assert_eq!(flow.next_request().unwrap(), OPEN_PRESETS);
        flow.accept_response(&ack()).unwrap();

        assert_eq!(flow.phase(), "open-stream");
        assert_eq!(flow.next_request().unwrap(), build_open_stream(1).unwrap());
        flow.accept_response(&ack()).unwrap();

        assert_eq!(flow.phase(), "chunks");
        assert_eq!(
            flow.next_request().unwrap(),
            build_chunk_request(CHUNK_FIRST_SEQ, STREAM_BASE_OFFSET)
        );
    }

    #[test]
    fn reassembles_the_user_fixture_by_absolute_offset() {
        let flow = drive(1, SETLIST, &[], 496);
        assert!(flow.is_finished());
        assert!(!flow.truncated());
        assert_eq!(flow.chunks(), 13);
        assert_eq!(flow.raw(), SETLIST);

        let report = flow.report().unwrap();
        assert!(report.contains("setlist:   128 entries"));
        assert!(report.contains("slot 127"));
        assert!(report.contains("Preset 037"));
    }

    #[test]
    fn keeps_data_carried_by_the_open_response() {
        let head = &SETLIST[..100];
        let flow = drive(1, SETLIST, head, 496);
        assert!(flow.is_finished());
        assert_eq!(flow.raw(), SETLIST);
        assert!(flow.report().unwrap().contains("slot 127"));
    }

    #[test]
    fn empty_payload_ends_the_stream_early() {
        let mut flow = ReadFlow::new(0);
        for _ in 0..READ_SEQUENCE.len() {
            let request = flow.next_request().unwrap();
            flow.accept_response(&response(&request, &[])).unwrap();
        }
        let request = flow.next_request().unwrap();
        assert_eq!(request, OPEN_PRESETS);
        flow.accept_response(&ack()).unwrap();

        let request = flow.next_request().unwrap();
        flow.accept_response(&response(&request, &[])).unwrap();
        assert_eq!(flow.phase(), "chunks");

        let request = flow.next_request().unwrap();
        flow.accept_response(&response(&request, &[])).unwrap();
        assert!(flow.is_finished());
        assert_eq!(flow.chunks(), 0);
        assert!(flow.report().is_err());
    }
}
