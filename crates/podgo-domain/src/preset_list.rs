//! Preset-list scanning for streamed setlists.
//!
//! The device emits a MessagePack array of 128 entries. Each entry is shaped
//! `{<index>: {109: "<name>\0", ...}}`, but keys are encoded as **uint16**
//! (`cd 00 6d` for key 109) rather than canonical fixints, and the stream can
//! contain padding or repeated windows. A strict whole-buffer decode would
//! therefore fail on real captures.
//!
//! This module mirrors the evidence-backed scan from the reference project:
//! find the name key, decode the following string, and read the index from the
//! preceding outer-map header. The scan order defines the `slot`; the encoded
//! index is a stable preset id that may differ from the slot after reordering.
//!
//! Confidence: strongly supported (validated by the reference against a real
//! User-setlist capture). See `docs/reverse-engineering/protocol-specification.md`
//! and `docs/protocol/presets.md`.

use crate::error::DomainError;
use crate::msgpack::{self, Value};

/// MessagePack key carrying the preset name.
pub const PRESET_NAME_KEY: u16 = 109;

/// Maximum number of entries accepted from one stream.
pub const MAX_PRESET_ENTRIES: usize = 128;

/// Maximum bytes inspected for a single name.
const MAX_NAME_BYTES: usize = 256;

/// The name key encoded the way the device emits it: uint16 `109`.
const NAME_KEY_BYTES: [u8; 3] = [0xcd, 0x00, 0x6d];

/// One entry in a streamed setlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetEntry {
    /// Stable preset id encoded in the entry (may be `>= 128` in the User list).
    pub index: u16,
    /// Position in the stream (program-change slot, `0..=127`).
    pub slot: u16,
    /// Display name, without the trailing NUL.
    pub name: String,
}

/// Scan `(index, name)` pairs in stream order.
///
/// The scan stops after [`MAX_PRESET_ENTRIES`] entries. Malformed candidates
/// are skipped rather than aborting the scan.
#[must_use]
pub fn scan_preset_entries(raw: &[u8]) -> Vec<(u16, String)> {
    let mut entries = Vec::new();
    let mut search_from = 0usize;

    while entries.len() < MAX_PRESET_ENTRIES {
        let Some(relative) = find(&raw[search_from..], &NAME_KEY_BYTES) else {
            break;
        };
        let key_pos = search_from + relative;
        search_from = key_pos + NAME_KEY_BYTES.len();

        // Outer map header: `81 cd HI LO` immediately before the name key.
        if key_pos < 5 || raw[key_pos - 5] != 0x81 || raw[key_pos - 4] != 0xcd {
            continue;
        }
        let index = u16::from_be_bytes([raw[key_pos - 3], raw[key_pos - 2]]);
        let Some(name) = decode_name(&raw[key_pos + NAME_KEY_BYTES.len()..]) else {
            continue;
        };
        entries.push((index, name));
    }

    entries
}

