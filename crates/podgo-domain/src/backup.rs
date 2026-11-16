//! Versioned, byte-preserving backup container (`.pgbak`).
//!
//! A backup stores raw `l6-helix` preset bodies exactly as the pedal returned
//! them, together with the setlist, slot and display name they belonged to.
//! Nothing is decoded or re-encoded, so an unmodified preset restores byte for
//! byte. The file is deliberately simple and self-checking:
//!
//! ```text
//! 0..8    magic "PODGOBK\0"
//! 8..10   format version (u16 LE, currently 1)
//! 10..12  flags (u16 LE, must be 0)
//! 12..16  entry count (u32 LE)
//! 16..18  product length (u16 LE)
//! 18..20  firmware length (u16 LE)
//! 20..24  total file length (u32 LE)
//! 24..64  reserved zeros
//! ...     product bytes, firmware bytes
//! ...     entries, sorted by (setlist, slot)
//! last 32 SHA-256 of every preceding byte
//! ```
//!
//! Each entry is:
//!
//! ```text
//! setlist u8 | slot u8 | name length u8 | flags u8
//! blob length u32 LE | name bytes | blob bytes | SHA-256(blob) (32 bytes)
//! ```
//!
//! The whole-file digest detects truncation and tampering; the per-entry digest
//! lets the restore flow verify one slot before sending it. The format carries
//! no timestamps, so encoding the same content always produces the same bytes.

use crate::error::DomainError;
use crate::sha256::{self, DIGEST_LEN};

/// Container magic, including the trailing NUL.
pub const MAGIC: [u8; 8] = *b"PODGOBK\0";
/// Current format version.
pub const VERSION: u16 = 1;
/// Fixed header length.
pub const HEADER_LEN: usize = 64;
/// Whole-file digest length at the end of the file.
pub const FOOTER_LEN: usize = DIGEST_LEN;
/// Maximum number of preset entries (two setlists of 128 slots).
pub const MAX_ENTRIES: usize = 256;
/// Maximum product string length.
pub const MAX_PRODUCT_BYTES: usize = 32;
/// Maximum firmware string length.
pub const MAX_FIRMWARE_BYTES: usize = 64;
/// Maximum preset name length.
pub const MAX_NAME_BYTES: usize = 64;
/// Maximum raw preset body accepted in one entry.
pub const MAX_BLOB_BYTES: usize = 64 * 1024;
/// Maximum complete backup file size.
pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

/// One preset in a backup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupEntry {
    /// `0` = Factory, `1` = User.
    pub setlist: u8,
    /// Slot position in the setlist (`0..=127`).
    pub slot: u8,
    /// Display name stored in the setlist.
    pub name: String,
    /// Raw `l6-helix` body, preserved byte for byte.
    pub blob: Vec<u8>,
}

impl BackupEntry {
    /// SHA-256 of the raw preset body.
    #[must_use]
    pub fn blob_digest(&self) -> [u8; DIGEST_LEN] {
        sha256::digest(&self.blob)
    }
}

/// A decoded or in-memory full backup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backup {
    /// Product id string from the preset metadata (`P34`, …).
    pub product: String,
    /// Firmware/build string from the preset metadata.
    pub firmware: String,
    /// Presets, sorted by `(setlist, slot)` after construction.
    pub entries: Vec<BackupEntry>,
}

impl Backup {
    /// Create an empty backup.
    #[must_use]
    pub fn new(product: impl Into<String>, firmware: impl Into<String>) -> Self {
        Self {
            product: product.into(),
            firmware: firmware.into(),
            entries: Vec::new(),
        }
    }

    /// Add one preset.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidContainer`] for an unknown setlist, a slot
    /// above 127, an over-long name or body, or a duplicate destination slot.
    pub fn add(
        &mut self,
        setlist: u8,
        slot: u8,
        name: impl Into<String>,
        blob: impl Into<Vec<u8>>,
    ) -> Result<(), DomainError> {
        let name = name.into();
        let blob = blob.into();
        validate_entry(setlist, slot, &name, &blob)?;
        if self
            .entries
            .iter()
            .any(|entry| entry.setlist == setlist && entry.slot == slot)
        {
            return Err(DomainError::InvalidContainer(
                "backup contains a duplicate setlist slot",
            ));
        }
        if self.entries.len() >= MAX_ENTRIES {
            return Err(DomainError::InvalidContainer(
                "backup contains too many entries",
            ));
        }
        self.entries.push(BackupEntry {
            setlist,
            slot,
            name,
            blob,
        });
        self.entries
            .sort_by_key(|entry| (entry.setlist, entry.slot));
        Ok(())
    }

