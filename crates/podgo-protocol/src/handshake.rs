//! Handshake and session-control byte templates.
//!
//! These constants are functional protocol facts recovered by community
//! reverse engineering (the MIT-licensed `openpodgo`/`openhx` work) and
//! corroborated by the official binaries. They are not copied application
//! source code.
//!
//! Only the fields known to vary (sequence, cursor, setlist byte) are
//! parameterised. Everything else is emitted verbatim.

use crate::constants::MAGIC_STANDARD;

/// Read-channel handshake packet (20 bytes).
pub const HANDSHAKE: &[u8] = &[
    0x0c, 0x00, 0x00, 0x28, 0x01, 0x10, 0xef, 0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x21,
    0x00, 0x10, 0x00, 0x00,
];

/// Read-channel session open 1 (28 bytes).
pub const SESSION_OPEN_1: &[u8] = &[
    0x11, 0x00, 0x00, 0x18, 0x01, 0x10, 0xef, 0x03, 0x00, 0x02, 0x00, 0x04, 0x00, 0x10, 0x00, 0x00,
    0x01, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
];

/// Read-channel session chunk 1 (16 bytes).
pub const SESSION_CHUNK_1: &[u8] = &[
    0x08, 0x00, 0x00, 0x18, 0x01, 0x10, 0xef, 0x03, 0x00, 0x03, 0x00, 0x08, 0x09, 0x10, 0x00, 0x00,
];

/// Read-channel session open 2 (36 bytes).
pub const SESSION_OPEN_2: &[u8] = &[
    0x1a, 0x00, 0x00, 0x18, 0x01, 0x10, 0xef, 0x03, 0x00, 0x04, 0x00, 0x04, 0x09, 0x10, 0x00, 0x00,
    0x01, 0x00, 0x02, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x83, 0x66, 0xcd, 0x03, 0xe8, 0x64, 0xcc, 0xfe,
    0x65, 0x80, 0x00, 0x00,
];

/// Read-channel session chunk 2 (16 bytes).
pub const SESSION_CHUNK_2: &[u8] = &[
    0x08, 0x00, 0x00, 0x18, 0x01, 0x10, 0xef, 0x03, 0x00, 0x05, 0x00, 0x08, 0x1a, 0x10, 0x00, 0x00,
];

/// The five read-channel handshake packets, in order.
pub const READ_SEQUENCE: [&[u8]; 5] = [
    HANDSHAKE,
    SESSION_OPEN_1,
    SESSION_CHUNK_1,
    SESSION_OPEN_2,
    SESSION_CHUNK_2,
];

/// Event-channel handshake (20 bytes).
pub const EVENT_HANDSHAKE: &[u8] = &[
    0x0c, 0x00, 0x00, 0x28, 0x02, 0x10, 0xf0, 0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x21,
    0x00, 0x10, 0x00, 0x00,
];

/// Event-channel open (28 bytes).
pub const EVENT_OPEN: &[u8] = &[
    0x11, 0x00, 0x00, 0x18, 0x02, 0x10, 0xf0, 0x03, 0x00, 0x02, 0x00, 0x04, 0x00, 0x10, 0x00, 0x00,
    0x01, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
];

/// Event-channel chunk/rest cursor (16 bytes).
pub const EVENT_CHUNK: &[u8] = &[
    0x08, 0x00, 0x00, 0x18, 0x02, 0x10, 0xf0, 0x03, 0x00, 0x03, 0x00, 0x08, 0x09, 0x10, 0x00, 0x00,
];

/// The three event-channel handshake packets.
pub const EVENT_SEQUENCE: [&[u8]; 3] = [EVENT_HANDSHAKE, EVENT_OPEN, EVENT_CHUNK];

/// Open the preset list (36 bytes).
pub const OPEN_PRESETS: &[u8] = &[
    0x19, 0x00, 0x00, 0x18, 0x01, 0x10, 0xef, 0x03, 0x00, 0x06, 0x00, 0x04, 0x1a, 0x10, 0x00, 0x00,
    0x01, 0x00, 0x02, 0x00, 0x09, 0x00, 0x00, 0x00, 0x83, 0x66, 0xcd, 0x03, 0xe9, 0x64, 0x00, 0x65,
    0xc0, 0x00, 0x00, 0x00,
];

