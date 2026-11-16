//! Write-channel flows: `set_param` (operation 30) and `save_preset`
//! (operation 71).
//!
//! Both flows are deliberately small and explicit: the page sends one frame at
//! a time and feeds every response back. Nothing here touches USB or the DOM,
//! so the whole sequence is testable on the host.
//!
//! Writes are compiled in (the crate enables `podgo-protocol/device-write`) but
//! the page keeps them off by default: the user must arm writes, read the
//! preset first, and confirm each change (ADR-0007).
//!
//! # Sequence
//!
//! 1. four handshake packets from [`WRITE_SEQUENCE`], one response each;
//! 2. the command frame, then drain bare acknowledgements until the framed
//!    echo carrying a status arrives.
//!
//! The cursor starts at `WRITE_OPEN_2_CURSOR` plus the advance of object 76's
//! response, then advances by the command's footprint. The device discards a
//! command whose cursor is out of step, so the page must not interleave other
//! write-channel commands between these frames.

use podgo_protocol::write::{
    decode_write_status, encode_save_preset, encode_set_param, validate_preset_name,
    write_cursor_advance, WriteStatus, WRITE_FIRST_COMMAND_SEQ, WRITE_OPEN_2_CURSOR,
    WRITE_SEQUENCE,
};
use wasm_bindgen::prelude::*;

/// Timeout for a handshake packet.
const WRITE_TIMEOUT_MS: u32 = 2_000;
/// Drain timeout while waiting for the framed status echo.
const WRITE_DRAIN_MS: u32 = 250;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Handshake(usize),
    Command,
    Done,
}

/// One write command and the payload it needs to build its frame.
#[derive(Debug)]
enum Command {
    SetParam {
        block: u32,
        param: u32,
        value: f32,
        transaction: u32,
    },
    SavePreset {
        setlist: u32,
        slot: u32,
        name: String,
        transaction: u32,
    },
}

impl Command {
    fn build(&self, seq: u8, cursor: u32) -> Result<Vec<u8>, String> {
        match self {
            Self::SetParam {
                block,
                param,
                value,
                transaction,
            } => encode_set_param(*block, *param, *value, u64::from(*transaction), seq, cursor)
                .map_err(|err| err.to_string()),
            Self::SavePreset {
                setlist,
                slot,
                name,
                transaction,
            } => encode_save_preset(*setlist, *slot, name, u64::from(*transaction), seq, cursor)
                .map_err(|err| err.to_string()),
        }
    }

    fn describe(&self) -> String {
        match self {
            Self::SetParam {
                block,
                param,
                value,
                transaction,
            } => format!("block={block} param={param} value={value:.4} transaction={transaction}"),
            Self::SavePreset {
                setlist,
                slot,
                name,
                transaction,
            } => format!("setlist={setlist} slot={slot} name={name:?} transaction={transaction}"),
        }
    }
}

/// Handshake, cursor and status handling shared by every write command.
#[derive(Debug)]
struct WriteDriver {
    command: Command,
    stage: Stage,
    seq: u8,
    cursor: u32,
    frame: Option<Vec<u8>>,
    outcome: Option<Result<(), String>>,
}

impl WriteDriver {
    fn new(command: Command) -> Self {
        Self {
            command,
            stage: Stage::Handshake(0),
            seq: 0,
            cursor: 0,
            frame: None,
            outcome: None,
        }
    }

    fn restart_handshake(&mut self) {
        if let Stage::Handshake(_) = self.stage {
            self.stage = Stage::Handshake(0);
        }
    }

