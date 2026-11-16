//! Notification decoding for the event channel.
//!
//! Notifications are MessagePack maps `{105: opcode, 106: data}`. On firmware
//! 2.50 every captured event is framed: subheader `00 00 04 00`, a `u32` body
//! length, then the MessagePack at offset 24, followed by zero padding to a
//! 4-byte boundary. The decoder tries that framing first and keeps a raw-body
//! fallback for older or unexpected captures, rejecting candidates that lack
//! key 105. See `docs/protocol/notifications.md` §3.

use podgo_domain::msgpack::{self, Value};

use crate::constants::{KEY_EVENT_DATA, KEY_EVENT_OPCODE};
use crate::error::ProtocolError;
use crate::frame::Frame;
use crate::open::payload;

// Opcode meanings below come from the guided capture analysis in
// `docs/protocol/notifications.md` (fw 2.50, all eleven actions performed in
// order). Constants whose meaning is not fully proven say so in their docs.

/// Event opcode: request status mirror `{102, 103, 104}`.
///
/// Only one occurrence (id 1005); the distinction from [`OP_RESPONSE`] is not
/// established.
pub const OP_REQUEST_STATUS: u64 = 1;
/// Event opcode: active preset confirmed, ends a preset-load sequence.
///
/// Carries `{107: setlist, 108: slot}` like [`OP_PRESET_LOADED`]. The MIT
/// reference calls it `preset_saved`, but the capture shows it after every
/// preset change with no save, so "saved" is not claimed here.
pub const OP_PRESET_ACTIVE: u64 = 4;
/// Event opcode: preset name/metadata `{107, 108, 109: name}`.
pub const OP_PRESET_NAME: u64 = 6;
/// Event opcode: preset loaded `{107: setlist, 108: slot}`.
pub const OP_PRESET_LOADED: u64 = 8;
/// Event opcode: request/response mirror `{102, 103, 104}`.
///
/// Arrives after an editor request completes (ids 1009, 1024, 1025 in the
/// capture) and repeats the response object already sent on the write channel.
pub const OP_RESPONSE: u64 = 20;
/// Event opcode: signal chain or preset structure changed (no data).
pub const OP_CHAIN_CHANGED: u64 = 21;
/// Event opcode: one scalar field changed `{118: field, 119: value}`.
///
/// Field 16 is tempo in BPM, field 28 the active slot (matches `108`), field
/// 124 a 1/2 state index during a controller transition. The opcode is
/// historically called `tempo`; it is not tempo-only.
pub const OP_TEMPO: u64 = 22;
/// Event opcode: set parameter `{98: block, 119: value, ...}`.
pub const OP_SET_PARAM: u64 = 30;
/// Write command: save the active preset to a slot `{107, 108, 109}`.
///
/// Captured as an editor request (not an event) in
/// `reverse/exports/podgo-preset-save.pcapng`; see `docs/protocol/writes.md`.
pub const OP_SAVE_PRESET: u64 = 71;
/// Event opcode: footswitch assignment added `{98: block, 70: footswitch, 79}`.
pub const OP_FOOTSWITCH_ASSIGN: u64 = 31;
/// Event opcode: footswitch assignment removed `{98: block, 70: footswitch}`.
pub const OP_FOOTSWITCH_UNASSIGN: u64 = 33;
/// Event opcode: controller assignment `{74: controller, 71: parameter, 98, 72,
/// 73}`.
pub const OP_CONTROLLER_ASSIGN: u64 = 34;
/// Event opcode: bypass report (legacy) `{98: block, 26: flag}`.
pub const OP_BYPASS_LEGACY: u64 = 39;
/// Event opcode: model change `{91: model id}`.
///
/// The MIT reference uses op 40 for `set_model`; the capture shows it once
/// next to a footswitch transition.
pub const OP_MODEL_CHANGED: u64 = 40;
/// Event opcode: footswitch state `{70: footswitch, 63: bool, 66: value}`.
///
/// Field meanings are not established.
pub const OP_FOOTSWITCH_STATE: u64 = 41;
/// Event opcode: snapshot index `{92: index}` (first variant).
pub const OP_SNAPSHOT: u64 = 42;
/// Event opcode: snapshot state `{92: index}` (second variant, emitted right
/// after [`OP_SNAPSHOT`]).
pub const OP_SNAPSHOT_STATE: u64 = 46;
/// Event opcode: absolute bypass state `{98: block, 59: enabled}`.
///
/// Also observed with a null payload during snapshot changes; do not treat it
/// as a bypass update unless key 59 is present.
pub const OP_BYPASS_STATE: u64 = 49;

/// A decoded device notification.
#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    /// Opcode (key 105).
    pub opcode: u64,
    /// Data (key 106), if present.
    pub data: Option<Value>,
    /// Full decoded body, including unknown keys.
    pub body: Value,
}

