//! Frame representation and field accessors.
//!
//! The 16-byte header is stored verbatim. This is deliberate: not every field
//! is understood, and byte identity matters for diagnostics and for future
//! firmware. Accessors decode only the fields with evidence.

use crate::error::ProtocolError;

/// Fixed header length.
pub const HEADER_LEN: usize = 16;

/// A vendor protocol frame: 16-byte header plus an opaque body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    header: [u8; HEADER_LEN],
    body: Vec<u8>,
}

impl Frame {
    /// Parse a frame from raw bytes, preserving header and body verbatim.
    ///
    /// # Errors
    ///
    /// Returns [`ProtocolError::TooShort`] if fewer than 16 bytes are supplied.
    pub fn parse(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < HEADER_LEN {
            return Err(ProtocolError::TooShort {
                needed: HEADER_LEN,
                actual: bytes.len(),
            });
        }
        let mut header = [0u8; HEADER_LEN];
        header.copy_from_slice(&bytes[..HEADER_LEN]);
        Ok(Self {
            header,
            body: bytes[HEADER_LEN..].to_vec(),
        })
    }

    /// Build a frame from an explicit header and body.
    #[must_use]
    pub fn from_parts(header: [u8; HEADER_LEN], body: Vec<u8>) -> Self {
        Self { header, body }
    }

    /// Raw header bytes.
    #[must_use]
    pub fn header(&self) -> &[u8; HEADER_LEN] {
        &self.header
    }

    /// Mutable header bytes.
    ///
    /// Mutating fields without understanding their meaning can make the device
    /// reject the frame. Prefer the builder functions.
    pub fn header_mut(&mut self) -> &mut [u8; HEADER_LEN] {
        &mut self.header
    }

    /// Body bytes (everything after the fixed header).
    #[must_use]
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    /// Mutable body bytes.
    pub fn body_mut(&mut self) -> &mut Vec<u8> {
        &mut self.body
    }

    /// Serialize the frame.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + self.body.len());
        out.extend_from_slice(&self.header);
        out.extend_from_slice(&self.body);
        out
    }

    /// Magic byte (header offset 3).
    #[must_use]
    pub fn magic(&self) -> u8 {
        self.header[3]
    }

    /// Source address (header offsets 4–5, little-endian).
    #[must_use]
    pub fn source(&self) -> u16 {
        u16::from_le_bytes([self.header[4], self.header[5]])
    }

    /// Destination address (header offsets 6–7, little-endian).
    #[must_use]
    pub fn destination(&self) -> u16 {
        u16::from_le_bytes([self.header[6], self.header[7]])
    }

    /// Sequence byte (header offset 9).
    #[must_use]
    pub fn seq(&self) -> u8 {
        self.header[9]
    }

    /// Command byte (header offset 11).
    #[must_use]
    pub fn command(&self) -> u8 {
        self.header[11]
    }

    /// Cursor/stream offset (header offsets 12–15, little-endian).
    #[must_use]
    pub fn cursor(&self) -> u32 {
        u32::from_le_bytes([
            self.header[12],
            self.header[13],
            self.header[14],
            self.header[15],
        ])
    }

    /// Stored body-length byte (header offset 0).
    ///
    /// Its exact semantics are not fully proven; see the unknowns document.
    #[must_use]
    pub fn body_len_byte(&self) -> u8 {
        self.header[0]
    }

    /// Return a copy with a different sequence byte.
    #[must_use]
    pub fn with_seq(mut self, seq: u8) -> Self {
        self.header[9] = seq;
        self
    }

    /// Return a copy with a different cursor.
    #[must_use]
    pub fn with_cursor(mut self, cursor: u32) -> Self {
        self.header[12..16].copy_from_slice(&cursor.to_le_bytes());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_header_fields_little_endian() {
        let mut bytes = vec![0u8; HEADER_LEN];
        bytes[3] = 0x18;
        bytes[4..6].copy_from_slice(&0x1001u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&0x03EFu16.to_le_bytes());
        bytes[9] = 0x07;
        bytes[11] = 0x08;
        bytes[12..16].copy_from_slice(&0x1138u32.to_le_bytes());
        let frame = Frame::parse(&bytes).unwrap();
        assert_eq!(frame.magic(), 0x18);
        assert_eq!(frame.source(), 0x1001);
        assert_eq!(frame.destination(), 0x03EF);
        assert_eq!(frame.seq(), 0x07);
        assert_eq!(frame.command(), 0x08);
        assert_eq!(frame.cursor(), 0x1138);
        assert_eq!(frame.to_bytes(), bytes);
    }

    #[test]
    fn rejects_short_frame() {
        assert!(matches!(
            Frame::parse(&[0u8; 15]),
            Err(ProtocolError::TooShort { .. })
        ));
    }

    #[test]
    fn with_seq_and_cursor_are_pure() {
        let frame = Frame::from_parts([0u8; HEADER_LEN], vec![]);
        let changed = frame.clone().with_seq(9).with_cursor(0x1234);
        assert_eq!(frame.seq(), 0);
        assert_eq!(changed.seq(), 9);
        assert_eq!(changed.cursor(), 0x1234);
    }
}