    fn phase(&self) -> &'static str {
        match self.stage {
            Stage::Handshake(_) => "handshake",
            Stage::Command => "command",
            Stage::Done => "done",
        }
    }

    fn timeout_ms(&self) -> u32 {
        match self.stage {
            Stage::Handshake(_) => WRITE_TIMEOUT_MS,
            _ => WRITE_DRAIN_MS,
        }
    }

    fn next_request(&self) -> Option<Vec<u8>> {
        match self.stage {
            Stage::Handshake(index) => WRITE_SEQUENCE.get(index).map(|packet| packet.to_vec()),
            Stage::Command => self.frame.clone(),
            Stage::Done => None,
        }
    }

    fn accept_response(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self.stage {
            Stage::Handshake(index) => {
                if index == WRITE_SEQUENCE.len() - 1 {
                    self.cursor = WRITE_OPEN_2_CURSOR.saturating_add(write_cursor_advance(bytes));
                    self.seq = WRITE_FIRST_COMMAND_SEQ;
                    let frame = self.command.build(self.seq, self.cursor)?;
                    self.cursor = self.cursor.saturating_add(8 + frame_body_len(&frame));
                    self.frame = Some(frame);
                    self.stage = Stage::Command;
                } else {
                    self.stage = Stage::Handshake(index + 1);
                }
                Ok(())
            }
            Stage::Command => {
                if let Some(status) = decode_write_status(bytes) {
                    self.finish(status);
                }
                Ok(())
            }
            Stage::Done => Err("write flow is already finished".to_owned()),
        }
    }

    fn is_finished(&self) -> bool {
        self.stage == Stage::Done
    }

    fn result_json(&self) -> Option<String> {
        let outcome = self.outcome.as_ref()?;
        Some(match outcome {
            Ok(()) => "{\"ok\":true}".to_owned(),
            Err(message) => {
                let mut out = String::from("{\"ok\":false,\"message\":");
                push_json_string(&mut out, message);
                out.push('}');
                out
            }
        })
    }

    fn describe(&self) -> String {
        format!(
            "{} seq={} cursor={:#06x}",
            self.command.describe(),
            self.seq,
            self.cursor
        )
    }

    fn finish(&mut self, status: WriteStatus) {
        self.stage = Stage::Done;
        self.outcome = Some(if status.is_ok() {
            Ok(())
        } else {
            Err(match status.code {
                Some(code) => format!(
                    "the pedal rejected the write: status {}, code {}",
                    status.status, code
                ),
                None => format!("the pedal rejected the write: status {}", status.status),
            })
        });
    }
}

/// One `set_param` command, driven packet by packet by the page.
#[wasm_bindgen]
#[derive(Debug)]
pub struct ParamWriteFlow {
    driver: WriteDriver,
}

#[wasm_bindgen]
impl ParamWriteFlow {
    /// Create a flow that writes `value` (raw DSP units) to one parameter.
    ///
    /// `block` is the raw chain index (input is `0`); `param` is the catalog
    /// position. `transaction` is the request id echoed by the device.
    #[wasm_bindgen(constructor)]
    pub fn new(
        block: u32,
        param: u32,
        value: f32,
        transaction: u32,
    ) -> Result<ParamWriteFlow, String> {
        if !value.is_finite() {
            return Err("parameter value is not finite".to_owned());
        }
        Ok(Self {
            driver: WriteDriver::new(Command::SetParam {
                block,
                param,
                value,
                transaction,
            }),
        })
    }

    /// Replay the handshake from its first packet after a timeout.
    ///
    /// The pedal routinely ignores the first handshake after a read session, so
    /// the driver resends the four packets instead of restarting the flow.
    #[wasm_bindgen]
    pub fn restart_handshake(&mut self) {
        self.driver.restart_handshake();
    }

    /// Current phase: `handshake`, `command` or `done`.
    #[wasm_bindgen]
    #[must_use]
    pub fn phase(&self) -> String {
        self.driver.phase().to_owned()
    }

    /// Timeout the page should apply to the next read.
    #[wasm_bindgen]
    #[must_use]
    pub fn timeout_ms(&self) -> u32 {
        self.driver.timeout_ms()
    }

    /// Next frame to send, or `undefined` when the flow is finished.
    #[wasm_bindgen]
    #[must_use]
    pub fn next_request(&self) -> Option<Vec<u8>> {
        self.driver.next_request()
    }

    /// Consume one response for the last request.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is already finished or a response
    /// arrives out of order.
    #[wasm_bindgen]
    pub fn accept_response(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.driver.accept_response(bytes)
    }

    /// True once the device answered with a status (or the flow failed).
    #[wasm_bindgen]
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.driver.is_finished()
    }

    /// JSON result: `{"ok":true}` or `{"ok":false,"message":"…"}`.
    ///
    /// `undefined` until the flow is finished.
    #[wasm_bindgen]
    #[must_use]
    pub fn result_json(&self) -> Option<String> {
        self.driver.result_json()
    }

    /// Configuration used for diagnostics.
    #[wasm_bindgen]
    #[must_use]
    pub fn describe(&self) -> String {
        self.driver.describe()
    }
}

/// One `save_preset` command (operation 71), driven packet by packet.
///
/// The command only writes preset metadata (setlist, slot and name); it does
/// not upload the preset body. The page must read and keep a backup of the
/// destination slot before running it.
#[wasm_bindgen]
#[derive(Debug)]
pub struct SavePresetFlow {
    driver: WriteDriver,
}

