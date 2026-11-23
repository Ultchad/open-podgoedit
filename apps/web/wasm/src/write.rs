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
    build_chain_frame, decode_write_status, encode_chain_upload, encode_recall_preset,
    encode_remove_effect, encode_save_preset, encode_set_bypass, encode_set_model,
    encode_set_param, validate_preset_name, write_cursor_advance, CHAIN_CHUNK_BYTES,
    CHAIN_CURSOR_ADVANCE, CHAIN_FIRST_BYTES, WRITE_FIRST_COMMAND_SEQ, WRITE_OPEN_2_CURSOR,
    WRITE_SEQUENCE,
};
use wasm_bindgen::prelude::*;

/// Timeout for a handshake packet.
const WRITE_TIMEOUT_MS: u32 = 2_000;
/// Drain timeout while waiting for the framed status echo.
const WRITE_DRAIN_MS: u32 = 250;
/// Timeout granted to the op-21 status, which the pedal sends while the stream
/// is still being written.
const CHAIN_STATUS_TIMEOUT_MS: u32 = 2_000;

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
    SetModel {
        block: u32,
        wire_id: u32,
        no_snapshot_bypass: bool,
        transaction: u32,
    },
    SavePreset {
        setlist: u32,
        slot: u32,
        name: String,
        transaction: u32,
    },
    RecallPreset {
        setlist: u32,
        slot: u32,
        transaction: u32,
    },
    SetBypass {
        block: u32,
        enabled: bool,
        transaction: u32,
    },
    RemoveEffect {
        block: u32,
        commit: bool,
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
            Self::SetModel {
                block,
                wire_id,
                no_snapshot_bypass,
                transaction,
            } => encode_set_model(
                *block,
                *wire_id,
                *no_snapshot_bypass,
                u64::from(*transaction),
                seq,
                cursor,
            )
            .map_err(|err| err.to_string()),
            Self::SavePreset {
                setlist,
                slot,
                name,
                transaction,
            } => encode_save_preset(*setlist, *slot, name, u64::from(*transaction), seq, cursor)
                .map_err(|err| err.to_string()),
            Self::RecallPreset {
                setlist,
                slot,
                transaction,
            } => encode_recall_preset(
                u8::try_from(*setlist).unwrap_or(u8::MAX),
                u8::try_from(*slot).unwrap_or(u8::MAX),
                u64::from(*transaction),
                seq,
                cursor,
            )
            .map_err(|err| err.to_string()),
            Self::SetBypass {
                block,
                enabled,
                transaction,
            } => encode_set_bypass(*block, *enabled, u64::from(*transaction), seq, cursor)
                .map_err(|err| err.to_string()),
            Self::RemoveEffect {
                block,
                commit,
                transaction,
            } => encode_remove_effect(*block, *commit, u64::from(*transaction), seq, cursor)
                .map_err(|err| err.to_string()),
        }
    }

    /// The command the page must send after this one, if any.
    fn follow_up(&self) -> Option<Self> {
        match self {
            Self::RemoveEffect {
                block,
                commit: false,
                transaction,
            } => Some(Self::RemoveEffect {
                block: *block,
                commit: true,
                transaction: transaction.wrapping_add(1),
            }),
            _ => None,
        }
    }

    /// Statuses the device may answer with on success.
    ///
    /// Ordinary writes answer `0`; a recall answers `1` in the captured
    /// editor. Both are accepted for a recall so a future firmware that
    /// answers `0` is not rejected.
    fn accepts(&self, status: u64) -> bool {
        match self {
            Self::RecallPreset { .. } => status == 0 || status == 1,
            _ => status == 0,
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
            Self::SetModel {
                block,
                wire_id,
                no_snapshot_bypass,
                transaction,
            } => format!(
                "block={block} wire_id={wire_id} no_snapshot_bypass={no_snapshot_bypass} transaction={transaction}"
            ),
            Self::SavePreset {
                setlist,
                slot,
                name,
                transaction,
            } => format!("setlist={setlist} slot={slot} name={name:?} transaction={transaction}"),
            Self::RecallPreset {
                setlist,
                slot,
                transaction,
            } => format!("recall setlist={setlist} slot={slot} transaction={transaction}"),
            Self::SetBypass {
                block,
                enabled,
                transaction,
            } => format!("bypass block={block} enabled={enabled} transaction={transaction}"),
            Self::RemoveEffect {
                block,
                commit,
                transaction,
            } => format!("remove block={block} commit={commit} transaction={transaction}"),
        }
    }
}

