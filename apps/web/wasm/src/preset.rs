//! Read-only preset orchestration for the browser.
//!
//! Mirrors the object-read flow that the official editor uses and that the MIT
//! reference implements (`read_object`): five handshake packets,
//! `OPEN_PRESETS`, an open request for the object, then absolute-offset chunk
//! requests. The reassembled buffer is the complete `{102, 103, 104}` message.
//!
//! Two objects are read in sequence, each with its own handshake:
//!
//! 1. object 23 (`OBJECT_ACTIVE_STATE`): `{107: setlist, 108: slot, 109: name}`;
//! 2. object 22 (`OBJECT_ACTIVE_PRESET`): the `l6-helix` preset blob.
//!
//! A slot read (`PresetFlow::for_slot`) skips object 23 and sends the target
//! `{107: setlist, 108: slot, 101: 2}` parameters, as the official editor does
//! during a backup. The setlist supplies the name in that case.
//!
//! `PresetFlow::for_active_body` is the fallback when the pedal ignores
//! object 23: it reads object 22 with the same `{107: 0, 101: 2}` request the
//! two-object flow uses, and leaves the setlist/slot unknown.
//!
//! Only the read channel (`0x1001 → 0x03EF`) is used. Nothing here can write
//! to the device.

use podgo_domain::l6helix::{ChainEntry, Preset};
use podgo_domain::msgpack::{self, Value};
use podgo_protocol::constants::{
    CHUNK_FIRST_SEQ, CHUNK_OFFSET_STEP, FIRST_APP_SEQ, FIRST_DATA_HEADER_LEN, MAX_CHUNKS,
    MAX_STREAM_BYTES, OBJECT_ACTIVE_PRESET, OBJECT_ACTIVE_STATE, OP_TIMEOUT_MS, STREAM_BASE_OFFSET,
};
use podgo_protocol::constants::{READ_DST, READ_SRC};
use podgo_protocol::frame::{Frame, HEADER_LEN};
use podgo_protocol::handshake::{build_chunk_request, OPEN_PRESETS, READ_SEQUENCE};
use podgo_protocol::open::{encode_open, OpenRequest};
use wasm_bindgen::prelude::*;

use crate::HANDSHAKE_TIMEOUT_MS;

/// Transaction id used by the reference implementation for object reads.
const OBJECT_TRANSACTION: u64 = 1002;
/// Sequence number of the object-open request in the captured flow.
const OBJECT_OPEN_SEQ: u8 = 0x07;
/// Cursor carried by the object-open request in the captured flow.
///
/// Observed value from `OPEN_STREAM`; its meaning for object reads is not
/// established, so it is reproduced verbatim rather than computed.
const OBJECT_OPEN_CURSOR: u32 = 0x1038;

/// Objects read by this flow, in order.
const OBJECTS: [u16; 2] = [OBJECT_ACTIVE_STATE, OBJECT_ACTIVE_PRESET];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Handshake,
    OpenPresets,
    OpenObject,
    Chunks,
    Done,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Handshake => "handshake",
            Self::OpenPresets => "open-presets",
            Self::OpenObject => "open-object",
            Self::Chunks => "chunks",
            Self::Done => "done",
        }
    }
}

/// Active setlist/slot/name (object 23).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ActiveState {
    setlist: Option<u64>,
    slot: Option<u64>,
    name: String,
}

/// One read-only preset read, driven packet by packet.
///
/// Usage from JavaScript:
///
/// ```text
/// flow = new PresetFlow()
/// while not flow.is_finished():
///     request = flow.next_request()
///     response = await device.request(request, flow.timeout_ms())
///     flow.accept_response(response)
/// structure = flow.structure_json()
/// ```
#[wasm_bindgen]
pub struct PresetFlow {
    phase: Phase,
    handshake_index: usize,
    /// Index into the object list of the object currently being read.
    object_index: usize,
    /// `Some((setlist, slot))` for a slot read, `None` for the active preset.
    target: Option<(u8, u8)>,
    /// Read object 22 alone, without the object-23 active state.
    body_only: bool,
    seq: u8,
    offset: u32,
    head_len: usize,
    buffer: Vec<u8>,
    state_message: Option<Vec<u8>>,
    preset_message: Option<Vec<u8>>,
    chunks: usize,
    finished: bool,
    truncated: bool,
}

impl Default for PresetFlow {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl PresetFlow {
    /// Create a flow that reads the active state and the active preset.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::with_target(None)
    }

