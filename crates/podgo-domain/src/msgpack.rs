//! A small, byte-preserving MessagePack codec.
//!
//! The device sends MessagePack maps whose integer widths are not canonical:
//! for example the fixture stores `0` as `cc 00` (uint8) rather than the
//! positive fixint `00`. A normalising encoder would change bytes on an
//! otherwise unmodified preset. To keep round-trips exact, [`Value`] records
//! the width class of every scalar and container.
//!
//! When a value is mutated so that its stored width no longer fits, the
//! encoder falls back to the smallest safe representation. This is a
//! deliberate, documented trade-off: byte identity is guaranteed for
//! *unmodified* values, correctness for modified ones.
//!
//! Evidence: `docs/protocol/presets.md`, fixtures in `fixtures/`.

use crate::error::DomainError;

/// Maximum nesting depth accepted by the decoder.
pub const MAX_DEPTH: usize = 64;

/// Maximum number of elements accepted in a single array or map.
pub const MAX_CONTAINER_ITEMS: usize = 1_000_000;

/// A MessagePack value that preserves its wire representation width.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// `nil`.
    Nil,
    /// Boolean.
    Bool(bool),
    /// Unsigned integer with its original width class.
    ///
    /// `width` uses MessagePack byte-size classes: `1` = positive fixint,
    /// `2` = uint8, `3` = uint16, `5` = uint32, `9` = uint64.
    UInt {
        /// Numeric value.
        value: u64,
        /// Original width class.
        width: u8,
    },
    /// Signed integer with its original width class.
    ///
    /// `width` uses MessagePack byte-size classes: `1` = negative fixint,
    /// `2` = int8, `3` = int16, `5` = int32, `9` = int64.
    Int {
        /// Numeric value.
        value: i64,
        /// Original width class.
        width: u8,
    },
    /// IEEE-754 single precision float (`0xca`).
    F32(f32),
    /// IEEE-754 double precision float (`0xcb`).
    F64(f64),
    /// MessagePack `str` payload with its original width class (`0` fixstr,
    /// `1`/`2`/`3`).
    ///
    /// The payload is kept as bytes, not as a `String`: the device stores
    /// binary data (the `l6-helix` container, preset names, `.pgp` blobs) in
    /// `str` markers, and those bytes are not always valid UTF-8. Decoding
    /// eagerly would reject perfectly good presets and could not round-trip
    /// them. Use [`Value::as_str`] when the payload is known to be text.
    Str {
        /// Raw payload bytes.
        value: Vec<u8>,
        /// Original width class.
        width: u8,
    },
    /// Binary blob with its original width class (`1`/`2`/`3`).
    Bin {
        /// Raw bytes.
        value: Vec<u8>,
        /// Original width class.
        width: u8,
    },
    /// Array with its original width class (`0` fixarray, `2`/`4`).
    Array {
        /// Elements.
        items: Vec<Value>,
        /// Original width class.
        width: u8,
    },
    /// Map with its original width class and entry order.
    Map {
        /// Entries in wire order.
        entries: Vec<(Value, Value)>,
        /// Original width class.
        width: u8,
    },
    /// MessagePack extension value.
    Ext {
        /// Extension type id.
        type_id: i8,
        /// Extension payload.
        data: Vec<u8>,
    },
}

impl Value {
    /// Build an unsigned value using the smallest canonical width.
    #[must_use]
    pub fn uint(value: u64) -> Self {
        let width = if value <= 0x7f {
            1
        } else if value <= 0xff {
            2
        } else if value <= 0xffff {
            3
        } else if value <= 0xffff_ffff {
            5
        } else {
            9
        };
        Self::UInt { value, width }
    }