/// Open a preset stream (40 bytes).
pub const OPEN_STREAM: &[u8] = &[
    0x1d, 0x00, 0x00, 0x18, 0x01, 0x10, 0xef, 0x03, 0x00, 0x07, 0x00, 0x0c, 0x38, 0x10, 0x00, 0x00,
    0x01, 0x00, 0x02, 0x00, 0x0d, 0x00, 0x00, 0x00, 0x83, 0x66, 0xcd, 0x03, 0xea, 0x64, 0x01, 0x65,
    0x82, 0x6b, 0x00, 0x65, 0x02, 0x00, 0x00, 0x00,
];

/// Build a 16-byte chunk request for the read channel.
///
/// `cursor` is the stream offset. The golden vector is asserted in tests.
#[must_use]
pub fn build_chunk_request(seq: u8, cursor: u32) -> Vec<u8> {
    let mut frame = vec![
        0x08,
        0x00,
        0x00,
        MAGIC_STANDARD,
        0x01,
        0x10,
        0xef,
        0x03,
        0x00,
        seq,
        0x00,
        0x08,
    ];
    frame.extend_from_slice(&cursor.to_le_bytes());
    frame
}

/// Build a 16-byte event poll (`cmd=0x10`) on the event channel.
#[must_use]
pub fn build_event_poll(seq: u8, cursor: u32) -> Vec<u8> {
    let mut frame = vec![
        0x08,
        0x00,
        0x00,
        MAGIC_STANDARD,
        0x02,
        0x10,
        0xf0,
        0x03,
        0x00,
        seq,
        0x00,
        0x10,
    ];
    frame.extend_from_slice(&cursor.to_le_bytes());
    frame
}

/// Build a 16-byte event ack (`cmd=0x08`) on the event channel.
#[must_use]
pub fn build_event_ack(seq: u8, cursor: u32) -> Vec<u8> {
    let mut frame = vec![
        0x08,
        0x00,
        0x00,
        MAGIC_STANDARD,
        0x02,
        0x10,
        0xf0,
        0x03,
        0x00,
        seq,
        0x00,
        0x08,
    ];
    frame.extend_from_slice(&cursor.to_le_bytes());
    frame
}

/// Return a copy of `OPEN_STREAM` selecting `setlist`.
///
/// # Errors
///
/// Returns [`crate::ProtocolError::InvalidFrame`] if the template is shorter
/// than the setlist byte (it never is).
pub fn build_open_stream(setlist: u8) -> Result<Vec<u8>, crate::ProtocolError> {
    let mut frame = OPEN_STREAM.to_vec();
    let index = crate::constants::OPEN_STREAM_SETLIST_BYTE;
    let slot = frame
        .get_mut(index)
        .ok_or(crate::ProtocolError::InvalidFrame(
            "OPEN_STREAM template is too short",
        ))?;
    *slot = setlist;
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::OPEN_STREAM_SETLIST_BYTE;

    #[test]
    fn documented_lengths_match() {
        assert_eq!(HANDSHAKE.len(), 20);
        assert_eq!(SESSION_OPEN_1.len(), 28);
        assert_eq!(SESSION_CHUNK_1.len(), 16);
        assert_eq!(SESSION_OPEN_2.len(), 36);
        assert_eq!(SESSION_CHUNK_2.len(), 16);
        assert_eq!(OPEN_PRESETS.len(), 36);
        assert_eq!(OPEN_STREAM.len(), 40);
    }

    #[test]
    fn only_first_handshake_packet_uses_handshake_magic() {
        assert_eq!(READ_SEQUENCE[0][3], 0x28);
        for packet in &READ_SEQUENCE[1..] {
            assert_eq!(packet[3], 0x18);
        }
    }

    #[test]
    fn chunk_request_golden_vector() {
        assert_eq!(
            build_chunk_request(0x08, 0x1138),
            vec![
                0x08, 0x00, 0x00, 0x18, 0x01, 0x10, 0xef, 0x03, 0x00, 0x08, 0x00, 0x08, 0x38, 0x11,
                0x00, 0x00
            ]
        );
    }

    #[test]
    fn open_stream_setlist_byte_is_parameterised() {
        let factory = build_open_stream(0).unwrap();
        let user = build_open_stream(1).unwrap();
        assert_eq!(factory[OPEN_STREAM_SETLIST_BYTE], 0);
        assert_eq!(user[OPEN_STREAM_SETLIST_BYTE], 1);
        assert_eq!(&factory[..34], &user[..34]);
    }

    #[test]
    fn event_poll_uses_event_channel() {
        let frame = build_event_poll(0x06, 0x1009);
        assert_eq!(&frame[4..8], &[0x02, 0x10, 0xf0, 0x03]);
        assert_eq!(frame[11], 0x10);
        assert_eq!(&frame[12..16], &0x1009u32.to_le_bytes());
    }
}