    /// Create a flow that reads one Factory (`0`) or User (`1`) slot.
    ///
    /// Only object 22 is read, with `{107: setlist, 108: slot, 101: 2}`;
    /// the setlist provides the preset name.
    #[wasm_bindgen]
    #[must_use]
    pub fn for_slot(setlist: u8, slot: u8) -> Self {
        Self::with_target(Some((setlist, slot)))
    }

    /// Create a flow that reads only the active preset body (object 22).
    ///
    /// This is the fallback when the pedal does not answer object 23: the
    /// object-22 open request is exactly the one the two-object flow sends
    /// (`{107: 0, 101: 2}`), so no slot has to be guessed. The setlist/name
    /// then stay unknown unless the page supplies a name.
    #[wasm_bindgen]
    #[must_use]
    pub fn for_active_body() -> Self {
        let mut flow = Self::with_target(None);
        flow.body_only = true;
        flow
    }

    fn with_target(target: Option<(u8, u8)>) -> Self {
        Self {
            phase: Phase::Handshake,
            handshake_index: 0,
            object_index: 0,
            target,
            body_only: false,
            seq: FIRST_APP_SEQ,
            offset: STREAM_BASE_OFFSET,
            head_len: 0,
            buffer: Vec::new(),
            state_message: None,
            preset_message: None,
            chunks: 0,
            finished: false,
            truncated: false,
        }
    }