/// Handshake, cursor and status handling shared by every write command.
#[derive(Debug)]
struct WriteDriver {
    command: Command,
    stage: Stage,
    /// True once the current command's framed status arrived.
    status_received: bool,
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
            status_received: false,
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
        if let Stage::Done = self.stage {
            return Err("write flow is already finished".to_owned());
        }

        if let Stage::Handshake(index) = self.stage {
            if index + 1 < WRITE_SEQUENCE.len() {
                self.stage = Stage::Handshake(index + 1);
                return Ok(());
            }
            // The object-76 response moves the cursor; the command is then
            // built at that cursor and the status echo moves it further.
            self.cursor = WRITE_OPEN_2_CURSOR.saturating_add(write_cursor_advance(bytes));
            self.seq = WRITE_FIRST_COMMAND_SEQ;
            let frame = self.command.build(self.seq, self.cursor)?;
            self.frame = Some(frame);
            self.status_received = false;
            self.stage = Stage::Command;
            return Ok(());
        }

        let Some(status) = decode_write_status(bytes) else {
            // A bare per-frame ack: the framed status is still to come.
            return Ok(());
        };
        if !self.command.accepts(status.status) {
            let message = match status.code {
                Some(code) => format!(
                    "the pedal rejected the write: status {}, code {}",
                    status.status, code
                ),
                None => format!("the pedal rejected the write: status {}", status.status),
            };
            self.outcome = Some(Err(message.clone()));
            self.stage = Stage::Done;
            return Err(message);
        }

        // The cursor advances by the framed status footprint, not the command
        // footprint: an op-30 echo carries the parameter (23-byte body) while
        // an op-41/op-71 echo is 9 bytes, and the pedal uses the echoed length.
        self.cursor = self.cursor.wrapping_add(write_cursor_advance(bytes));

        self.status_received = true;
        if let Some(next) = self.command.follow_up() {
            self.seq = self.seq.wrapping_add(1);
            let frame = next.build(self.seq, self.cursor)?;
            self.command = next;
            self.frame = Some(frame);
            return Ok(());
        }

