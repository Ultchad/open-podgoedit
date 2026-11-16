//! Transport-independent domain model for POD Go presets.
//!
//! The central invariant of this crate is **byte preservation**: a preset that
//! is decoded and re-encoded without modification must produce identical bytes.
//! This is why the MessagePack codec keeps integer widths, string/binary
//! markers and map order instead of normalising them.
//!
//! Evidence: `docs/reverse-engineering/protocol-specification.md` and
//! `docs/protocol/presets.md`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod backup;
pub mod error;
pub mod l6helix;
pub mod msgpack;
pub mod preset_list;
pub mod sha256;

pub use backup::{Backup, BackupEntry};
pub use error::DomainError;
pub use l6helix::{Block, ChainEntry, Container, Preset, Snapshot};
pub use msgpack::Value;
pub use preset_list::{parse_preset_list, scan_preset_entries, PresetEntry};