    /// Objects read by this flow, in order.
    fn objects(&self) -> &'static [u16] {
        if self.target.is_some() || self.body_only {
            &[OBJECT_ACTIVE_PRESET]
        } else {
            &OBJECTS
        }
    }

    /// Restart the five-packet handshake after a timeout.
    ///
    /// The pedal routinely ignores the first handshake after finishing an
    /// object. Resetting the index lets the driver resend the sequence without
    /// discarding the objects already read (notably object 23's active state).
    #[wasm_bindgen]
    pub fn restart_handshake(&mut self) {
        if self.phase == Phase::Handshake {
            self.handshake_index = 0;
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
            Phase::OpenObject => build_object_open(self.object(), self.target).ok(),
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
    /// phase, exceeds the stream limit, or the flow already finished.
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
                self.phase = Phase::OpenObject;
                self.seq = self.seq.wrapping_add(1);
                Ok(())
            }
            Phase::OpenObject => {
                let head_start = FIRST_DATA_HEADER_LEN - HEADER_LEN;
                let head = frame.body().get(head_start..).unwrap_or_default();
                if head.len() > MAX_STREAM_BYTES {
                    return Err(format!(
                        "open response carried {} B, above the {} B limit",
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
                    self.finish_object();
                    return Ok(());
                }

                let relative = usize::try_from(self.offset.saturating_sub(STREAM_BASE_OFFSET))
                    .unwrap_or(usize::MAX);
                let start = self.head_len.saturating_add(relative);
                let end = start.saturating_add(payload.len());
                if end > MAX_STREAM_BYTES {
                    return Err(format!(
                        "object exceeded the {} B limit at {} B",
                        MAX_STREAM_BYTES, end
                    ));
                }
                if end > self.buffer.len() {
                    self.buffer.resize(end, 0);
                }
                self.buffer[start..end].copy_from_slice(payload);
                self.chunks += 1;

                if self.chunks >= MAX_CHUNKS {
                    self.truncated = true;
                    self.finish_object();
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

    /// Human-readable phase name (`handshake`, `open-object`, …).
    #[wasm_bindgen]
    #[must_use]
    pub fn phase(&self) -> String {
        self.phase.as_str().to_owned()
    }

    /// Object currently being read (`23` then `22`, or `22` for a slot read).
    #[wasm_bindgen]
    #[must_use]
    pub fn object(&self) -> u16 {
        self.objects()
            .get(self.object_index)
            .copied()
            .unwrap_or(OBJECT_ACTIVE_PRESET)
    }

    /// Number of chunk responses consumed for the current object.
    #[wasm_bindgen]
    #[must_use]
    pub fn chunks(&self) -> usize {
        self.chunks
    }

    /// Whether a chunk cap was reached before the device ended an object.
    #[wasm_bindgen]
    #[must_use]
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Reassembled object-22 message `{102, 103, 104}`, for a local dump.
    #[wasm_bindgen]
    #[must_use]
    pub fn raw(&self) -> Vec<u8> {
        self.preset_message.clone().unwrap_or_default()
    }

    /// Extract the `l6-helix` blob (key 104 of object 22).
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is not finished, the message does not
    /// decode, the device status is not zero, or key 104 is not a blob.
    #[wasm_bindgen]
    pub fn blob(&self) -> Result<Vec<u8>, String> {
        self.finished_blob()
    }

    /// Structured view of the preset for the UI, as JSON.
    ///
    /// The model catalog lives on the JavaScript side: this returns on-wire
    /// ids, category numbers, positional parameter values and switch
    /// assignments, and the page resolves names and display values.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is not finished or the blob is invalid.
    #[wasm_bindgen]
    pub fn structure_json(&self) -> Result<String, String> {
        self.structure_json_named("")
    }

    /// Structured view with an explicit preset name.
    ///
    /// Slot reads have no object 23, so the page passes the name from the
    /// setlist entry. An empty name keeps the object-23 value.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is not finished or the blob is invalid.
    #[wasm_bindgen]
    pub fn structure_json_named(&self, name: &str) -> Result<String, String> {
        let blob = self.finished_blob()?;
        let preset = podgo_domain::l6helix::Container::parse_preset(&blob)
            .map_err(|err| format!("preset: {err}"))?;
        let mut state = self.active_state();
        if !name.is_empty() {
            state.name = name.to_owned();
        }
        Ok(render_structure(&preset, &state))
    }

    /// Same text report as `podgo-probe` on the active preset.
    ///
    /// # Errors
    ///
    /// Returns a message when the flow is not finished or the blob is invalid.
    #[wasm_bindgen]
    pub fn report(&self) -> Result<String, String> {
        let blob = self.finished_blob()?;
        podgo_cli::inspect(&blob)
            .map(|report| podgo_cli::render(&report))
            .map_err(|err| err.to_string())
    }

    fn finished_blob(&self) -> Result<Vec<u8>, String> {
        if !self.finished {
            return Err(format!(
                "preset is not finished (phase: {})",
                self.phase.as_str()
            ));
        }
        extract_blob(self.preset_message.as_deref().unwrap_or_default())
    }

    fn active_state(&self) -> ActiveState {
        if let Some((setlist, slot)) = self.target {
            return ActiveState {
                setlist: Some(u64::from(setlist)),
                slot: Some(u64::from(slot)),
                name: String::new(),
            };
        }
        self.state_message
            .as_deref()
            .and_then(parse_active_state)
            .unwrap_or_default()
    }

    /// Store the reassembled object and either start the next read or finish.
    fn finish_object(&mut self) {
        let done = self.buffer.clone();
        if self.object() == OBJECT_ACTIVE_STATE {
            self.state_message = Some(done);
            self.object_index += 1;
            self.phase = Phase::Handshake;
            self.handshake_index = 0;
            self.seq = FIRST_APP_SEQ;
            self.head_len = 0;
            self.offset = STREAM_BASE_OFFSET;
            self.buffer.clear();
            self.chunks = 0;
        } else {
            self.preset_message = Some(done);
            self.phase = Phase::Done;
            self.finished = true;
        }
    }
}

/// Structured view of a raw `l6-helix` blob, for the offline preview.
///
/// # Errors
///
/// Returns a message when the blob is not a valid `l6-helix` container.
#[wasm_bindgen]
pub fn preset_structure(bytes: &[u8]) -> Result<String, String> {
    let preset = podgo_domain::l6helix::Container::parse_preset(bytes)
        .map_err(|err| format!("preset: {err}"))?;
    Ok(render_structure(&preset, &ActiveState::default()))
}

/// Build the open request for `object`.
/// Build the open request for `object`, optionally targeting a slot.
fn build_object_open(
    object: u16,
    target: Option<(u8, u8)>,
) -> Result<Vec<u8>, podgo_protocol::ProtocolError> {
    let mut params = Vec::with_capacity(3);
    params.push((
        Value::uint(107),
        Value::uint(u64::from(target.map_or(0, |(setlist, _)| setlist))),
    ));
    if let Some((_, slot)) = target {
        params.push((Value::uint(108), Value::uint(u64::from(slot))));
    }
    params.push((Value::uint(101), Value::uint(2)));
    let request = OpenRequest {
        transaction: OBJECT_TRANSACTION,
        operation: u64::from(object),
        params: Value::map(params),
    };
    encode_open(
        &request,
        READ_SRC,
        READ_DST,
        OBJECT_OPEN_SEQ,
        OBJECT_OPEN_CURSOR,
    )
}

/// Decode the object-23 message into setlist/slot/name.
///
/// The device may pad the assembled object, so only the first MessagePack
/// value is decoded; trailing padding is ignored.
fn parse_active_state(buffer: &[u8]) -> Option<ActiveState> {
    let (message, _) = msgpack::decode_prefix(buffer).ok()?;
    let status = message
        .get_u64(podgo_protocol::constants::KEY_STATUS)
        .and_then(Value::as_u64)?;
    if status != 0 {
        return None;
    }
    let result = message.get_u64(podgo_protocol::constants::KEY_RESULT)?;
    Some(ActiveState {
        setlist: result.get_u64(107).and_then(Value::as_u64),
        slot: result.get_u64(108).and_then(Value::as_u64),
        name: result
            .get_u64(109)
            .and_then(Value::as_str)
            .map(|name| name.split('\0').next().unwrap_or_default().to_owned())
            .unwrap_or_default(),
    })
}

/// Extract the `l6-helix` blob from a reassembled `{102, 103, 104}` message.
///
/// The object stream may end with padding bytes after the MessagePack map (the
/// final chunk is sent at full size). Only the first value is decoded and the
/// rest is ignored; key 104 carries its own length, so the blob stays exact.
///
/// # Errors
///
/// Returns a message when the buffer does not decode, the status is not zero,
/// or key 104 is missing or not binary.
pub fn extract_blob(buffer: &[u8]) -> Result<Vec<u8>, String> {
    let (message, _) = msgpack::decode_prefix(buffer).map_err(|err| format!("message: {err}"))?;
    let status = message
        .get_u64(podgo_protocol::constants::KEY_STATUS)
        .and_then(Value::as_u64)
        .ok_or_else(|| "message has no status (key 103)".to_owned())?;
    if status != 0 {
        let code = message
            .get_u64(podgo_protocol::constants::KEY_RESULT)
            .and_then(|result| result.get_u64(podgo_protocol::constants::KEY_ERROR_CODE))
            .and_then(Value::as_u64);
        return Err(match code {
            Some(code) => format!("device rejected the read: status {status}, code {code}"),
            None => format!("device rejected the read: status {status}"),
        });
    }
    match message.get_u64(podgo_protocol::constants::KEY_RESULT) {
        Some(Value::Bin { value, .. }) => Ok(value.clone()),
        Some(Value::Str { value, .. }) => Ok(value.clone()),
        Some(other) => Err(format!(
            "result (key 104) is not a blob: {}",
            type_name(other)
        )),
        None => Err("message has no result (key 104)".to_owned()),
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Nil => "nil",
        Value::Bool(_) => "bool",
        Value::UInt { .. } | Value::Int { .. } => "integer",
        Value::F32(_) | Value::F64(_) => "float",
        Value::Str { .. } => "string",
        Value::Bin { .. } => "binary",
        Value::Array { .. } => "array",
        Value::Map { .. } => "map",
        Value::Ext { .. } => "extension",
    }
}

// --- JSON rendering -------------------------------------------------------

/// Render the structured preset view consumed by the page.
pub(crate) fn render_structure(preset: &Preset, state: &ActiveState) -> String {
    let mut out = String::with_capacity(4096);
    out.push('{');

    out.push_str("\"preset\":{");
    out.push_str("\"name\":");
    push_json_string(&mut out, &state.name);
    out.push_str(",\"setlist\":");
    push_json_opt_u64(&mut out, state.setlist);
    out.push_str(",\"slot\":");
    push_json_opt_u64(&mut out, state.slot);
    out.push('}');

    out.push_str(",\"product\":");
    push_json_string(&mut out, &preset.product);
    out.push_str(",\"firmware\":");
    push_json_string(&mut out, &preset.firmware);
    out.push_str(",\"tempo\":");
    push_json_f64(&mut out, preset.tempo);
    out.push_str(",\"currentSnapshot\":");
    push_json_opt_u64(&mut out, preset.current_snapshot);

    out.push_str(",\"snapshots\":[");
    for (index, snapshot) in preset.snapshots.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"name\":");
        push_json_string(&mut out, &snapshot.name);
        out.push_str(",\"valid\":");
        out.push_str(if snapshot.valid { "true" } else { "false" });
        out.push_str(",\"tempo\":");
        push_json_f64(&mut out, snapshot.tempo);
        out.push('}');
    }
    out.push(']');

    out.push_str(",\"chain\":[");
    for (index, entry) in preset.chain.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        render_chain_entry(&mut out, index, entry);
    }
    out.push(']');

    out.push_str(",\"footswitches\":[");
    for (index, fs) in preset.footswitches.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"group\":");
        out.push_str(&fs.group.to_string());
        out.push_str(",\"switch\":");
        push_json_string(&mut out, &fs.switch_name());
        out.push_str(",\"block\":");
        out.push_str(&fs.block.to_string());
        out.push_str(",\"label\":");
        push_json_string(&mut out, &fs.label);
        out.push_str(",\"enabled\":");
        out.push_str(if fs.enabled { "true" } else { "false" });
        out.push('}');
    }
    out.push(']');

    out.push_str(",\"controllers\":[");
    for (index, ctl) in preset.controllers.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"controller\":");
        out.push_str(&ctl.controller.to_string());
        out.push_str(",\"paramIndex\":");
        out.push_str(&ctl.param_index.to_string());
        out.push_str(",\"min\":");
        push_json_f64(&mut out, Some(ctl.min));
        out.push_str(",\"max\":");
        push_json_f64(&mut out, Some(ctl.max));
        out.push('}');
    }
    out.push(']');

    out.push('}');
    out
}