#[wasm_bindgen]
impl SavePresetFlow {
    /// Create a flow that saves the active preset to `slot` in `setlist`.
    ///
    /// `name` is the visible preset name, 1..=16 printable ASCII bytes; the
    /// encoder appends the NUL the device stores. `transaction` is the request
    /// id echoed by the device.
    ///
    /// # Errors
    ///
    /// Returns a message when the name is empty, too long or not printable.
    #[wasm_bindgen(constructor)]
    pub fn new(
        setlist: u32,
        slot: u32,
        name: String,
        transaction: u32,
    ) -> Result<SavePresetFlow, String> {
        validate_preset_name(&name).map_err(|err| err.to_string())?;
        Ok(Self {
            driver: WriteDriver::new(Command::SavePreset {
                setlist,
                slot,
                name,
                transaction,
            }),
        })
    }

    /// Replay the handshake from its first packet after a timeout.
    #[wasm_bindgen]
    pub fn restart_handshake(&mut self) {
        self.driver.restart_handshake();
    }

    /// Current phase: `handshake`, `command` or `done`.
    #[wasm_bindgen]
    #[must_use]
    pub fn phase(&self) -> String {
        self.driver.phase().to_owned()
    }

    /// Timeout the page should apply to the next read.
    #[wasm_bindgen]
    #[must_use]
    pub fn timeout_ms(&self) -> u32 {
        self.driver.timeout_ms()
    }

    /// Next frame to send, or `undefined` when the flow is finished.
    #[wasm_bindgen]
    #[must_use]
    pub fn next_request(&self) -> Option<Vec<u8>> {
        self.driver.next_request()
    }

    /// Consume one response for the last request.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is already finished or a response
    /// arrives out of order.
    #[wasm_bindgen]
    pub fn accept_response(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.driver.accept_response(bytes)
    }

    /// True once the device answered with a status (or the flow failed).
    #[wasm_bindgen]
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.driver.is_finished()
    }

    /// JSON result: `{"ok":true}` or `{"ok":false,"message":"…"}`.
    ///
    /// `undefined` until the flow is finished.
    #[wasm_bindgen]
    #[must_use]
    pub fn result_json(&self) -> Option<String> {
        self.driver.result_json()
    }

    /// Configuration used for diagnostics.
    #[wasm_bindgen]
    #[must_use]
    pub fn describe(&self) -> String {
        self.driver.describe()
    }
}

/// Body length declared at bytes 20..22 of a write frame.
fn frame_body_len(frame: &[u8]) -> u32 {
    if frame.len() < 22 {
        return 0;
    }
    u32::from(u16::from_le_bytes([frame[20], frame[21]]))
}