    /// Build a signed value using the smallest canonical width.
    #[must_use]
    pub fn int(value: i64) -> Self {
        let width = if (-32..=-1).contains(&value) {
            1
        } else if (-128..=127).contains(&value) {
            2
        } else if (-32_768..=32_767).contains(&value) {
            3
        } else if (-2_147_483_648..=2_147_483_647).contains(&value) {
            5
        } else {
            9
        };
        Self::Int { value, width }
    }

    /// Build a string value using the smallest canonical width.
    #[must_use]
    pub fn str(value: impl Into<String>) -> Self {
        Self::str_bytes(value.into().into_bytes())
    }

    /// Build a `str` value from raw bytes using the smallest canonical width.
    #[must_use]
    pub fn str_bytes(value: impl Into<Vec<u8>>) -> Self {
        let value = value.into();
        let width = if value.len() <= 31 {
            0
        } else if value.len() <= 0xff {
            1
        } else if value.len() <= 0xffff {
            2
        } else {
            3
        };
        Self::Str { value, width }
    }

    /// Build a binary value using the smallest canonical width.
    #[must_use]
    pub fn bin(value: impl Into<Vec<u8>>) -> Self {
        let value = value.into();
        let width = if value.len() <= 0xff {
            1
        } else if value.len() <= 0xffff {
            2
        } else {
            3
        };
        Self::Bin { value, width }
    }

    /// Build an array with the smallest canonical width.
    #[must_use]
    pub fn array(items: Vec<Value>) -> Self {
        let width = if items.len() <= 15 {
            0
        } else if items.len() <= 0xffff {
            2
        } else {
            4
        };
        Self::Array { items, width }
    }

    /// Build a map with the smallest canonical width.
    #[must_use]
    pub fn map(entries: Vec<(Value, Value)>) -> Self {
        let width = if entries.len() <= 15 {
            0
        } else if entries.len() <= 0xffff {
            2
        } else {
            4
        };
        Self::Map { entries, width }
    }

    /// Return the value as `u64` if it is an unsigned integer.
    #[must_use]
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::UInt { value, .. } => Some(*value),
            _ => None,
        }
    }

    /// Return the value as `i64` if it is any integer.
    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::UInt { value, .. } => i64::try_from(*value).ok(),
            Self::Int { value, .. } => Some(*value),
            _ => None,
        }
    }

    /// Return the value as `f64` if it is numeric.
    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::UInt { value, .. } => Some(*value as f64),
            Self::Int { value, .. } => Some(*value as f64),
            Self::F32(v) => Some(f64::from(*v)),
            Self::F64(v) => Some(*v),
            _ => None,
        }
    }

    /// Return the value as `bool` if it is a boolean.
    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(v) => Some(*v),
            _ => None,
        }
    }

    /// Return the value as a string slice if it is a string.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str { value, .. } => std::str::from_utf8(value).ok(),
            _ => None,
        }
    }

    /// Return the raw `str` payload if this is a `str` value.
    #[must_use]
    pub fn as_str_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Str { value, .. } => Some(value),
            _ => None,
        }
    }

    /// Return the value as bytes if it is binary.
    #[must_use]
    pub fn as_bin(&self) -> Option<&[u8]> {
        match self {
            Self::Bin { value, .. } => Some(value),
            _ => None,
        }
    }

    /// Return the value as a slice if it is an array.
    #[must_use]
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Self::Array { items, .. } => Some(items),
            _ => None,
        }
    }

    /// Return the value as entries if it is a map.
    #[must_use]
    pub fn as_map(&self) -> Option<&[(Value, Value)]> {
        match self {
            Self::Map { entries, .. } => Some(entries),
            _ => None,
        }
    }

    /// Look up a map entry by unsigned integer key.
    ///
    /// Comparison is by numeric value, not by stored width, because the device
    /// may encode the same key with different widths.
    #[must_use]
    pub fn get_u64(&self, key: u64) -> Option<&Value> {
        self.as_map()?
            .iter()
            .find(|(k, _)| k.as_u64() == Some(key))
            .map(|(_, v)| v)
    }
}