fn render_chain_entry(out: &mut String, slot: usize, entry: &ChainEntry) {
    out.push_str("{\"slot\":");
    out.push_str(&slot.to_string());
    match entry {
        ChainEntry::Input { params } => {
            out.push_str(",\"kind\":\"input\",\"params\":");
            push_json_values(out, params);
        }
        ChainEntry::Output { params } => {
            out.push_str(",\"kind\":\"output\",\"params\":");
            push_json_values(out, params);
        }
        ChainEntry::Block(block) => {
            out.push_str(",\"kind\":\"block\",\"modelId\":");
            out.push_str(&block.model_id.to_string());
            out.push_str(",\"category\":");
            push_json_opt_u64(out, block.category);
            out.push_str(",\"enabled\":");
            out.push_str(if block.enabled { "true" } else { "false" });
            out.push_str(",\"noSnapshotBypass\":");
            out.push_str(if block.no_snapshot_bypass {
                "true"
            } else {
                "false"
            });
            out.push_str(",\"params\":");
            push_json_values(out, &block.params);
        }
        ChainEntry::Looper {
            model_id,
            enabled,
            params,
        } => {
            out.push_str(",\"kind\":\"looper\",\"modelId\":");
            push_json_opt_u32(out, *model_id);
            out.push_str(",\"enabled\":");
            out.push_str(if *enabled { "true" } else { "false" });
            out.push_str(",\"params\":");
            push_json_values(out, params);
        }
        ChainEntry::Empty => out.push_str(",\"kind\":\"empty\""),
        ChainEntry::Unknown { class } => {
            out.push_str(",\"kind\":\"unknown\",\"class\":");
            out.push_str(&class.to_string());
        }
    }
    out.push('}');
}