pub(crate) fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use podgo_domain::msgpack::{self, Value};

    fn framed_status(response: u32, status: u64, code: Option<u64>) -> Vec<u8> {
        let mut entries = vec![
            (Value::uint(102), Value::uint(u64::from(response))),
            (Value::uint(103), Value::uint(status)),
        ];
        if let Some(code) = code {
            entries.push((Value::uint(111), Value::uint(code)));
        }
        let body = msgpack::encode(&Value::map(entries)).unwrap();
        let mut frame = vec![0u8; 16];
        frame.extend_from_slice(&[0x00, 0x00, 0x06, 0x00]);
        frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
        frame.extend_from_slice(&[0x00, 0x00]);
        frame.extend_from_slice(&body);
        frame
    }

    fn open2_response() -> Vec<u8> {
        // Object 76 answer: framed, 9-byte body, so the cursor advance is 17.
        let body = msgpack::encode(&Value::map(vec![
            (Value::uint(102), Value::uint(1000)),
            (Value::uint(103), Value::uint(0)),
            (Value::uint(104), Value::Nil),
        ]))
        .unwrap();
        assert_eq!(body.len(), 9);
        let mut frame = vec![0u8; 16];
        frame.extend_from_slice(&[0x00, 0x00, 0x06, 0x00]);
        frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
        frame.extend_from_slice(&[0x00, 0x00]);
        frame.extend_from_slice(&body);
        frame
    }

    fn drive_handshake(driver: &mut WriteDriver) {
        for _ in 0..4 {
            assert_eq!(driver.phase(), "handshake");
            assert!(driver.next_request().is_some());
            driver.accept_response(&open2_response()).unwrap();
        }
    }

    fn drive_param(flow: &mut ParamWriteFlow) {
        drive_handshake(&mut flow.driver);
    }

    fn drive_save(flow: &mut SavePresetFlow) {
        drive_handshake(&mut flow.driver);
    }

    #[test]
    fn handshake_then_command() {
        let mut flow = ParamWriteFlow::new(6, 3, 0.5, 1001).unwrap();
        let first = flow.next_request().unwrap();
        assert_eq!(first, WRITE_SEQUENCE[0]);
        drive_param(&mut flow);
        assert_eq!(flow.phase(), "command");

        let command = flow.next_request().unwrap();
        assert_eq!(&command[4..8], &[0x80, 0x10, 0xed, 0x03]);
        assert_eq!(command[9], WRITE_FIRST_COMMAND_SEQ);
        let expected_cursor = WRITE_OPEN_2_CURSOR + 17;
        assert_eq!(&command[12..16], &expected_cursor.to_le_bytes());
        // 8 + 23 body bytes: the next command starts after this footprint.
        assert_eq!(
            &flow.describe(),
            &format!(
                "block=6 param=3 value=0.5000 transaction=1001 seq=5 cursor={:#06x}",
                expected_cursor + 8 + 23
            )
        );
    }

    #[test]
    fn bare_acks_are_ignored_until_the_status_echo() {
        let mut flow = ParamWriteFlow::new(1, 0, 0.75, 42).unwrap();
        drive_param(&mut flow);
        flow.accept_response(&[0u8; 16]).unwrap();
        assert!(!flow.is_finished());
        flow.accept_response(&framed_status(42, 0, None)).unwrap();
        assert!(flow.is_finished());
        assert_eq!(flow.result_json().as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn a_rejected_write_reports_status_and_code() {
        let mut flow = ParamWriteFlow::new(1, 0, 0.75, 43).unwrap();
        drive_param(&mut flow);
        flow.accept_response(&framed_status(43, 255, Some(7)))
            .unwrap();
        assert!(flow.is_finished());
        let result = flow.result_json().unwrap();
        assert!(result.contains("\"ok\":false"), "{result}");
        assert!(result.contains("status 255"), "{result}");
        assert!(result.contains("code 7"), "{result}");
    }

    #[test]
    fn responses_after_completion_are_rejected() {
        let mut flow = ParamWriteFlow::new(0, 0, 0.0, 1).unwrap();
        drive_param(&mut flow);
        flow.accept_response(&framed_status(1, 0, None)).unwrap();
        assert!(flow.accept_response(&[0u8; 16]).is_err());
        assert!(flow.next_request().is_none());
    }

    #[test]
    fn restart_handshake_replays_from_the_first_packet() {
        let mut flow = ParamWriteFlow::new(6, 0, 0.9, 1001).unwrap();
        flow.accept_response(&open2_response()).unwrap();
        flow.accept_response(&open2_response()).unwrap();
        assert_eq!(flow.phase(), "handshake");
        flow.restart_handshake();
        assert_eq!(flow.next_request().unwrap(), WRITE_SEQUENCE[0]);
    }

    #[test]
    fn restart_handshake_leaves_a_sent_command_alone() {
        let mut flow = ParamWriteFlow::new(6, 0, 0.9, 1001).unwrap();
        drive_param(&mut flow);
        assert_eq!(flow.phase(), "command");
        flow.restart_handshake();
        assert_eq!(flow.phase(), "command");
    }

    #[test]
    fn nan_is_refused_before_any_frame() {
        let err = ParamWriteFlow::new(0, 0, f32::NAN, 1).unwrap_err();
        assert!(err.contains("not finite"), "{err}");
    }

    #[test]
    fn save_command_carries_the_destination_and_nul_terminated_name() {
        let mut flow = SavePresetFlow::new(1, 36, "New Preset".to_owned(), 1016).unwrap();
        drive_save(&mut flow);
        assert_eq!(flow.phase(), "command");

        let command = flow.next_request().unwrap();
        let parsed = podgo_protocol::frame::Frame::parse(&command).unwrap();
        let body = podgo_protocol::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(71));
        let inner = value.get_u64(101).unwrap();
        assert_eq!(inner.get_u64(107).unwrap().as_u64(), Some(1));
        assert_eq!(inner.get_u64(108).unwrap().as_u64(), Some(36));
        assert_eq!(
            inner.get_u64(109).unwrap().as_str_bytes(),
            Some("New Preset\u{0}".as_bytes())
        );
    }

    #[test]
    fn save_rejects_an_invalid_name_before_the_handshake() {
        let err = SavePresetFlow::new(1, 0, String::new(), 1).unwrap_err();
        assert!(err.contains("empty"), "{err}");
        let err = SavePresetFlow::new(1, 0, "0123456789abcdefg".to_owned(), 1).unwrap_err();
        assert!(err.contains("16"), "{err}");
    }

    #[test]
    fn save_reports_a_rejected_status() {
        let mut flow = SavePresetFlow::new(1, 36, "New Preset".to_owned(), 1016).unwrap();
        drive_save(&mut flow);
        flow.accept_response(&framed_status(1016, 5, None)).unwrap();
        assert!(flow.is_finished());
        let result = flow.result_json().unwrap();
        assert!(result.contains("\"ok\":false"), "{result}");
        assert!(result.contains("status 5"), "{result}");
    }
}
