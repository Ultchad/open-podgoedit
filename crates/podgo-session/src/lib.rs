//! Connection state machine for the POD Go vendor protocol.
//!
//! This crate owns session lifecycle: handshake, sequence numbers, one
//! request/one response, retries and close. It never touches a device directly;
//! it only uses [`podgo_transport::Transport`].
//!
//! See `docs/architecture/system-design.md` §4 and
//! `docs/reverse-engineering/protocol-specification.md` §9.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod session;

pub use session::{
    NoopSleeper, PresetStream, RetryPolicy, Session, SessionError, Sleeper, State, FIRST_APP_SEQ,
};