fn push_json_values(out: &mut String, values: &[Value]) {
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json_value(out, value);
    }
    out.push(']');
}

fn push_json_value(out: &mut String, value: &Value) {
    match value {
        Value::Nil => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::UInt { value, .. } => out.push_str(&value.to_string()),
        Value::Int { value, .. } => out.push_str(&value.to_string()),
        Value::F32(value) => push_json_f64(out, Some(f64::from(*value))),
        Value::F64(value) => push_json_f64(out, Some(*value)),
        Value::Str { value, .. } => {
            let text = String::from_utf8_lossy(value);
            push_json_string(out, text.split('\0').next().unwrap_or_default());
        }
        Value::Bin { value, .. } => {
            out.push_str("{\"bytes\":");
            out.push_str(&value.len().to_string());
            out.push('}');
        }
        Value::Array { items, .. } => push_json_values(out, items),
        Value::Map { entries, .. } => {
            out.push_str("{\"entries\":");
            out.push_str(&entries.len().to_string());
            out.push('}');
        }
        Value::Ext { type_id, data } => {
            out.push_str("{\"ext\":");
            out.push_str(&type_id.to_string());
            out.push_str(",\"bytes\":");
            out.push_str(&data.len().to_string());
            out.push('}');
        }
    }
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

fn push_json_opt_u64(out: &mut String, value: Option<u64>) {
    match value {
        Some(value) => out.push_str(&value.to_string()),
        None => out.push_str("null"),
    }
}

fn push_json_opt_u32(out: &mut String, value: Option<u32>) {
    match value {
        Some(value) => out.push_str(&value.to_string()),
        None => out.push_str("null"),
    }
}

fn push_json_f64(out: &mut String, value: Option<f64>) {
    match value {
        Some(value) if value.is_finite() => {
            if value.fract() == 0.0 && value.abs() < 1e15 {
                out.push_str(&format!("{value:.1}"));
            } else {
                out.push_str(&value.to_string());
            }
        }
        _ => out.push_str("null"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRESET: &[u8] = include_bytes!("../../../../fixtures/spec02_obj22_blob.bin");

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

    /// Wrap the preset blob in the `{102, 103, 104}` message the device sends.
    fn object_message(blob: &[u8]) -> Vec<u8> {
        let message = Value::map(vec![
            (Value::uint(102), Value::uint(OBJECT_TRANSACTION)),
            (Value::uint(103), Value::uint(0)),
            (
                Value::uint(104),
                Value::Bin {
                    value: blob.to_vec(),
                    width: 3,
                },
            ),
        ]);
        msgpack::encode(&message).unwrap()
    }

    /// Wrap the object-23 payload in a `{102, 103, 104}` message.
    fn state_message(setlist: u64, slot: u64, name: &str) -> Vec<u8> {
        let message = Value::map(vec![
            (Value::uint(102), Value::uint(OBJECT_TRANSACTION)),
            (Value::uint(103), Value::uint(0)),
            (
                Value::uint(104),
                Value::map(vec![
                    (Value::uint(107), Value::uint(setlist)),
                    (Value::uint(108), Value::uint(slot)),
                    (Value::uint(109), Value::str(format!("{name}\0"))),
                ]),
            ),
        ]);
        msgpack::encode(&message).unwrap()
    }

    /// Drive one object read, with `messages` supplying the stream contents.
    fn read_object(flow: &mut PresetFlow, message: &[u8], head: &[u8], payload_len: usize) {
        for _ in 0..READ_SEQUENCE.len() {
            let request = flow.next_request().unwrap();
            flow.accept_response(&response(&request, &[])).unwrap();
        }

        let request = flow.next_request().unwrap();
        assert_eq!(request, OPEN_PRESETS);
        flow.accept_response(&ack()).unwrap();

        let request = flow.next_request().unwrap();
        assert_eq!(
            request,
            build_object_open(flow.object(), flow.target).unwrap()
        );
        let mut open_body = vec![0u8; FIRST_DATA_HEADER_LEN - HEADER_LEN];
        open_body.extend_from_slice(head);
        flow.accept_response(&response(&request, &open_body))
            .unwrap();

        let mut guard = 0;
        while flow.phase() == "chunks" {
            let request = flow.next_request().unwrap();
            let cursor =
                u32::from_le_bytes([request[12], request[13], request[14], request[15]]) as usize;
            let relative = cursor - STREAM_BASE_OFFSET as usize;
            let start = head.len() + relative;
            let payload = if start >= message.len() {
                &[][..]
            } else {
                let end = (start + payload_len).min(message.len());
                &message[start..end]
            };
            flow.accept_response(&response(&request, payload)).unwrap();
            guard += 1;
            assert!(guard < 200, "flow did not terminate");
        }
    }

    fn drive(state: &[u8], message: &[u8], head: &[u8], payload_len: usize) -> PresetFlow {
        let mut flow = PresetFlow::new();
        read_object(&mut flow, state, &[], 2048);
        read_object(&mut flow, message, head, payload_len);
        flow
    }

    #[test]
    fn object_open_matches_the_reference_request() {
        let request = build_object_open(OBJECT_ACTIVE_PRESET, None).unwrap();
        assert_eq!(request[11], 0x04);
        assert_eq!(&request[4..8], &[0x01, 0x10, 0xef, 0x03]);
        assert_eq!(request[9], OBJECT_OPEN_SEQ);
        assert_eq!(&request[12..16], &[0x38, 0x10, 0x00, 0x00]);
        // {102: 1002, 100: 22, 101: {107: 0, 101: 2}}
        assert_eq!(
            &request[16..],
            &[
                0x01, 0x00, 0x02, 0x00, 0x0d, 0x00, 0x00, 0x00, 0x83, 0x66, 0xcd, 0x03, 0xea, 0x64,
                0x16, 0x65, 0x82, 0x6b, 0x00, 0x65, 0x02, 0x00, 0x00, 0x00,
            ]
        );
        // The active-state request differs only in the operation byte (23).
        let state = build_object_open(OBJECT_ACTIVE_STATE, None).unwrap();
        assert_eq!(state[30], 0x17);
    }

    #[test]
    fn reads_the_active_state_then_the_preset() {
        let state = state_message(1, 42, "Test Preset");
        let message = object_message(PRESET);
        let flow = drive(&state, &message, &[], 496);

        assert!(flow.is_finished());
        assert!(!flow.truncated());
        assert_eq!(flow.raw(), message);
        assert_eq!(flow.blob().unwrap(), PRESET);
        let active = flow.active_state();
        assert_eq!(active.setlist, Some(1));
        assert_eq!(active.slot, Some(42));
        assert_eq!(active.name, "Test Preset");
    }

    #[test]
    fn body_only_read_skips_the_active_state() {
        let message = object_message(PRESET);
        let mut flow = PresetFlow::for_active_body();
        read_object(&mut flow, &message, &[], 496);

        assert!(flow.is_finished());
        assert_eq!(flow.object(), OBJECT_ACTIVE_PRESET);
        assert_eq!(flow.blob().unwrap(), PRESET);
        assert_eq!(flow.active_state(), ActiveState::default());
        let json = flow.structure_json_named("Active preset").unwrap();
        assert!(json.contains("\"name\":\"Active preset\""));
        assert!(json.contains("\"setlist\":null"));
    }

    #[test]
    fn handshake_retry_keeps_the_active_state() {
        let state = state_message(1, 42, "Test Preset");
        let message = object_message(PRESET);
        let mut flow = PresetFlow::new();
        read_object(&mut flow, &state, &[], 2048);

        // The first packet of the object-22 handshake was accepted, then the
        // pedal went silent: restart the sequence without discarding object 23.
        flow.accept_response(&ack()).unwrap();
        assert_eq!(flow.phase(), "handshake");
        flow.restart_handshake();

        read_object(&mut flow, &message, &[], 496);
        assert!(flow.is_finished());
        assert_eq!(flow.active_state().setlist, Some(1));
        assert_eq!(flow.active_state().slot, Some(42));
        assert_eq!(flow.active_state().name, "Test Preset");
    }

    #[test]
    fn structure_json_describes_the_chain() {
        let state = state_message(0, 3, "US Deluxe Nrm");
        let flow = drive(&state, &object_message(PRESET), &[], 496);
        let json = flow.structure_json().unwrap();

        assert!(json.contains("\"name\":\"US Deluxe Nrm\""));
        assert!(json.contains("\"slot\":3"));
        assert!(json.contains("\"tempo\":120.0"));
        assert!(json.contains("\"kind\":\"input\""));
        assert!(json.contains("\"kind\":\"empty\""));
        assert!(json.contains("\"kind\":\"output\""));
        // First processing slot is the volume block (224), bypass on.
        assert!(json.contains("\"slot\":1,\"kind\":\"block\",\"modelId\":224,"));
        // Footswitch and controller assignments are carried through.
        assert!(json.contains("\"switch\":\"FS1\",\"block\":8"));
        assert!(json.contains("\"switch\":\"EXP Toe\",\"block\":1"));
        assert!(json.contains("\"controller\":1,\"paramIndex\":0"));
        // The JSON must parse: the page relies on it.
        let parsed = parse_json_for_test(&json);
        assert!(parsed, "structure_json is not valid JSON: {json}");
    }

    #[test]
    fn report_matches_the_probe_output() {
        let state = state_message(0, 3, "US Deluxe Nrm");
        let flow = drive(&state, &object_message(PRESET), &[], 496);
        let report = flow.report().unwrap();
        assert!(report.contains("container: l6-helix"));
        assert!(report.contains("round-trip: byte-identical"));
    }

    #[test]
    fn keeps_data_carried_by_the_open_response() {
        let state = state_message(0, 0, "Preset");
        let message = object_message(PRESET);
        let head = &message[..120];
        let flow = drive(&state, &message, head, 496);
        assert_eq!(flow.raw(), message);
        assert_eq!(flow.blob().unwrap(), PRESET);
    }

    #[test]
    fn rejects_a_non_zero_device_status() {
        let message = Value::map(vec![
            (Value::uint(102), Value::uint(OBJECT_TRANSACTION)),
            (Value::uint(103), Value::uint(1)),
            (
                Value::uint(104),
                Value::map(vec![(Value::uint(111), Value::uint(7))]),
            ),
        ]);
        let bytes = msgpack::encode(&message).unwrap();
        let err = extract_blob(&bytes).unwrap_err();
        assert!(err.contains("status 1"), "{err}");
        assert!(err.contains("code 7"), "{err}");
    }

    #[test]
    fn extract_blob_ignores_trailing_padding() {
        let mut message = object_message(PRESET);
        message.extend_from_slice(&[0u8; 13]);
        assert_eq!(extract_blob(&message).unwrap(), PRESET);
    }

    #[test]
    fn padded_object_still_renders() {
        let mut state = state_message(0, 3, "US Deluxe Nrm");
        state.extend_from_slice(&[0u8; 4]);
        let mut message = object_message(PRESET);
        message.extend_from_slice(&[0u8; 32]);

        let flow = drive(&state, &message, &[], 496);
        assert_eq!(flow.blob().unwrap(), PRESET);
        assert_eq!(flow.active_state().name, "US Deluxe Nrm");
        assert!(flow
            .structure_json()
            .unwrap()
            .contains("\"name\":\"US Deluxe Nrm\""));
    }

    #[test]
    fn slot_flow_requests_the_slot_and_skips_object_23() {
        let mut flow = PresetFlow::for_slot(1, 5);
        for _ in 0..READ_SEQUENCE.len() {
            let request = flow.next_request().unwrap();
            flow.accept_response(&response(&request, &[])).unwrap();
        }

        let request = flow.next_request().unwrap();
        assert_eq!(request, OPEN_PRESETS);
        flow.accept_response(&ack()).unwrap();

        let request = flow.next_request().unwrap();
        assert_eq!(
            request,
            build_object_open(OBJECT_ACTIVE_PRESET, Some((1, 5))).unwrap()
        );
        // The target is carried in the open params: 107=setlist, 108=slot.
        let len = u32::from_le_bytes([request[20], request[21], request[22], request[23]]) as usize;
        let body = msgpack::decode(&request[24..24 + len]).unwrap();
        let params = body.get_u64(101).unwrap();
        assert_eq!(params.get_u64(107).and_then(Value::as_u64), Some(1));
        assert_eq!(params.get_u64(108).and_then(Value::as_u64), Some(5));
        assert_eq!(params.get_u64(101).and_then(Value::as_u64), Some(2));

        let message = object_message(PRESET);
        flow.accept_response(&response(
            &request,
            &[0u8; FIRST_DATA_HEADER_LEN - HEADER_LEN],
        ))
        .unwrap();
        let mut guard = 0;
        while flow.phase() == "chunks" {
            let request = flow.next_request().unwrap();
            let cursor =
                u32::from_le_bytes([request[12], request[13], request[14], request[15]]) as usize;
            let relative = cursor - STREAM_BASE_OFFSET as usize;
            let payload = if relative >= message.len() {
                &[][..]
            } else {
                &message[relative..(relative + 496).min(message.len())]
            };
            flow.accept_response(&response(&request, payload)).unwrap();
            guard += 1;
            assert!(guard < 200, "flow did not terminate");
        }

        assert!(flow.is_finished());
        assert!(flow.state_message.is_none(), "object 23 must be skipped");
        assert_eq!(flow.blob().unwrap(), PRESET);
        let json = flow.structure_json_named("Preset 005").unwrap();
        assert!(json.contains("\"name\":\"Preset 005\""));
        assert!(json.contains("\"setlist\":1"));
        assert!(json.contains("\"slot\":5"));
    }

    #[test]
    fn unfinished_flow_has_no_blob() {
        let flow = PresetFlow::new();
        assert!(flow.blob().unwrap_err().contains("not finished"));
        assert!(flow.structure_json().is_err());
    }

    /// Minimal JSON structure check: balanced braces/brackets outside strings.
    #[allow(clippy::collapsible_match)]
    fn parse_json_for_test(input: &str) -> bool {
        let mut stack = Vec::new();
        let mut in_string = false;
        let mut escaped = false;
        for ch in input.chars() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            match ch {
                '"' => in_string = true,
                '{' => stack.push('}'),
                '[' => stack.push(']'),
                '}' | ']' => {
                    if stack.pop() != Some(ch) {
                        return false;
                    }
                }
                _ => {}
            }
        }
        stack.is_empty() && !in_string
    }
}