/// Decode a complete MessagePack value, rejecting trailing bytes.
pub fn decode(input: &[u8]) -> Result<Value, DomainError> {
    let (value, used) = decode_prefix(input)?;
    if used != input.len() {
        return Err(DomainError::InvalidContainer(
            "trailing bytes after MessagePack value",
        ));
    }
    Ok(value)
}

/// Decode one MessagePack value and return it with the number of bytes consumed.
pub fn decode_prefix(input: &[u8]) -> Result<(Value, usize), DomainError> {
    let mut decoder = Decoder::new(input);
    let value = decoder.decode()?;
    Ok((value, decoder.position()))
}

/// Streaming MessagePack decoder.
pub struct Decoder<'a> {
    input: &'a [u8],
    pos: usize,
    max_depth: usize,
}

impl<'a> Decoder<'a> {
    /// Create a decoder for `input`.
    #[must_use]
    pub fn new(input: &'a [u8]) -> Self {
        Self {
            input,
            pos: 0,
            max_depth: MAX_DEPTH,
        }
    }

    /// Override the maximum nesting depth.
    #[must_use]
    pub fn with_max_depth(mut self, max_depth: usize) -> Self {
        self.max_depth = max_depth;
        self
    }

    /// Current byte offset.
    #[must_use]
    pub fn position(&self) -> usize {
        self.pos
    }

