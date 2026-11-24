//! Event-channel frames for live pedal-to-page synchronisation.
//!
//! The transport moves bytes; this module owns the POD Go event framing:
//! poll/ack builders, the notification decoder and the cursor advance. See
//! `docs/protocol/notifications.md`.

use podgo_domain::msgpack::Value;
use podgo_protocol::frame::Frame;
use podgo_protocol::handshake::{build_event_ack, build_event_poll};
use podgo_protocol::notification::{decode_notification, event_cursor_advance};
use wasm_bindgen::prelude::*;

/// One decoded event, rendered for the page.
///
/// `payload` is the inner map for envelope events (ops 4/8/22/30/39/49) and
/// the payload itself otherwise. Numeric keys stay strings, e.g.
/// `{"opcode":30,"payload":{"98":3,"28":0,"119":0.5}}`.
#[wasm_bindgen]
#[must_use]
pub fn decode_event_json(bytes: &[u8]) -> String {
    let frame = match Frame::parse(bytes) {
        Ok(frame) => frame,
        Err(error) => return error_json(&error.to_string()),
    };
    let notification = match decode_notification(&frame) {
        Ok(notification) => notification,
        Err(error) => return error_json(&error.to_string()),
    };
    let mut out = String::with_capacity(128);
    out.push_str("{\"opcode\":");
    out.push_str(&notification.opcode.to_string());
    out.push_str(",\"payload\":");
    push_json(&mut out, &notification.payload());
    out.push('}');
    out
}

fn error_json(message: &str) -> String {
    let mut out = String::with_capacity(message.len() + 16);
    out.push_str("{\"error\":");
    push_json_string(&mut out, message);
    out.push('}');
    out
}

/// Build one event-channel poll (`cmd=0x10`).
#[wasm_bindgen]
#[must_use]
pub fn build_event_poll_frame(seq: u8, cursor: u32) -> Vec<u8> {
    build_event_poll(seq, cursor)
}

/// Build one event-channel acknowledgement (`cmd=0x08`).
#[wasm_bindgen]
#[must_use]
pub fn build_event_ack_frame(seq: u8, cursor: u32) -> Vec<u8> {
    build_event_ack(seq, cursor)
}

/// Cursor advance for one event data frame (`8 + declared body length`).
#[wasm_bindgen]
#[must_use]
pub fn event_frame_advance(bytes: &[u8]) -> u32 {
    event_cursor_advance(bytes).unwrap_or(0)
}

/// Render a MessagePack value as JSON.
///
/// Only the scalar and container shapes notifications use are rendered; a
/// binary payload becomes its byte length, which is enough for diagnostics.
fn push_json(out: &mut String, value: &Value) {
    match value {
        Value::Nil => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::UInt { value, .. } => out.push_str(&value.to_string()),
        Value::Int { value, .. } => out.push_str(&value.to_string()),
        Value::F32(value) => push_json_number(out, f64::from(*value)),
        Value::F64(value) => push_json_number(out, *value),
        Value::Str { value, .. } => {
            push_json_string(out, &String::from_utf8_lossy(value));
        }
        Value::Bin { value, .. } => {
            out.push_str("{\"bytes\":");
            out.push_str(&value.len().to_string());
            out.push('}');
        }
        Value::Array { items, .. } => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_json(out, item);
            }
            out.push(']');
        }
        Value::Map { entries, .. } => {
            out.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_json_key(out, key);
                out.push(':');
                push_json(out, item);
            }
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

fn push_json_key(out: &mut String, key: &Value) {
    match key {
        Value::Str { value, .. } => push_json_string(out, &String::from_utf8_lossy(value)),
        Value::UInt { value, .. } => push_json_string(out, &value.to_string()),
        Value::Int { value, .. } => push_json_string(out, &value.to_string()),
        other => push_json_string(out, &format!("{other:?}")),
    }
}

fn push_json_number(out: &mut String, value: f64) {
    if value.is_finite() {
        out.push_str(&value.to_string());
    } else {
        out.push_str("null");
    }
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if control < ' ' => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVENTS: &[u8] = include_bytes!("../../../../fixtures/events_actions_fw250.bin");

    fn frames() -> Vec<&'static [u8]> {
        let mut frames = Vec::new();
        let mut pos = 0;
        while pos + 2 <= EVENTS.len() {
            let len = usize::from(u16::from_le_bytes([EVENTS[pos], EVENTS[pos + 1]]));
            pos += 2;
            frames.push(&EVENTS[pos..pos + len]);
            pos += len;
        }
        frames
    }

    #[test]
    fn decodes_a_knob_event_with_its_unwrapped_payload() {
        let json = decode_event_json(frames()[7]);
        assert_eq!(
            json,
            "{\"opcode\":30,\"payload\":{\"98\":2,\"29\":true,\"26\":0,\"28\":0,\"119\":23}}"
        );
    }

    #[test]
    fn decodes_a_snapshot_event() {
        assert_eq!(
            decode_event_json(frames()[14]),
            "{\"opcode\":42,\"payload\":{\"92\":1}}"
        );
    }

    #[test]
    fn rejects_a_frame_without_opcode() {
        let json = decode_event_json(&[0u8; 16]);
        assert!(json.starts_with("{\"error\":"));
    }

    #[test]
    fn poll_and_ack_are_the_captured_frames() {
        assert_eq!(
            hex(&build_event_poll_frame(0x06, 0x1009)),
            "080000180210f0030006001009100000"
        );
        assert_eq!(
            hex(&build_event_ack_frame(0x06, 0x1022)),
            "080000180210f0030006000822100000"
        );
    }

    #[test]
    fn advance_reads_the_declared_body_length() {
        const CAPTURED: &[u8] = include_bytes!("../../../../fixtures/events_fw250.bin");
        let len = usize::from(u16::from_le_bytes([CAPTURED[0], CAPTURED[1]]));
        let frame = &CAPTURED[2..2 + len];
        let declared = u32::from_le_bytes([frame[20], frame[21], frame[22], frame[23]]);
        assert_eq!(event_frame_advance(frame), 8 + declared);
        assert_eq!(event_frame_advance(&[0u8; 16]), 0);
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
