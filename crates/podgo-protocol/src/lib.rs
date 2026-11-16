//! Transport-independent codec for the POD Go vendor protocol.
//!
//! This crate knows about bytes, frames, commands and MessagePack. It does not
//! know about USB, browsers or operating systems. Evidence and confidence
//! labels for every constant live in
//! `docs/reverse-engineering/protocol-specification.md`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod constants;
pub mod error;
pub mod frame;
pub mod handshake;
pub mod notification;
pub mod open;
#[cfg(feature = "device-write")]
pub mod write;

pub use constants::*;
pub use error::ProtocolError;
pub use frame::Frame;
pub use notification::{decode_notification, Notification};
pub use open::{decode_open_response, encode_open, payload, OpenRequest, OpenResponse};