/// Decode a notification frame.
///
/// # Errors
///
/// Returns [`ProtocolError::MissingField`] if no candidate body contains key
/// 105, or a MessagePack error if neither shape decodes.
pub fn decode_notification(frame: &Frame) -> Result<Notification, ProtocolError> {
    // Preferred: the declared framing, if it decodes to a map with key 105.
    if let Ok(bytes) = payload(frame) {
        if let Ok(body) = msgpack::decode(bytes) {
            if let Some(opcode) = body.get_u64(KEY_EVENT_OPCODE).and_then(Value::as_u64) {
                return Ok(Notification {
                    opcode,
                    data: body.get_u64(KEY_EVENT_DATA).cloned(),
                    body,
                });
            }
        }
    }

    // Fallback: the raw window.
    let body = msgpack::decode(frame.body())?;
    let opcode = body
        .get_u64(KEY_EVENT_OPCODE)
        .and_then(Value::as_u64)
        .ok_or(ProtocolError::MissingField("105"))?;
    Ok(Notification {
        opcode,
        data: body.get_u64(KEY_EVENT_DATA).cloned(),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::HEADER_LEN;

    /// Fourteen notification frames captured from POD Go Wireless fw 2.50.
    ///
    /// Container: repeated `u16 LE length` + frame bytes. Frames come from
    /// `reverse/exports/podgo-connect.pcapng` (official editor traffic).
    const EVENTS: &[u8] = include_bytes!("../../../fixtures/events_fw250.bin");

    fn captured_frames() -> Vec<&'static [u8]> {
        let mut frames = Vec::new();
        let mut pos = 0;
        while pos + 2 <= EVENTS.len() {
            let len = usize::from(u16::from_le_bytes([EVENTS[pos], EVENTS[pos + 1]]));
            pos += 2;
            frames.push(&EVENTS[pos..pos + len]);
            pos += len;
        }
        assert_eq!(pos, EVENTS.len(), "trailing bytes in the capture fixture");
        frames
    }

    #[test]
    fn decodes_every_captured_firmware_250_notification() {
        let frames = captured_frames();
        assert_eq!(frames.len(), 14);

        let mut opcodes = Vec::new();
        for bytes in frames {
            // Every captured event is framed: 4-byte type marker, u32 body
            // length, MessagePack at offset 24, zero padding to a 4-byte
            // boundary. No offset-16 variant appears in this capture.
            assert_eq!(&bytes[16..20], &[0x00, 0x00, 0x04, 0x00]);
            let declared = u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            let declared = usize::try_from(declared).unwrap();
            assert!(declared >= 2);
            assert!(bytes.len() >= 24 + declared);
            assert!(bytes.len() - 24 - declared < 4);

            let frame = Frame::parse(bytes).unwrap();
            let notification = decode_notification(&frame).unwrap();
            assert!(notification.data.is_some());
            opcodes.push(notification.opcode);
        }

        // Two preset changes in the capture: request status, preset load,
        // tempo, bypass, tempo, active preset — twice.
        assert_eq!(
            opcodes,
            [20, 8, 22, 22, 39, 22, 4, 20, 8, 22, 22, 39, 22, 4]
        );
    }

    /// Eighteen frames covering every opcode of the guided action capture
    /// (`reverse/exports/podgo-events.pcapng`, fw 2.50, POD Go Edit 2.50).
    ///
    /// One representative frame per opcode and payload shape, except opcode 6:
    /// its only frame carries a personal preset name, so it is not committed.
    const ACTIONS: &[u8] = include_bytes!("../../../fixtures/events_actions_fw250.bin");

    fn action_frames() -> Vec<&'static [u8]> {
        let mut frames = Vec::new();
        let mut pos = 0;
        while pos + 2 <= ACTIONS.len() {
            let len = usize::from(u16::from_le_bytes([ACTIONS[pos], ACTIONS[pos + 1]]));
            pos += 2;
            frames.push(&ACTIONS[pos..pos + len]);
            pos += len;
        }
        assert_eq!(pos, ACTIONS.len(), "trailing bytes in the actions fixture");
        frames
    }

    fn decode_at(frames: &[&'static [u8]], index: usize) -> Notification {
        let frame = Frame::parse(frames[index]).unwrap();
        decode_notification(&frame).unwrap()
    }

    /// Event payload: unwraps the `{82, 68, 121, 106: ...}` envelope when
    /// present (ops 4/8/22/30/39/49) and returns the data map otherwise.
    fn payload_of(notification: &Notification) -> Value {
        let data = notification.data.clone().unwrap_or(Value::Nil);
        data.get_u64(KEY_EVENT_DATA).cloned().unwrap_or(data)
    }

    #[test]
    fn decodes_every_opcode_of_the_guided_capture() {
        let frames = action_frames();
        assert_eq!(frames.len(), 18);

        let mut opcodes = Vec::new();
        for (index, bytes) in frames.iter().enumerate() {
            assert_eq!(&bytes[16..20], &[0x00, 0x00, 0x04, 0x00]);
            let declared = u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            let declared = usize::try_from(declared).unwrap();
            assert!(bytes.len() >= 24 + declared);
            assert!(bytes.len() - 24 - declared < 4);
            opcodes.push(decode_at(&frames, index).opcode);
        }

        // One frame per opcode, plus a second shape for 22 and 49.
        assert_eq!(
            opcodes,
            [1, 4, 8, 20, 21, 22, 22, 30, 31, 33, 34, 39, 40, 41, 42, 46, 49, 49]
        );
    }

    #[test]
    fn action_capture_payloads_match_the_recorded_actions() {
        let frames = action_frames();

        // Preset load: 8 announces {setlist, slot}; 4 confirms the same slot.
        let loaded = payload_of(&decode_at(&frames, 2));
        assert_eq!(loaded.get_u64(107).and_then(Value::as_u64), Some(1));
        assert_eq!(loaded.get_u64(108).and_then(Value::as_u64), Some(17));
        let active = payload_of(&decode_at(&frames, 1));
        assert_eq!(active.get_u64(108).and_then(Value::as_u64), Some(17));

        // 22 carries the active slot (field 28) and the tempo (field 16).
        let slot = payload_of(&decode_at(&frames, 5));
        assert_eq!(slot.get_u64(118).and_then(Value::as_u64), Some(28));
        assert_eq!(slot.get_u64(119).and_then(Value::as_u64), Some(17));
        let tempo = payload_of(&decode_at(&frames, 6));
        assert_eq!(tempo.get_u64(118).and_then(Value::as_u64), Some(16));
        assert_eq!(tempo.get_u64(119).and_then(Value::as_f64), Some(120.0));

        // 30 (knob) and 49 (absolute bypass) reference a block via key 98.
        let knob = payload_of(&decode_at(&frames, 7));
        assert_eq!(knob.get_u64(98).and_then(Value::as_u64), Some(2));
        assert_eq!(knob.get_u64(119).and_then(Value::as_u64), Some(23));
        let bypass = payload_of(&decode_at(&frames, 17));
        assert_eq!(bypass.get_u64(98).and_then(Value::as_u64), Some(4));
        assert_eq!(bypass.get_u64(59).and_then(Value::as_bool), Some(false));

        // 33 removes a footswitch assignment; 31 carries the footswitch id.
        let unassign = payload_of(&decode_at(&frames, 9));
        assert_eq!(unassign.get_u64(70).and_then(Value::as_u64), Some(5));

        // 21 signals a structural change and carries an explicit null payload.
        assert_eq!(decode_at(&frames, 4).opcode, OP_CHAIN_CHANGED);
        assert_eq!(decode_at(&frames, 4).data, Some(Value::Nil));

        // Snapshot variants both carry the index in key 92.
        for index in [14, 15] {
            assert_eq!(
                payload_of(&decode_at(&frames, index))
                    .get_u64(92)
                    .and_then(Value::as_u64),
                Some(1)
            );
        }
    }

    #[test]
    fn captured_tempo_event_keeps_its_payload() {
        let frames = captured_frames();
        let frame = Frame::parse(frames[2]).unwrap();
        let notification = decode_notification(&frame).unwrap();
        assert_eq!(notification.opcode, OP_TEMPO);
        let data = notification.data.unwrap();
        // {82: 0, 68: 9, 121: 25, 106: {118: 16, 119: 120.0}}
        let nested = data.get_u64(KEY_EVENT_DATA).unwrap();
        assert_eq!(nested.get_u64(118).and_then(Value::as_u64), Some(16));
        assert_eq!(nested.get_u64(119).and_then(Value::as_f64), Some(120.0));
    }

    fn notification_body() -> Vec<u8> {
        let body = Value::map(vec![
            (Value::uint(KEY_EVENT_OPCODE), Value::uint(OP_SET_PARAM)),
            (
                Value::uint(KEY_EVENT_DATA),
                Value::map(vec![(Value::uint(98), Value::uint(3))]),
            ),
        ]);
        msgpack::encode(&body).unwrap()
    }

    #[test]
    fn decodes_framed_notification() {
        let body = notification_body();
        let mut bytes = vec![0u8; HEADER_LEN];
        bytes.extend_from_slice(&[0x01, 0x00, 0x04, 0x00]);
        bytes.extend_from_slice(&(body.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&body);
        let frame = Frame::parse(&bytes).unwrap();
        let notification = decode_notification(&frame).unwrap();
        assert_eq!(notification.opcode, OP_SET_PARAM);
        assert!(notification.data.is_some());
    }

    #[test]
    fn decodes_raw_window_notification() {
        let body = notification_body();
        let mut bytes = vec![0u8; HEADER_LEN];
        bytes.extend_from_slice(&body);
        let frame = Frame::parse(&bytes).unwrap();
        let notification = decode_notification(&frame).unwrap();
        assert_eq!(notification.opcode, OP_SET_PARAM);
    }

    #[test]
    fn rejects_map_without_opcode() {
        let body = msgpack::encode(&Value::map(vec![(Value::uint(1), Value::uint(2))])).unwrap();
        let mut bytes = vec![0u8; HEADER_LEN];
        bytes.extend_from_slice(&body);
        let frame = Frame::parse(&bytes).unwrap();
        assert_eq!(
            decode_notification(&frame).unwrap_err(),
            ProtocolError::MissingField("105")
        );
    }
}