    /// Number of preset entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when the backup holds no preset.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Sum of all raw preset body lengths.
    #[must_use]
    pub fn total_blob_bytes(&self) -> usize {
        self.entries.iter().map(|entry| entry.blob.len()).sum()
    }

    /// Entries for one setlist, in slot order.
    pub fn entries_for(&self, setlist: u8) -> impl Iterator<Item = &BackupEntry> {
        self.entries
            .iter()
            .filter(move |entry| entry.setlist == setlist)
    }

    /// Encode the backup.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidContainer`] when the product, firmware or
    /// any entry exceeds its limit, or the complete file would be too large.
    pub fn encode(&self) -> Result<Vec<u8>, DomainError> {
        let product = self.product.as_bytes();
        let firmware = self.firmware.as_bytes();
        if product.len() > MAX_PRODUCT_BYTES {
            return Err(DomainError::InvalidContainer("backup product is too long"));
        }
        if firmware.len() > MAX_FIRMWARE_BYTES {
            return Err(DomainError::InvalidContainer("backup firmware is too long"));
        }
        if self.entries.len() > MAX_ENTRIES {
            return Err(DomainError::InvalidContainer(
                "backup contains too many entries",
            ));
        }

        let mut entries: Vec<&BackupEntry> = self.entries.iter().collect();
        entries.sort_by_key(|entry| (entry.setlist, entry.slot));

        let mut out = vec![0u8; HEADER_LEN];
        out.extend_from_slice(product);
        out.extend_from_slice(firmware);
        for entry in entries {
            validate_entry(entry.setlist, entry.slot, &entry.name, &entry.blob)?;
            out.push(entry.setlist);
            out.push(entry.slot);
            out.push(
                u8::try_from(entry.name.len())
                    .map_err(|_| DomainError::InvalidContainer("backup entry name is too long"))?,
            );
            out.push(0);
            out.extend_from_slice(
                &u32::try_from(entry.blob.len())
                    .map_err(|_| DomainError::InvalidContainer("backup entry is too large"))?
                    .to_le_bytes(),
            );
            out.extend_from_slice(entry.name.as_bytes());
            out.extend_from_slice(&entry.blob);
            out.extend_from_slice(&entry.blob_digest());
        }

        let total = out.len() + FOOTER_LEN;
        if total > MAX_FILE_BYTES {
            return Err(DomainError::InvalidContainer("backup file is too large"));
        }

        out[0..8].copy_from_slice(&MAGIC);
        out[8..10].copy_from_slice(&VERSION.to_le_bytes());
        out[10..12].copy_from_slice(&0u16.to_le_bytes());
        out[12..16].copy_from_slice(
            &u32::try_from(self.entries.len())
                .map_err(|_| DomainError::InvalidContainer("backup contains too many entries"))?
                .to_le_bytes(),
        );
        out[16..18].copy_from_slice(
            &u16::try_from(product.len())
                .map_err(|_| DomainError::InvalidContainer("backup product is too long"))?
                .to_le_bytes(),
        );
        out[18..20].copy_from_slice(
            &u16::try_from(firmware.len())
                .map_err(|_| DomainError::InvalidContainer("backup firmware is too long"))?
                .to_le_bytes(),
        );
        out[20..24].copy_from_slice(
            &u32::try_from(total)
                .map_err(|_| DomainError::InvalidContainer("backup file is too large"))?
                .to_le_bytes(),
        );

        let digest = sha256::digest(&out);
        out.extend_from_slice(&digest);
        Ok(out)
    }

