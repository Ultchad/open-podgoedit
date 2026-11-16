//! Offline, read-only inspection of a POD Go `l6-helix` preset blob.
//!
//! This crate exists to exercise the domain layer without hardware or a
//! platform transport. It never opens a USB device and never writes anything.
//! The CLI is intentionally dependency-free so it builds offline.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::fmt::Write as _;

use podgo_domain::l6helix::{ChainEntry, Container, Preset};
use podgo_domain::preset_list::{parse_preset_list, PresetEntry};
use podgo_domain::DomainError;

/// Result of inspecting one preset blob.
#[derive(Debug, Clone)]
pub struct Report {
    /// Typed preset view.
    pub preset: Preset,
    /// Original byte length.
    pub original_len: usize,
    /// Length after a local re-encode.
    pub reencoded_len: usize,
    /// Whether the re-encode is byte-identical to the input.
    pub byte_identical: bool,
}

/// Parse a preset blob and check that it re-encodes byte-identically.
///
/// # Errors
///
/// Returns any error from [`Container::parse_preset`] or from re-encoding the
/// container. Malformed input is reported, never panicked on.
pub fn inspect(bytes: &[u8]) -> Result<Report, DomainError> {
    let preset = Container::parse_preset(bytes)?;
    let reencoded = preset.container.to_bytes()?;
    Ok(Report {
        byte_identical: reencoded == bytes,
        original_len: bytes.len(),
        reencoded_len: reencoded.len(),
        preset,
    })
}

/// Result of inspecting one streamed setlist.
#[derive(Debug, Clone)]
pub struct SetlistReport {
    /// Entries in stream (slot) order.
    pub entries: Vec<PresetEntry>,
    /// Raw buffer length.
    pub raw_len: usize,
}

/// Parse a streamed setlist buffer into entries.
///
/// # Errors
///
/// Returns [`DomainError::InvalidContainer`] when no entry can be found.
pub fn inspect_setlist(bytes: &[u8]) -> Result<SetlistReport, DomainError> {
    Ok(SetlistReport {
        entries: parse_preset_list(bytes)?,
        raw_len: bytes.len(),
    })
}

/// Render a human-readable setlist report.
#[must_use]
pub fn render_setlist(report: &SetlistReport) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "setlist:   {} entries ({} B)",
        report.entries.len(),
        report.raw_len
    );
    for entry in &report.entries {
        let _ = writeln!(
            out,
            "  slot {:>3}  id {:>3}  {}",
            entry.slot, entry.index, entry.name
        );
    }
    out
}

/// Render a human-readable report.
#[must_use]
pub fn render(report: &Report) -> String {
    let preset = &report.preset;
    let mut out = String::new();
    let _ = writeln!(out, "container: l6-helix");
    let _ = writeln!(out, "product:   {}", or_dash(&preset.product));
    let _ = writeln!(out, "firmware:  {}", or_dash(&preset.firmware));
    match preset.tempo {
        Some(tempo) => {
            let _ = writeln!(out, "tempo:     {tempo} BPM");
        }
        None => {
            let _ = writeln!(out, "tempo:     -");
        }
    }
    let _ = writeln!(
        out,
        "snapshots: {} (current: {})",
        preset.snapshots.len(),
        preset
            .current_snapshot
            .map_or_else(|| "-".to_owned(), |v| v.to_string())
    );
    let _ = writeln!(out, "chain:     {} entries", preset.chain.len());
    for (index, entry) in preset.chain.iter().enumerate() {
        let _ = writeln!(out, "  {index:>2}  {}", describe_entry(entry));
    }
    let _ = writeln!(
        out,
        "round-trip: {} ({} -> {} bytes)",
        if report.byte_identical {
            "byte-identical"
        } else {
            "DIFFERS"
        },
        report.original_len,
        report.reencoded_len
    );
    out
}

fn describe_entry(entry: &ChainEntry) -> String {
    match entry {
        ChainEntry::Input { params } => format!("input ({} params)", params.len()),
        ChainEntry::Output { params } => format!("output ({} params)", params.len()),
        ChainEntry::Block(block) => format!(
            "block model={} enabled={} params={} category={}",
            block.model_id,
            block.enabled,
            block.params.len(),
            block
                .category
                .map_or_else(|| "-".to_owned(), |v| v.to_string())
        ),
        ChainEntry::Looper {
            model_id,
            enabled,
            params,
        } => format!(
            "looper model={} enabled={} params={}",
            model_id.map_or_else(|| "-".to_owned(), |v| v.to_string()),
            enabled,
            params.len()
        ),
        ChainEntry::Empty => "empty".to_owned(),
        ChainEntry::Unknown { class } => format!("unknown class={class}"),
    }
}

fn or_dash(value: &str) -> &str {
    if value.is_empty() {
        "-"
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../../../fixtures/spec02_obj22_blob.bin");

    #[test]
    fn fixture_inspects_and_round_trips() {
        let report = inspect(FIXTURE).expect("fixture inspects");
        assert_eq!(report.preset.product, "P34");
        assert_eq!(report.preset.firmware, "v2.00-5-g665e64e");
        assert_eq!(report.preset.chain.len(), 12);
        assert!(report.byte_identical);
        assert_eq!(report.original_len, report.reencoded_len);
    }

    #[test]
    fn report_lists_every_chain_entry() {
        let report = inspect(FIXTURE).unwrap();
        let text = render(&report);
        assert!(text.contains("round-trip: byte-identical"));
        assert!(text.contains(" input "));
        assert!(text.contains(" output "));
        assert!(text.contains("block model=224 enabled=true"));
        assert!(text.contains(" empty"));
    }

    #[test]
    fn malformed_input_is_an_error_not_a_panic() {
        let err = inspect(b"not a preset").unwrap_err();
        assert!(matches!(err, DomainError::InvalidContainer(_)));
    }

    const SETLIST: &[u8] = include_bytes!("../../../fixtures/user_setlist.bin");

    #[test]
    fn setlist_fixture_parses_with_slot_order() {
        let report = inspect_setlist(SETLIST).expect("setlist inspects");
        assert_eq!(report.entries.len(), 128);
        assert_eq!(report.raw_len, SETLIST.len());
        assert_eq!(report.entries[0].slot, 0);
        assert_eq!(report.entries[0].index, 128);
        assert_eq!(report.entries[0].name, "Preset 000");
        assert_eq!(report.entries[36].index, 129);
    }

    #[test]
    fn setlist_report_renders_every_entry() {
        let text = render_setlist(&inspect_setlist(SETLIST).unwrap());
        assert!(text.contains("setlist:   128 entries"));
        assert!(text.contains("slot   0  id 128  Preset 000"));
        assert!(text.contains("slot 127"));
    }

    #[test]
    fn malformed_setlist_is_an_error_not_a_panic() {
        assert!(matches!(
            inspect_setlist(b"no entries"),
            Err(DomainError::InvalidContainer(_))
        ));
    }
}