/// Parse a streamed setlist into entries, assigning slots in stream order.
///
/// # Errors
///
/// Returns [`DomainError::InvalidContainer`] when no entry can be found.
pub fn parse_preset_list(raw: &[u8]) -> Result<Vec<PresetEntry>, DomainError> {
    let scanned = scan_preset_entries(raw);
    if scanned.is_empty() {
        return Err(DomainError::InvalidContainer(
            "no preset entries found in the stream",
        ));
    }
    Ok(scanned
        .into_iter()
        .enumerate()
        .map(|(slot, (index, name))| PresetEntry {
            index,
            slot: slot as u16,
            name,
        })
        .collect())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn decode_name(bytes: &[u8]) -> Option<String> {
    let slice = &bytes[..bytes.len().min(MAX_NAME_BYTES)];
    let (value, _) = msgpack::decode_prefix(slice).ok()?;
    let raw = match value {
        Value::Str { value, .. } => value,
        Value::Bin { value, .. } => value,
        _ => return None,
    };
    let text = String::from_utf8_lossy(&raw);
    let name = text.trim_end_matches('\0').trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(index: u16, name: &str) -> Vec<u8> {
        let mut name = format!("{name}\0").into_bytes();
        assert!(name.len() <= 31, "test names must fit a fixstr");
        let mut out = vec![
            0x81,
            0xcd,
            (index >> 8) as u8,
            index as u8,
            0x84,
            0xcd,
            0x00,
            0x6d,
        ];
        out.push(0xa0 | name.len() as u8);
        out.append(&mut name);
        out.extend_from_slice(&[0x7b, 0xc2, 0x7c, 0xc2, 0x7d, 0x00]);
        out
    }

    const FIXTURE: &[u8] = include_bytes!("../../../fixtures/user_setlist.bin");
    const FACTORY_FIXTURE: &[u8] = include_bytes!("../../../fixtures/factory_setlist_fw250.bin");

    #[test]
    fn parses_captured_factory_stream_with_data_header() {
        // The Factory open response is a plain ack, so the 8-byte data-message
        // header lands at the front of the first chunk. The scanner must skip
        // it instead of treating it as the first entry.
        assert_eq!(&FACTORY_FIXTURE[..4], &[0x00, 0x00, 0x02, 0x00]);
        let declared = u32::from_le_bytes([
            FACTORY_FIXTURE[4],
            FACTORY_FIXTURE[5],
            FACTORY_FIXTURE[6],
            FACTORY_FIXTURE[7],
        ]) as usize;
        assert_eq!(declared, FACTORY_FIXTURE.len() - 8);

        let entries = parse_preset_list(FACTORY_FIXTURE).unwrap();
        assert_eq!(entries.len(), 128);
        assert_eq!(entries[0].slot, 0);
        assert_eq!(
            (entries[0].index, entries[0].name.as_str()),
            (0, "US Deluxe Nrm")
        );
        assert_eq!(entries[11].name, "Archetype Lead");
        assert_eq!(
            (
                entries[127].slot,
                entries[127].index,
                entries[127].name.as_str()
            ),
            (127, 127, "New Preset")
        );
    }

    #[test]
    fn scans_factory_style_stream() {
        let mut raw = vec![0x00, 0x11, 0x22];
        raw.push(0xdc);
        raw.extend_from_slice(&3u16.to_be_bytes());
        for i in 0..3u16 {
            raw.extend_from_slice(&entry(i, &format!("Preset {i:02}")));
        }
        let entries = parse_preset_list(&raw).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[0].slot, 0);
        assert_eq!(entries[2].name, "Preset 02");
    }

    #[test]
    fn slot_is_stream_position_not_index() {
        let mut raw = vec![0x00];
        raw.extend_from_slice(&entry(139, "Two"));
        raw.extend_from_slice(&entry(129, "Moved"));
        raw.extend_from_slice(&entry(140, "Other"));
        let entries = parse_preset_list(&raw).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.slot, e.index, e.name.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, 139, "Two"), (1, 129, "Moved"), (2, 140, "Other")]
        );
    }

    #[test]
    fn parses_real_user_capture() {
        let entries = parse_preset_list(FIXTURE).unwrap();
        assert_eq!(entries.len(), 128);
        assert_eq!(
            (entries[0].index, entries[0].name.as_str()),
            (128, "Preset 000")
        );
        assert_eq!(
            (entries[9].index, entries[9].name.as_str()),
            (138, "Preset 008")
        );
        assert_eq!(entries[36].index, 129);
        assert_eq!(entries[36].name, "Preset 033");
        assert!(entries
            .iter()
            .enumerate()
            .all(|(slot, entry)| entry.slot as usize == slot));
    }

    #[test]
    fn rejects_stream_without_entries() {
        assert!(matches!(
            parse_preset_list(b"\x00\x01 no entries here"),
            Err(DomainError::InvalidContainer(_))
        ));
    }

    #[test]
    fn caps_entries_at_the_setlist_size() {
        let mut raw = Vec::new();
        for i in 0..(MAX_PRESET_ENTRIES + 10) {
            raw.extend_from_slice(&entry(i as u16, "X"));
        }
        assert_eq!(scan_preset_entries(&raw).len(), MAX_PRESET_ENTRIES);
    }

    #[test]
    fn names_are_nul_trimmed_and_binary_is_accepted() {
        // bin8 "Hi\0"
        let mut raw = vec![0x00, 0x81, 0xcd, 0x00, 0x01, 0x84, 0xcd, 0x00, 0x6d];
        raw.extend_from_slice(&[0xc4, 0x03, b'H', b'i', 0x00]);
        let entries = parse_preset_list(&raw).unwrap();
        assert_eq!(entries[0].name, "Hi");
    }
}