    /// Decode and fully verify a backup.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidContainer`] for a wrong magic or version,
    /// an out-of-bounds field, a duplicate slot, a malformed entry or a digest
    /// mismatch. No partially trusted data is returned.
    pub fn decode(bytes: &[u8]) -> Result<Self, DomainError> {
        if bytes.len() < HEADER_LEN + FOOTER_LEN {
            return Err(DomainError::InvalidContainer("backup file is too short"));
        }
        if bytes.len() > MAX_FILE_BYTES {
            return Err(DomainError::InvalidContainer("backup file is too large"));
        }
        if bytes[0..8] != MAGIC {
            return Err(DomainError::InvalidContainer("backup magic is not PODGOBK"));
        }
        let version = u16::from_le_bytes([bytes[8], bytes[9]]);
        if version != VERSION {
            return Err(DomainError::InvalidContainer(
                "unsupported backup format version",
            ));
        }
        let flags = u16::from_le_bytes([bytes[10], bytes[11]]);
        if flags != 0 {
            return Err(DomainError::InvalidContainer(
                "unsupported backup format flags",
            ));
        }

        let body_len = bytes.len() - FOOTER_LEN;
        let stored = &bytes[body_len..];
        let computed = sha256::digest(&bytes[..body_len]);
        if stored != computed {
            return Err(DomainError::InvalidContainer("backup digest mismatch"));
        }

        let entry_count = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
        if entry_count > MAX_ENTRIES {
            return Err(DomainError::InvalidContainer(
                "backup contains too many entries",
            ));
        }
        let product_len = u16::from_le_bytes([bytes[16], bytes[17]]) as usize;
        let firmware_len = u16::from_le_bytes([bytes[18], bytes[19]]) as usize;
        if product_len > MAX_PRODUCT_BYTES || firmware_len > MAX_FIRMWARE_BYTES {
            return Err(DomainError::InvalidContainer(
                "backup metadata length is out of range",
            ));
        }
        let total = u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]) as usize;
        if total != bytes.len() {
            return Err(DomainError::InvalidContainer(
                "backup length field does not match the file",
            ));
        }

        let mut cursor = HEADER_LEN;
        let product = read_string(
            bytes,
            &mut cursor,
            product_len,
            "backup product is not UTF-8",
        )?;
        let firmware = read_string(
            bytes,
            &mut cursor,
            firmware_len,
            "backup firmware is not UTF-8",
        )?;

        let mut entries = Vec::with_capacity(entry_count);
        let mut seen = [false; MAX_ENTRIES];
        for _ in 0..entry_count {
            let header = take(bytes, &mut cursor, 8, "backup entry header is truncated")?;
            let setlist = header[0];
            let slot = header[1];
            let name_len = header[2] as usize;
            if setlist > 1 {
                return Err(DomainError::InvalidContainer(
                    "backup entry setlist is out of range",
                ));
            }
            if slot >= 128 {
                return Err(DomainError::InvalidContainer(
                    "backup entry slot is out of range",
                ));
            }
            if name_len > MAX_NAME_BYTES {
                return Err(DomainError::InvalidContainer(
                    "backup entry name is too long",
                ));
            }
            let blob_len =
                u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
            if blob_len > MAX_BLOB_BYTES {
                return Err(DomainError::InvalidContainer("backup entry is too large"));
            }
            let name_bytes = take(
                bytes,
                &mut cursor,
                name_len,
                "backup entry name is truncated",
            )?;
            let name = std::str::from_utf8(name_bytes)
                .map_err(|_| DomainError::InvalidContainer("backup entry name is not UTF-8"))?
                .to_owned();
            let blob = take(
                bytes,
                &mut cursor,
                blob_len,
                "backup entry body is truncated",
            )?;
            let digest = take(
                bytes,
                &mut cursor,
                DIGEST_LEN,
                "backup entry digest is truncated",
            )?;
            if digest != sha256::digest(blob) {
                return Err(DomainError::InvalidContainer(
                    "backup entry digest mismatch",
                ));
            }
            let index = usize::from(setlist) * 128 + usize::from(slot);
            if seen[index] {
                return Err(DomainError::InvalidContainer(
                    "backup contains a duplicate setlist slot",
                ));
            }
            seen[index] = true;
            validate_entry(setlist, slot, &name, blob)?;
            entries.push(BackupEntry {
                setlist,
                slot,
                name,
                blob: blob.to_vec(),
            });
        }

        if cursor != body_len {
            return Err(DomainError::InvalidContainer(
                "backup has trailing bytes before the digest",
            ));
        }

        entries.sort_by_key(|entry| (entry.setlist, entry.slot));
        Ok(Self {
            product,
            firmware,
            entries,
        })
    }
}

