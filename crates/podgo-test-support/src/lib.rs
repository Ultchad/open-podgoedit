//! Test helpers shared by the workspace.
//!
//! These helpers never touch hardware. They load fixtures from the repository
//! `fixtures/` directory and build frames in the shapes observed in the
//! reference project.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::path::PathBuf;

/// Absolute path to the repository `fixtures/` directory.
#[must_use]
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("fixtures")
}

/// Load a fixture by file name.
///
/// # Errors
///
/// Returns the underlying [`std::io::Error`] if the file cannot be read.
pub fn load_fixture(name: &str) -> std::io::Result<Vec<u8>> {
    std::fs::read(fixtures_dir().join(name))
}

/// Build a read-channel framed response around a MessagePack body.
#[must_use]
pub fn framed_response(body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0u8; 16];
    bytes[3] = 0x18;
    bytes[4..6].copy_from_slice(&0x03EFu16.to_le_bytes());
    bytes[6..8].copy_from_slice(&0x1001u16.to_le_bytes());
    bytes[11] = 0x04;
    bytes.extend_from_slice(&[0x01, 0x00, 0x02, 0x00]);
    bytes.extend_from_slice(&(body.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&[0x00, 0x00]);
    bytes.extend_from_slice(body);
    bytes
}

/// Build the five bare acknowledgements used by the read handshake.
#[must_use]
pub fn handshake_acks() -> Vec<Vec<u8>> {
    [20usize, 28, 16, 36, 16]
        .into_iter()
        .map(|len| vec![0u8; len])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixtures_are_reachable() {
        let bytes = load_fixture("spec02_obj22_blob.bin").unwrap();
        assert_eq!(&bytes[..10], b"\xa9l6-helix\0");
    }

    #[test]
    fn framed_response_has_declared_length() {
        let frame = framed_response(&[0xc0]);
        assert_eq!(&frame[16..20], &[0x01, 0x00, 0x02, 0x00]);
        assert_eq!(&frame[20..22], &1u16.to_le_bytes());
        assert_eq!(frame[24], 0xc0);
    }
}
