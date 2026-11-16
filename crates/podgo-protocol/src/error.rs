//! Protocol errors.

use std::fmt;

use podgo_domain::DomainError;

/// An error produced by frame encoding/decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// The input is shorter than the fixed header.
    TooShort {
        /// Required bytes.
        needed: usize,
        /// Available bytes.
        actual: usize,
    },
    /// A length field disagrees with the available bytes.
    BodyLengthMismatch {
        /// Declared body length.
        declared: usize,
        /// Available bytes.
        available: usize,
    },
    /// A structural invariant of the frame was violated.
    InvalidFrame(&'static str),
    /// A subheader was not recognised.
    UnknownSubheader([u8; 2]),
    /// The MessagePack body is invalid.
    Msgpack(DomainError),
    /// The device reported a non-zero status.
    DeviceStatus {
        /// Status value (key 103).
        status: u64,
        /// Optional error code (key 111).
        code: Option<u64>,
    },
    /// A required body field is missing.
    MissingField(&'static str),
    /// A body field has an unexpected type.
    UnexpectedType(&'static str),
    /// The operation is not supported in this build.
    Unsupported(&'static str),
}

impl From<DomainError> for ProtocolError {
    fn from(value: DomainError) -> Self {
        Self::Msgpack(value)
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort { needed, actual } => {
                write!(f, "frame too short: need {needed} bytes, have {actual}")
            }
            Self::BodyLengthMismatch {
                declared,
                available,
            } => write!(
                f,
                "body length mismatch: declared {declared}, available {available}"
            ),
            Self::InvalidFrame(reason) => write!(f, "invalid frame: {reason}"),
            Self::UnknownSubheader(bytes) => {
                write!(f, "unknown subheader {bytes:02x?}")
            }
            Self::Msgpack(err) => write!(f, "MessagePack error: {err}"),
            Self::DeviceStatus { status, code } => match code {
                Some(code) => write!(
                    f,
                    "device rejected the operation: status {status}, code {code}"
                ),
                None => write!(f, "device rejected the operation: status {status}"),
            },
            Self::MissingField(field) => write!(f, "missing body field {field}"),
            Self::UnexpectedType(field) => write!(f, "unexpected type for body field {field}"),
            Self::Unsupported(what) => write!(f, "unsupported: {what}"),
        }
    }
}

impl std::error::Error for ProtocolError {}
