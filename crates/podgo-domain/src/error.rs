//! Typed domain errors.
//!
//! Every parser in this crate returns `Result<_, DomainError>`; none panics on
//! malformed input. The error variants intentionally carry offsets and sizes so
//! that logs are actionable without dumping payloads.

use std::fmt;

/// An error produced while decoding or encoding domain data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainError {
    /// The input ended before `needed` bytes were available at `offset`.
    UnexpectedEof {
        /// Byte offset at which reading started.
        offset: usize,
        /// Number of bytes requested.
        needed: usize,
    },
    /// A MessagePack marker byte is not defined by the format.
    InvalidMarker(u8),
    /// The value nesting exceeded the configured limit.
    DepthLimit {
        /// Maximum allowed nesting depth.
        limit: usize,
    },
    /// A container declared more elements than the safety limit allows.
    ContainerTooLarge {
        /// Declared element count.
        count: usize,
        /// Maximum allowed element count.
        limit: usize,
    },
    /// A length computation overflowed `usize`.
    LengthOverflow,
    /// A structural constraint of a known container was violated.
    InvalidContainer(&'static str),
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedEof { offset, needed } => {
                write!(
                    f,
                    "unexpected end of input at offset {offset} (needed {needed} bytes)"
                )
            }
            Self::InvalidMarker(marker) => write!(f, "invalid MessagePack marker 0x{marker:02x}"),
            Self::DepthLimit { limit } => write!(f, "MessagePack nesting exceeds limit {limit}"),
            Self::ContainerTooLarge { count, limit } => {
                write!(f, "container declares {count} elements (limit {limit})")
            }
            Self::LengthOverflow => write!(f, "length computation overflowed"),
            Self::InvalidContainer(reason) => write!(f, "invalid container: {reason}"),
        }
    }
}

impl std::error::Error for DomainError {}