fn validate_entry(setlist: u8, slot: u8, name: &str, blob: &[u8]) -> Result<(), DomainError> {
    if setlist > 1 {
        return Err(DomainError::InvalidContainer(
            "backup entry setlist is out of range",
        ));
    }
    if slot >= 128 {
        return Err(DomainError::InvalidContainer(
            "backup entry slot is out of range",
        ));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(DomainError::InvalidContainer(
            "backup entry name is too long",
        ));
    }
    if blob.len() > MAX_BLOB_BYTES {
        return Err(DomainError::InvalidContainer("backup entry is too large"));
    }
    Ok(())
}

fn take<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
    message: &'static str,
) -> Result<&'a [u8], DomainError> {
    let end = cursor
        .checked_add(length)
        .ok_or(DomainError::LengthOverflow)?;
    if end > bytes.len() {
        return Err(DomainError::InvalidContainer(message));
    }
    let slice = &bytes[*cursor..end];
    *cursor = end;
    Ok(slice)
}

fn read_string(
    bytes: &[u8],
    cursor: &mut usize,
    length: usize,
    message: &'static str,
) -> Result<String, DomainError> {
    let slice = take(bytes, cursor, length, message)?;
    std::str::from_utf8(slice)
        .map(str::to_owned)
        .map_err(|_| DomainError::InvalidContainer(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Backup {
        let mut backup = Backup::new("P34", "v2.50");
        backup
            .add(
                1,
                7,
                "Lead",
                vec![0xa9, b'l', b'6', b'-', b'h', b'e', b'l', b'i', b'x', 0],
            )
            .unwrap();
        backup.add(0, 3, "US Deluxe", vec![1, 2, 3, 4]).unwrap();
        backup
    }

    #[test]
    fn round_trip_preserves_every_byte() {
        let backup = sample();
        let bytes = backup.encode().unwrap();
        let decoded = Backup::decode(&bytes).unwrap();
        assert_eq!(decoded.product, "P34");
        assert_eq!(decoded.firmware, "v2.50");
        assert_eq!(decoded.entries.len(), 2);
        assert_eq!(decoded.entries[0].setlist, 0);
        assert_eq!(decoded.entries[0].slot, 3);
        assert_eq!(decoded.entries[1].setlist, 1);
        assert_eq!(decoded.entries[1].slot, 7);
        assert_eq!(decoded.entries[1].name, "Lead");
        assert_eq!(decoded.entries[1].blob, sample().entries[1].blob);
        assert_eq!(backup.encode().unwrap(), bytes);
    }

    #[test]
    fn digest_is_the_footer_and_covers_the_file() {
        let bytes = sample().encode().unwrap();
        let digest = sha256::digest(&bytes[..bytes.len() - FOOTER_LEN]);
        assert_eq!(&bytes[bytes.len() - FOOTER_LEN..], &digest);
    }

    #[test]
    fn duplicate_slots_are_rejected_before_encoding() {
        let mut backup = sample();
        let err = backup.add(1, 7, "Other", vec![9]).unwrap_err();
        assert!(err.to_string().contains("duplicate"), "{err}");
    }

    #[test]
    fn tampering_the_digest_or_body_is_rejected() {
        let bytes = sample().encode().unwrap();
        let mut changed = bytes.clone();
        changed[HEADER_LEN + 4] ^= 0xff;
        assert!(Backup::decode(&changed).is_err());

        let mut truncated = bytes.clone();
        truncated.pop();
        assert!(Backup::decode(&truncated).is_err());

        let mut bad_magic = bytes.clone();
        bad_magic[0] = b'X';
        assert!(Backup::decode(&bad_magic).is_err());
    }

    #[test]
    fn out_of_range_entries_are_rejected() {
        let mut backup = Backup::new("", "");
        assert!(backup.add(2, 0, "x", vec![1]).is_err());
        assert!(backup.add(0, 128, "x", vec![1]).is_err());
        assert!(backup
            .add(0, 0, "x".repeat(MAX_NAME_BYTES + 1), vec![1])
            .is_err());
        assert!(backup.add(0, 0, "x", vec![0; MAX_BLOB_BYTES + 1]).is_err());
    }

    #[test]
    fn empty_backup_round_trips() {
        let bytes = Backup::new("", "").encode().unwrap();
        let decoded = Backup::decode(&bytes).unwrap();
        assert!(decoded.is_empty());
    }
}