    /// Decode one value.
    pub fn decode(&mut self) -> Result<Value, DomainError> {
        self.decode_value(0)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], DomainError> {
        let end = self.pos.checked_add(n).ok_or(DomainError::LengthOverflow)?;
        if end > self.input.len() {
            return Err(DomainError::UnexpectedEof {
                offset: self.pos,
                needed: n,
            });
        }
        let slice = &self.input[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn read_u8(&mut self) -> Result<u8, DomainError> {
        Ok(self.take(1)?[0])
    }

    fn read_u16(&mut self) -> Result<u16, DomainError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn read_u32(&mut self) -> Result<u32, DomainError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_u64(&mut self) -> Result<u64, DomainError> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn check_count(&self, count: usize) -> Result<(), DomainError> {
        if count > MAX_CONTAINER_ITEMS {
            return Err(DomainError::ContainerTooLarge {
                count,
                limit: MAX_CONTAINER_ITEMS,
            });
        }
        Ok(())
    }

    fn decode_value(&mut self, depth: usize) -> Result<Value, DomainError> {
        if depth > self.max_depth {
            return Err(DomainError::DepthLimit {
                limit: self.max_depth,
            });
        }
        let marker = self.read_u8()?;
        match marker {
            0x00..=0x7f => Ok(Value::UInt {
                value: u64::from(marker),
                width: 1,
            }),
            0x80..=0x8f => self.decode_map(usize::from(marker & 0x0f), 0, depth),
            0x90..=0x9f => self.decode_array(usize::from(marker & 0x0f), 0, depth),
            0xa0..=0xbf => self.decode_str(usize::from(marker & 0x1f), 0),
            0xc0 => Ok(Value::Nil),
            0xc1 => Err(DomainError::InvalidMarker(marker)),
            0xc2 => Ok(Value::Bool(false)),
            0xc3 => Ok(Value::Bool(true)),
            0xc4 => {
                let n = usize::from(self.read_u8()?);
                self.decode_bin(n, 1)
            }
            0xc5 => {
                let n = usize::from(self.read_u16()?);
                self.decode_bin(n, 2)
            }
            0xc6 => {
                let n =
                    usize::try_from(self.read_u32()?).map_err(|_| DomainError::LengthOverflow)?;
                self.decode_bin(n, 3)
            }
            0xc7 => {
                let n = usize::from(self.read_u8()?);
                self.decode_ext(n)
            }
            0xc8 => {
                let n = usize::from(self.read_u16()?);
                self.decode_ext(n)
            }
            0xc9 => {
                let n =
                    usize::try_from(self.read_u32()?).map_err(|_| DomainError::LengthOverflow)?;
                self.decode_ext(n)
            }
            0xca => {
                let b = self.take(4)?;
                Ok(Value::F32(f32::from_be_bytes([b[0], b[1], b[2], b[3]])))
            }
            0xcb => {
                let b = self.take(8)?;
                Ok(Value::F64(f64::from_be_bytes([
                    b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                ])))
            }
            0xcc => Ok(Value::UInt {
                value: u64::from(self.read_u8()?),
                width: 2,
            }),
            0xcd => Ok(Value::UInt {
                value: u64::from(self.read_u16()?),
                width: 3,
            }),
            0xce => Ok(Value::UInt {
                value: u64::from(self.read_u32()?),
                width: 5,
            }),
            0xcf => Ok(Value::UInt {
                value: self.read_u64()?,
                width: 9,
            }),
            0xd0 => Ok(Value::Int {
                value: i64::from(self.read_u8()? as i8),
                width: 2,
            }),
            0xd1 => Ok(Value::Int {
                value: i64::from(self.read_u16()? as i16),
                width: 3,
            }),
            0xd2 => Ok(Value::Int {
                value: i64::from(self.read_u32()? as i32),
                width: 5,
            }),
            0xd3 => Ok(Value::Int {
                value: self.read_u64()? as i64,
                width: 9,
            }),
            0xd4..=0xd8 => {
                let n = 1usize << (marker - 0xd4);
                self.decode_ext(n)
            }
            0xd9 => {
                let n = usize::from(self.read_u8()?);
                self.decode_str(n, 1)
            }
            0xda => {
                let n = usize::from(self.read_u16()?);
                self.decode_str(n, 2)
            }
            0xdb => {
                let n =
                    usize::try_from(self.read_u32()?).map_err(|_| DomainError::LengthOverflow)?;
                self.decode_str(n, 3)
            }
            0xdc => {
                let n = usize::from(self.read_u16()?);
                self.decode_array(n, 2, depth)
            }
            0xdd => {
                let n =
                    usize::try_from(self.read_u32()?).map_err(|_| DomainError::LengthOverflow)?;
                self.decode_array(n, 4, depth)
            }
            0xde => {
                let n = usize::from(self.read_u16()?);
                self.decode_map(n, 2, depth)
            }
            0xdf => {
                let n =
                    usize::try_from(self.read_u32()?).map_err(|_| DomainError::LengthOverflow)?;
                self.decode_map(n, 4, depth)
            }
            0xe0..=0xff => Ok(Value::Int {
                value: i64::from(marker as i8),
                width: 1,
            }),
        }
    }

    fn decode_str(&mut self, len: usize, width: u8) -> Result<Value, DomainError> {
        Ok(Value::Str {
            value: self.take(len)?.to_vec(),
            width,
        })
    }

    fn decode_bin(&mut self, len: usize, width: u8) -> Result<Value, DomainError> {
        Ok(Value::Bin {
            value: self.take(len)?.to_vec(),
            width,
        })
    }

    fn decode_ext(&mut self, len: usize) -> Result<Value, DomainError> {
        let type_id = self.read_u8()? as i8;
        Ok(Value::Ext {
            type_id,
            data: self.take(len)?.to_vec(),
        })
    }

    fn decode_array(
        &mut self,
        count: usize,
        width: u8,
        depth: usize,
    ) -> Result<Value, DomainError> {
        self.check_count(count)?;
        let mut items = Vec::with_capacity(count.min(4096));
        for _ in 0..count {
            items.push(self.decode_value(depth + 1)?);
        }
        Ok(Value::Array { items, width })
    }

    fn decode_map(&mut self, count: usize, width: u8, depth: usize) -> Result<Value, DomainError> {
        self.check_count(count)?;
        let mut entries = Vec::with_capacity(count.min(4096));
        for _ in 0..count {
            let key = self.decode_value(depth + 1)?;
            let value = self.decode_value(depth + 1)?;
            entries.push((key, value));
        }
        Ok(Value::Map { entries, width })
    }
}

/// Encode a value to a new byte vector.
pub fn encode(value: &Value) -> Result<Vec<u8>, DomainError> {
    let mut out = Vec::new();
    encode_into(value, &mut out)?;
    Ok(out)
}

/// Encode a value into an existing byte vector.
pub fn encode_into(value: &Value, out: &mut Vec<u8>) -> Result<(), DomainError> {
    match value {
        Value::Nil => out.push(0xc0),
        Value::Bool(true) => out.push(0xc3),
        Value::Bool(false) => out.push(0xc2),
        Value::UInt { value, width } => encode_uint(*value, *width, out),
        Value::Int { value, width } => encode_int(*value, *width, out),
        Value::F32(v) => {
            out.push(0xca);
            out.extend_from_slice(&v.to_be_bytes());
        }
        Value::F64(v) => {
            out.push(0xcb);
            out.extend_from_slice(&v.to_be_bytes());
        }
        Value::Str { value, width } => encode_str(value, *width, out),
        Value::Bin { value, width } => encode_bin(value, *width, out),
        Value::Array { items, width } => {
            encode_array_header(items.len(), *width, out);
            for item in items {
                encode_into(item, out)?;
            }
        }
        Value::Map { entries, width } => {
            encode_map_header(entries.len(), *width, out);
            for (key, value) in entries {
                encode_into(key, out)?;
                encode_into(value, out)?;
            }
        }
        Value::Ext { type_id, data } => encode_ext(*type_id, data, out),
    }
    Ok(())
}

fn canonical_uint(value: u64, out: &mut Vec<u8>) {
    if value <= 0x7f {
        out.push(value as u8);
    } else if value <= 0xff {
        out.push(0xcc);
        out.push(value as u8);
    } else if value <= 0xffff {
        out.push(0xcd);
        out.extend_from_slice(&(value as u16).to_be_bytes());
    } else if value <= 0xffff_ffff {
        out.push(0xce);
        out.extend_from_slice(&(value as u32).to_be_bytes());
    } else {
        out.push(0xcf);
        out.extend_from_slice(&value.to_be_bytes());
    }
}

fn encode_uint(value: u64, width: u8, out: &mut Vec<u8>) {
    match width {
        1 if value <= 0x7f => out.push(value as u8),
        2 if value <= 0xff => {
            out.push(0xcc);
            out.push(value as u8);
        }
        3 if value <= 0xffff => {
            out.push(0xcd);
            out.extend_from_slice(&(value as u16).to_be_bytes());
        }
        5 if value <= 0xffff_ffff => {
            out.push(0xce);
            out.extend_from_slice(&(value as u32).to_be_bytes());
        }
        9 => {
            out.push(0xcf);
            out.extend_from_slice(&value.to_be_bytes());
        }
        _ => canonical_uint(value, out),
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn canonical_int(value: i64, out: &mut Vec<u8>) {
    if (-32..=-1).contains(&value) {
        out.push(value as i8 as u8);
    } else if (-128..=127).contains(&value) {
        out.push(0xd0);
        out.push(value as i8 as u8);
    } else if (-32_768..=32_767).contains(&value) {
        out.push(0xd1);
        out.extend_from_slice(&(value as i16).to_be_bytes());
    } else if (-2_147_483_648..=2_147_483_647).contains(&value) {
        out.push(0xd2);
        out.extend_from_slice(&(value as i32).to_be_bytes());
    } else {
        out.push(0xd3);
        out.extend_from_slice(&value.to_be_bytes());
    }
}

fn encode_int(value: i64, width: u8, out: &mut Vec<u8>) {
    match width {
        1 if (-32..=-1).contains(&value) => out.push(value as i8 as u8),
        2 if (-128..=127).contains(&value) => {
            out.push(0xd0);
            out.push(value as i8 as u8);
        }
        3 if (-32_768..=32_767).contains(&value) => {
            out.push(0xd1);
            out.extend_from_slice(&(value as i16).to_be_bytes());
        }
        5 if (-2_147_483_648..=2_147_483_647).contains(&value) => {
            out.push(0xd2);
            out.extend_from_slice(&(value as i32).to_be_bytes());
        }
        9 => {
            out.push(0xd3);
            out.extend_from_slice(&value.to_be_bytes());
        }
        _ => canonical_int(value, out),
    }
}

fn encode_str(value: &[u8], width: u8, out: &mut Vec<u8>) {
    let len = value.len();
    let fits = match width {
        0 => len <= 31,
        1 => len <= 0xff,
        2 => len <= 0xffff,
        3 => true,
        _ => false,
    };
    if !fits {
        // The value grew; fall back to the canonical representation.
        let canonical = if len <= 31 {
            0
        } else if len <= 0xff {
            1
        } else if len <= 0xffff {
            2
        } else {
            3
        };
        encode_str(value, canonical, out);
        return;
    }
    match width {
        0 => out.push(0xa0 | (len as u8)),
        1 => {
            out.push(0xd9);
            out.push(len as u8);
        }
        2 => {
            out.push(0xda);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        }
        _ => {
            out.push(0xdb);
            out.extend_from_slice(&(len as u32).to_be_bytes());
        }
    }
    out.extend_from_slice(value);
}

fn encode_bin(value: &[u8], width: u8, out: &mut Vec<u8>) {
    let len = value.len();
    let fits = match width {
        1 => len <= 0xff,
        2 => len <= 0xffff,
        3 => true,
        _ => false,
    };
    if !fits {
        let canonical = if len <= 0xff {
            1
        } else if len <= 0xffff {
            2
        } else {
            3
        };
        encode_bin(value, canonical, out);
        return;
    }
    match width {
        1 => {
            out.push(0xc4);
            out.push(len as u8);
        }
        2 => {
            out.push(0xc5);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        }
        _ => {
            out.push(0xc6);
            out.extend_from_slice(&(len as u32).to_be_bytes());
        }
    }
    out.extend_from_slice(value);
}

fn encode_array_header(len: usize, width: u8, out: &mut Vec<u8>) {
    let fits = match width {
        0 => len <= 15,
        2 => len <= 0xffff,
        4 => true,
        _ => false,
    };
    if !fits {
        let canonical = if len <= 15 {
            0
        } else if len <= 0xffff {
            2
        } else {
            4
        };
        encode_array_header(len, canonical, out);
        return;
    }
    match width {
        0 => out.push(0x90 | (len as u8)),
        2 => {
            out.push(0xdc);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        }
        _ => {
            out.push(0xdd);
            out.extend_from_slice(&(len as u32).to_be_bytes());
        }
    }
}

fn encode_map_header(len: usize, width: u8, out: &mut Vec<u8>) {
    let fits = match width {
        0 => len <= 15,
        2 => len <= 0xffff,
        4 => true,
        _ => false,
    };
    if !fits {
        let canonical = if len <= 15 {
            0
        } else if len <= 0xffff {
            2
        } else {
            4
        };
        encode_map_header(len, canonical, out);
        return;
    }
    match width {
        0 => out.push(0x80 | (len as u8)),
        2 => {
            out.push(0xde);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        }
        _ => {
            out.push(0xdf);
            out.extend_from_slice(&(len as u32).to_be_bytes());
        }
    }
}

fn encode_ext(type_id: i8, data: &[u8], out: &mut Vec<u8>) {
    let len = data.len();
    let fixext = match len {
        1 => Some(0xd4),
        2 => Some(0xd5),
        4 => Some(0xd6),
        8 => Some(0xd7),
        16 => Some(0xd8),
        _ => None,
    };
    if let Some(marker) = fixext {
        out.push(marker);
    } else if len <= 0xff {
        out.push(0xc7);
        out.push(len as u8);
    } else if len <= 0xffff {
        out.push(0xc8);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0xc9);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
    out.push(type_id as u8);
    out.extend_from_slice(data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_non_canonical_uint_width() {
        let bytes = [0xcc, 0x00];
        let value = decode(&bytes).unwrap();
        assert_eq!(value, Value::UInt { value: 0, width: 2 });
        assert_eq!(encode(&value).unwrap(), bytes);
    }

    #[test]
    fn roundtrip_preserves_map_order_and_key_widths() {
        let bytes = [0x82, 0xcd, 0x00, 0x07, 0xc0, 0x00, 0xc3];
        let value = decode(&bytes).unwrap();
        assert_eq!(encode(&value).unwrap(), bytes);
    }

    #[test]
    fn rejects_truncated_input() {
        assert!(matches!(
            decode(&[0xda, 0x00, 0x10, b'a']),
            Err(DomainError::UnexpectedEof { .. })
        ));
    }

    #[test]
    fn rejects_trailing_bytes() {
        assert!(matches!(
            decode(&[0xc0, 0xc0]),
            Err(DomainError::InvalidContainer(_))
        ));
    }

    #[test]
    fn depth_limit_is_enforced() {
        // 70 nested fixarray(1) markers followed by nil.
        let mut bytes = vec![0x91u8; 70];
        bytes.push(0xc0);
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(err, DomainError::DepthLimit { .. }));
    }

    #[test]
    fn invalid_marker_is_rejected() {
        assert_eq!(
            decode(&[0xc1]).unwrap_err(),
            DomainError::InvalidMarker(0xc1)
        );
    }

    #[test]
    fn large_declared_count_is_rejected_before_allocation() {
        // map32 declaring 0xFFFF_FFFF entries.
        let bytes = [0xdf, 0xff, 0xff, 0xff, 0xff];
        assert!(matches!(
            decode(&bytes),
            Err(DomainError::ContainerTooLarge { .. })
        ));
    }

    #[test]
    fn string_and_binary_are_distinct() {
        let s = decode(&[0xa1, b'x']).unwrap();
        let b = decode(&[0xc4, 0x01, b'x']).unwrap();
        assert_ne!(s, b);
    }

    #[test]
    fn get_u64_compares_numeric_value() {
        let value = Value::map(vec![(Value::UInt { value: 7, width: 2 }, Value::str("x"))]);
        assert_eq!(value.get_u64(7).and_then(Value::as_str), Some("x"));
    }

    /// Hardware evidence: a slot read returned a `str16` payload that is not
    /// UTF-8 (the `l6-helix` container carries binary tails), and the old
    /// eager decode rejected the whole preset with "not valid UTF-8".
    #[test]
    fn str_payloads_are_bytes_and_round_trip_even_when_not_utf8() {
        let payload = [0xa9, b'l', b'6', b'-', 0xff, 0xfe, 0x00, 0x80];
        let mut encoded = vec![0xd9, payload.len() as u8];
        encoded.extend_from_slice(&payload);

        let value = decode(&encoded).unwrap();
        assert_eq!(value.as_str_bytes(), Some(&payload[..]));
        assert_eq!(value.as_str(), None, "invalid UTF-8 is not text");
        assert_eq!(encode(&value).unwrap(), encoded, "bytes must survive");
    }

    #[test]
    fn valid_utf8_str_still_reads_as_text() {
        let value = decode(b"\xa3abc").unwrap();
        assert_eq!(value.as_str(), Some("abc"));
        assert_eq!(Value::str("abc"), value);
        assert_eq!(Value::str_bytes(b"abc".to_vec()), value);
    }
}