        self.outcome = Some(Ok(()));
        self.stage = Stage::Done;
        Ok(())
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

/// One `set_model` command (operation 40), driven packet by packet.
///
/// The command loads a catalog model into one raw chain slot. The pedal builds
/// the block with its own defaults; the page must read the active preset first
/// and keep writes armed. The request layout comes from the MIT reference's
/// annotated capture and is not hardware-validated in this repository.
#[wasm_bindgen]
#[derive(Debug)]
pub struct ModelWriteFlow {
    driver: WriteDriver,
}

#[wasm_bindgen]
impl ModelWriteFlow {
    /// Create a flow that loads `wire_id` into raw chain slot `block`.
    ///
    /// `block` is the raw chain index (input is `0`), like `set_param`.
    /// `no_snapshot_bypass` mirrors the block's existing `l6-helix` flag.
    /// `transaction` is the request id echoed by the device.
    #[wasm_bindgen(constructor)]
    pub fn new(
        block: u32,
        wire_id: u32,
        no_snapshot_bypass: bool,
        transaction: u32,
    ) -> Result<ModelWriteFlow, String> {
        Ok(Self {
            driver: WriteDriver::new(Command::SetModel {
                block,
                wire_id,
                no_snapshot_bypass,
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

/// One recall-preset command (operation 20), driven packet by packet.
///
/// Recalling loads a stored slot into the pedal's edit buffer, exactly like
/// turning its own knob: it is what makes a preset switch audible. The pedal
/// answers status `1` in the captured editor; `0` is accepted too.
#[wasm_bindgen]
#[derive(Debug)]
pub struct RecallFlow {
    driver: WriteDriver,
}

#[wasm_bindgen]
impl RecallFlow {
    /// Create the flow.
    ///
    /// # Errors
    ///
    /// Returns a message when the parameters cannot be encoded.
    #[wasm_bindgen(constructor)]
    pub fn new(setlist: u32, slot: u32, transaction: u32) -> Result<RecallFlow, String> {
        if setlist > 1 {
            return Err("recall setlist must be 0 (Factory) or 1 (User)".to_owned());
        }
        if slot >= 128 {
            return Err("recall slot is above 127".to_owned());
        }
        Ok(Self {
            driver: WriteDriver::new(Command::RecallPreset {
                setlist,
                slot,
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
    /// Returns a message when the flow is already finished or the pedal
    /// rejected the command.
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

/// One bypass command (operation 41), driven packet by packet.
///
/// `block` is the raw chain index; `enabled` is stored in key `59`, where
/// `false` means the effect is bypassed. The pedal echoes the new state as an
/// op-49 notification.
#[wasm_bindgen]
#[derive(Debug)]
pub struct BypassFlow {
    driver: WriteDriver,
}

#[wasm_bindgen]
impl BypassFlow {
    /// Create the flow.
    ///
    /// # Errors
    ///
    /// Returns a message when the parameters cannot be encoded.
    #[wasm_bindgen(constructor)]
    pub fn new(block: u32, enabled: bool, transaction: u32) -> Result<BypassFlow, String> {
        Ok(Self {
            driver: WriteDriver::new(Command::SetBypass {
                block,
                enabled,
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
    /// Returns a message when the flow is already finished or the pedal
    /// rejected the command.
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

/// Remove one effect (operations 28 then 78), driven packet by packet.
///
/// The official editor sends op 28, waits for status `0`, then sends op 78
/// with the same block. The driver builds the second command itself once the
/// first status arrives and advances the cursor from that status frame.
#[wasm_bindgen]
#[derive(Debug)]
pub struct RemoveEffectFlow {
    driver: WriteDriver,
}

#[wasm_bindgen]
impl RemoveEffectFlow {
    /// Create the flow.
    ///
    /// # Errors
    ///
    /// Returns a message when the parameters cannot be encoded.
    #[wasm_bindgen(constructor)]
    pub fn new(block: u32, transaction: u32) -> Result<RemoveEffectFlow, String> {
        Ok(Self {
            driver: WriteDriver::new(Command::RemoveEffect {
                block,
                commit: false,
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

    /// True when the current command already got its status.
    ///
    /// A removal chains operation 78 after operation 28. Without this flag the
    /// page would keep draining the channel after the first status, time out,
    /// and restart the whole flow.
    #[wasm_bindgen]
    #[must_use]
    pub fn status_received(&self) -> bool {
        self.driver.status_received
    }

    /// Consume one response for the last request.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is already finished or the pedal
    /// rejected the command.
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

/// Stage of the op-21 chain upload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChainStage {
    Handshake(usize),
    Stream,
    Done,
}

/// One whole-chain upload (operation 21), streamed packet by packet.
///
/// Reordering processing blocks means uploading the complete chain: the pedal
/// applies the order carried by the `l6-helix` blob. The first frame carries
/// the 8-byte subheader and the complete MessagePack length; continuations
/// carry raw bytes. The pedal answers one framed status `1` while the stream
/// is still being written, which moves the cursor by [`CHAIN_CURSOR_ADVANCE`].
#[wasm_bindgen]
#[derive(Debug)]
pub struct ChainWriteFlow {
    body: Vec<u8>,
    total: usize,
    position: usize,
    seq: u8,
    cursor: u32,
    stage: ChainStage,
    waiting: bool,
    needs_response: bool,
    status_seen: bool,
    outcome: Option<Result<(), String>>,
}

#[wasm_bindgen]
impl ChainWriteFlow {
    /// Create a flow that uploads `blob` (a complete `l6-helix` container) as
    /// operation 21.
    ///
    /// # Errors
    ///
    /// Returns a message when the blob is empty, exceeds 64 KiB or cannot be
    /// wrapped in the MessagePack body.
    #[wasm_bindgen(constructor)]
    pub fn new(blob: &[u8], transaction: u32) -> Result<ChainWriteFlow, String> {
        let body =
            encode_chain_upload(blob, u64::from(transaction)).map_err(|err| err.to_string())?;
        Ok(Self {
            total: body.len(),
            body,
            position: 0,
            seq: WRITE_FIRST_COMMAND_SEQ,
            cursor: WRITE_OPEN_2_CURSOR,
            stage: ChainStage::Handshake(0),
            waiting: false,
            needs_response: false,
            status_seen: false,
            outcome: None,
        })
    }

    /// Replay the handshake from its first packet after a timeout.
    #[wasm_bindgen]
    pub fn restart_handshake(&mut self) {
        if let ChainStage::Handshake(_) = self.stage {
            self.stage = ChainStage::Handshake(0);
            self.waiting = false;
            self.needs_response = false;
        }
    }

    /// Current phase: `handshake`, `stream` or `done`.
    #[wasm_bindgen]
    #[must_use]
    pub fn phase(&self) -> String {
        match self.stage {
            ChainStage::Handshake(_) => "handshake",
            ChainStage::Stream => "stream",
            ChainStage::Done => "done",
        }
        .to_owned()
    }

    /// Timeout the page should apply to the next read.
    #[wasm_bindgen]
    #[must_use]
    pub fn timeout_ms(&self) -> u32 {
        match self.stage {
            ChainStage::Handshake(_) => WRITE_TIMEOUT_MS,
            ChainStage::Stream if self.position >= self.total => CHAIN_STATUS_TIMEOUT_MS,
            _ => WRITE_DRAIN_MS,
        }
    }

    /// Next frame to send, or `undefined` while waiting for the status.
    #[wasm_bindgen]
    #[must_use]
    pub fn next_request(&mut self) -> Option<Vec<u8>> {
        if self.outcome.is_some() || self.stage == ChainStage::Done {
            return None;
        }
        match self.stage {
            ChainStage::Handshake(index) => {
                let packet = WRITE_SEQUENCE.get(index)?.to_vec();
                self.waiting = true;
                self.needs_response = true;
                Some(packet)
            }
            ChainStage::Stream => {
                if self.position >= self.total {
                    // Every frame is out. Once the status was seen the flow is
                    // over; until then only the status is still missing.
                    self.needs_response = !self.status_seen;
                    return None;
                }
                let first = self.position == 0;
                let chunk = if first {
                    CHAIN_FIRST_BYTES.min(self.total - self.position)
                } else {
                    CHAIN_CHUNK_BYTES.min(self.total - self.position)
                };
                let frame = build_chain_frame(
                    &self.body[self.position..self.position + chunk],
                    u32::try_from(self.total).unwrap_or(u32::MAX),
                    first,
                    self.seq,
                    self.cursor,
                );
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(err) => {
                        self.fail(err.to_string());
                        return None;
                    }
                };
                self.position += chunk;
                self.seq = self.seq.wrapping_add(1);
                self.waiting = true;
                self.maybe_finish();
                if self.stage == ChainStage::Done {
                    return None;
                }
                // Every frame is acknowledged, so a read follows each one until
                // the pedal sends the framed status.
                self.needs_response = !self.status_seen;
                Some(frame)
            }
            ChainStage::Done => None,
        }
    }

    /// True when the page must read a response before sending the next frame.
    #[wasm_bindgen]
    #[must_use]
    pub fn expects_response(&self) -> bool {
        self.needs_response
    }

    /// Consume one write-channel response.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is already finished or the pedal
    /// rejected the upload.
    #[wasm_bindgen]
    pub fn accept_response(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("chain flow is already finished".to_owned());
        }
        self.waiting = false;
        self.needs_response = false;
        match self.stage {
            ChainStage::Handshake(index) => {
                if index + 1 >= WRITE_SEQUENCE.len() {
                    self.cursor = WRITE_OPEN_2_CURSOR.saturating_add(write_cursor_advance(bytes));
                    self.seq = WRITE_FIRST_COMMAND_SEQ;
                    self.stage = ChainStage::Stream;
                } else {
                    self.stage = ChainStage::Handshake(index + 1);
                }
                Ok(())
            }
            ChainStage::Stream => {
                let Some(status) = decode_write_status(bytes) else {
                    // Bare per-frame acknowledgement: the stream continues.
                    return Ok(());
                };
                if status.status != 0 && status.status != 1 {
                    let message = format!(
                        "the pedal rejected the chain upload: status {}",
                        status.status
                    );
                    self.fail(message.clone());
                    return Err(message);
                }
                self.status_seen = true;
                self.waiting = false;
                self.cursor = self.cursor.wrapping_add(CHAIN_CURSOR_ADVANCE);
                self.maybe_finish();
                Ok(())
            }
            ChainStage::Done => Err("chain flow is already finished".to_owned()),
        }
    }

    /// Signal that the pending read timed out.
    ///
    /// # Errors
    ///
    /// A silent handshake, or a stream that ended without a status, aborts the
    /// flow with a message.
    #[wasm_bindgen]
    pub fn accept_timeout(&mut self) -> Result<(), String> {
        if !self.needs_response && !self.waiting {
            return Ok(());
        }
        self.waiting = false;
        self.needs_response = false;
        if self.status_seen {
            return Ok(());
        }
        let message = match self.stage {
            ChainStage::Handshake(_) => "the pedal did not answer the write handshake".to_owned(),
            _ => "the pedal did not acknowledge the chain upload".to_owned(),
        };
        self.fail(message.clone());
        Err(message)
    }

    /// True when every frame was sent and the pedal accepted the upload.
    #[wasm_bindgen]
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.outcome.is_some() || self.stage == ChainStage::Done
    }

    /// JSON result: `{"ok":true}` or `{"ok":false,"message":"…"}`.
    #[wasm_bindgen]
    #[must_use]
    pub fn result_json(&self) -> Option<String> {
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

    /// Configuration used for diagnostics.
    #[wasm_bindgen]
    #[must_use]
    pub fn describe(&self) -> String {
        format!(
            "chain bytes={}/{} seq={} cursor={:#06x}",
            self.position, self.total, self.seq, self.cursor
        )
    }

    /// Finish once every frame was sent and the pedal accepted the upload.
    fn maybe_finish(&mut self) {
        if self.stage == ChainStage::Stream && self.position >= self.total && self.status_seen {
            self.stage = ChainStage::Done;
            self.outcome = Some(Ok(()));
        }
    }

    fn fail(&mut self, message: String) {
        self.stage = ChainStage::Done;
        self.needs_response = false;
        self.waiting = false;
        self.outcome = Some(Err(message));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use podgo_domain::msgpack::{self, Value};

    fn framed_status(response: u32, status: u64, code: Option<u64>) -> Vec<u8> {
        let mut entries = vec![
            (Value::uint(102), Value::uint(u64::from(response))),
            (Value::uint(103), Value::uint(status)),
            (Value::uint(104), Value::Nil),
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

    fn drive_model(flow: &mut ModelWriteFlow) {
        drive_handshake(&mut flow.driver);
    }

    fn drive_save(flow: &mut SavePresetFlow) {
        drive_handshake(&mut flow.driver);
    }

    fn remove_status_frame(transaction: u16) -> Vec<u8> {
        // Status echo as the pedal sends it for a short command: 9-byte body.
        let body = msgpack::encode(&Value::map(vec![
            (Value::uint(102), Value::uint(u64::from(transaction))),
            (Value::uint(103), Value::uint(0)),
            (Value::uint(104), Value::Nil),
        ]))
        .unwrap();
        let mut frame = vec![0u8; 16];
        frame.extend_from_slice(&[0x00, 0x00, 0x06, 0x00]);
        frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
        frame.extend_from_slice(&[0x00, 0x00]);
        frame.extend_from_slice(&body);
        frame
    }

    #[test]
    fn recall_accepts_status_one() {
        let mut flow = RecallFlow::new(1, 36, 1006).unwrap();
        drive_handshake(&mut flow.driver);
        let command = flow.next_request().unwrap();
        let parsed = podgo_protocol::frame::Frame::parse(&command).unwrap();
        let body = podgo_protocol::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(20));
        let inner = value.get_u64(101).unwrap();
        assert_eq!(inner.get_u64(107).unwrap().as_u64(), Some(1));
        assert_eq!(inner.get_u64(108).unwrap().as_u64(), Some(36));

        flow.accept_response(&framed_status(1006, 1, None)).unwrap();
        assert!(flow.is_finished());
        assert_eq!(flow.result_json().as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn recall_rejects_an_unknown_setlist() {
        assert!(RecallFlow::new(2, 0, 1).is_err());
    }

    #[test]
    fn bypass_command_carries_the_raw_block_and_enabled_flag() {
        let mut flow = BypassFlow::new(3, false, 1010).unwrap();
        drive_handshake(&mut flow.driver);
        let command = flow.next_request().unwrap();
        let parsed = podgo_protocol::frame::Frame::parse(&command).unwrap();
        let body = podgo_protocol::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(41));
        let inner = value.get_u64(101).unwrap();
        assert_eq!(inner.get_u64(98).unwrap().as_u64(), Some(3));
        assert_eq!(inner.get_u64(59).unwrap().as_bool(), Some(false));

        flow.accept_response(&framed_status(1010, 0, None)).unwrap();
        assert!(flow.is_finished());
    }

    #[test]
    fn remove_sends_op_78_after_op_28_with_the_status_advance() {
        let mut flow = RemoveEffectFlow::new(3, 1014).unwrap();
        drive_handshake(&mut flow.driver);

        let first = flow.next_request().unwrap();
        let first_parsed = podgo_protocol::frame::Frame::parse(&first).unwrap();
        let first_cursor = u32::from_le_bytes(first_parsed.header()[12..16].try_into().unwrap());
        let first_body = podgo_protocol::open::payload(&first_parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(first_body).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(28));
        assert_eq!(first_parsed.header()[9], WRITE_FIRST_COMMAND_SEQ);
        assert!(!flow.status_received());

        let status = remove_status_frame(1014);
        flow.accept_response(&status).unwrap();
        // The first status arms the follow-up instead of finishing.
        assert!(flow.status_received());
        assert!(!flow.is_finished());

        let second = flow.next_request().unwrap();
        let second_parsed = podgo_protocol::frame::Frame::parse(&second).unwrap();
        assert_eq!(
            u32::from_le_bytes(second_parsed.header()[12..16].try_into().unwrap()),
            first_cursor + 17
        );
        assert_eq!(second_parsed.header()[9], WRITE_FIRST_COMMAND_SEQ + 1);
        let second_body = podgo_protocol::open::payload(&second_parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(second_body).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(78));

        flow.accept_response(&remove_status_frame(1015)).unwrap();
        assert!(flow.is_finished());
        assert_eq!(flow.result_json().as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn chain_flow_streams_every_frame_and_needs_the_status() {
        let blob = vec![0x5au8; 1200];
        let mut flow = ChainWriteFlow::new(&blob, 7).unwrap();
        for _ in 0..4 {
            assert!(flow.next_request().is_some());
            flow.accept_response(&open2_response()).unwrap();
        }
        assert_eq!(flow.phase(), "stream");

        let mut frames = Vec::new();
        let mut cursors = Vec::new();
        while !flow.is_finished() {
            if let Some(frame) = flow.next_request() {
                let parsed = podgo_protocol::frame::Frame::parse(&frame).unwrap();
                cursors.push(u32::from_le_bytes(
                    parsed.header()[12..16].try_into().unwrap(),
                ));
                frames.push(frame);
                if flow.expects_response() {
                    // The pedal acknowledges every frame; the accept status
                    // arrives with one of them while the stream is running.
                    let response: Vec<u8> = if frames.len() == 2 {
                        framed_status(7, 1, None)
                    } else {
                        vec![0u8; 16]
                    };
                    flow.accept_response(&response).unwrap();
                }
                continue;
            }
            if flow.expects_response() {
                // The status arrives last, after every frame.
                flow.accept_response(&framed_status(7, 1, None)).unwrap();
            }
        }

        assert_eq!(flow.result_json().as_deref(), Some("{\"ok\":true}"));
        // Two frames cancelled the scenario: the status arrives with the
        // second one, so the flow can finish as soon as the stream ends.
        assert_eq!(frames.len(), 2);
        assert_eq!(cursors[0], WRITE_OPEN_2_CURSOR + 17);
        assert_eq!(cursors[1], WRITE_OPEN_2_CURSOR + 17);
    }

    #[test]
    fn chain_flow_rejects_a_missing_status() {
        let mut flow = ChainWriteFlow::new(&[1u8; 600], 7).unwrap();
        for _ in 0..4 {
            assert!(flow.next_request().is_some());
            flow.accept_response(&open2_response()).unwrap();
        }
        let mut sent = 0;
        while flow.next_request().is_some() {
            sent += 1;
        }
        assert!(sent > 0);
        assert!(flow.expects_response());
        assert!(flow.accept_timeout().is_err());
        assert!(flow.is_finished());
        assert!(flow.result_json().unwrap().contains("did not acknowledge"));
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
        // The command is built at the cursor the handshake left behind; the
        // cursor only moves once the framed status arrives.
        assert_eq!(
            &flow.describe(),
            &format!(
                "block=6 param=3 value=0.5000 transaction=1001 seq=5 cursor={:#06x}",
                expected_cursor
            )
        );

        flow.accept_response(&framed_status(1001, 0, None)).unwrap();
        assert!(flow.is_finished());
        assert_eq!(
            &flow.describe(),
            &format!(
                "block=6 param=3 value=0.5000 transaction=1001 seq=5 cursor={:#06x}",
                expected_cursor + 17
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
        // A rejected status is returned as an error, and the flow records it
        // so `result_json` can report the pedal's code.
        assert!(flow
            .accept_response(&framed_status(43, 255, Some(7)))
            .is_err());
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
    fn model_command_carries_the_raw_block_and_nested_model_node() {
        let mut flow = ModelWriteFlow::new(5, 433, false, 1013).unwrap();
        drive_model(&mut flow);
        assert_eq!(flow.phase(), "command");

        let command = flow.next_request().unwrap();
        let parsed = podgo_protocol::frame::Frame::parse(&command).unwrap();
        let body = podgo_protocol::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(40));
        let inner = value.get_u64(101).unwrap();
        assert_eq!(inner.get_u64(98).unwrap().as_u64(), Some(5));
        let model = inner.get_u64(100).unwrap();
        assert_eq!(model.get_u64(23).unwrap().as_bool(), Some(false));
        assert_eq!(model.get_u64(25).unwrap().as_u64(), Some(433));
        assert_eq!(model.get_u64(26).unwrap().as_i64(), Some(-1));
        assert!(flow.describe().contains("wire_id=433"));
    }

    #[test]
    fn model_reports_a_rejected_status() {
        let mut flow = ModelWriteFlow::new(5, 433, false, 42).unwrap();
        drive_model(&mut flow);
        assert!(flow
            .accept_response(&framed_status(42, 255, Some(7)))
            .is_err());
        assert!(flow.is_finished());
        let result = flow.result_json().unwrap();
        assert!(result.contains("\"ok\":false"), "{result}");
        assert!(result.contains("status 255"), "{result}");
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
        assert!(flow.accept_response(&framed_status(1016, 5, None)).is_err());
        assert!(flow.is_finished());
        let result = flow.result_json().unwrap();
        assert!(result.contains("\"ok\":false"), "{result}");
        assert!(result.contains("status 5"), "{result}");
    }
}
