//! The session state machine.

use std::fmt;
use std::time::Duration;

use podgo_domain::preset_list::scan_preset_entries;
use podgo_domain::Value;
use podgo_protocol::constants::{
    CHUNK_FIRST_SEQ, CHUNK_OFFSET_STEP, CMD_SESSION_OPEN, EVENT_FIRST_SEQ, EVENT_POLL_TIMEOUT_MS,
    EVENT_REST_CURSOR, FIRST_DATA_HEADER_LEN, MAX_CHUNKS, MAX_STREAM_BYTES, PRESET_COUNT, READ_DST,
    READ_SRC, STREAM_BASE_OFFSET,
};
use podgo_protocol::frame::HEADER_LEN;
use podgo_protocol::handshake::{
    build_chunk_request, build_event_ack, build_event_poll, build_open_stream, EVENT_SEQUENCE,
    OPEN_PRESETS, READ_SEQUENCE,
};
use podgo_protocol::notification::{decode_notification, Notification};
use podgo_protocol::open::{decode_open_response, encode_open, OpenRequest};
use podgo_protocol::{Frame, ProtocolError};
use podgo_transport::{Transport, TransportError};

/// First application sequence number after the handshake.
pub const FIRST_APP_SEQ: u8 = podgo_protocol::FIRST_APP_SEQ;

/// Per-operation timeout.
pub const OP_TIMEOUT: Duration = Duration::from_millis(podgo_protocol::OP_TIMEOUT_MS);

/// Event poll read timeout.
pub const EVENT_TIMEOUT: Duration = Duration::from_millis(EVENT_POLL_TIMEOUT_MS);

/// Bulk read buffer size.
pub const READ_BUFFER: usize = podgo_protocol::READ_BUFFER;

/// Session state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// No transport.
    Disconnected,
    /// Handshake in progress.
    Handshaking,
    /// Handshake complete; requests are allowed.
    Ready,
    /// A terminal error occurred; a full reconnect is required.
    Failed,
}

impl fmt::Display for State {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Disconnected => "disconnected",
            Self::Handshaking => "handshaking",
            Self::Ready => "ready",
            Self::Failed => "failed",
        };
        f.write_str(name)
    }
}

/// Session errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// The transport failed.
    Transport(TransportError),
    /// The protocol codec failed.
    Protocol(ProtocolError),
    /// A request was attempted in a state other than `Ready`.
    NotReady(State),
    /// The handshake did not complete within the retry budget.
    HandshakeFailed {
        /// Number of attempts made.
        attempts: u32,
        /// Last error message.
        last: String,
    },
    /// `poll_events` was called before `open_event_channel`.
    EventChannelNotOpen,
    /// A preset stream was already read in this session.
    ///
    /// The device desyncs when a second setlist is streamed on a used session;
    /// reconnect and start a fresh one instead.
    StreamAlreadyUsed,
    /// The session has already carried traffic, so a stream would desync.
    StreamRequiresFreshSession,
    /// The reassembled stream exceeded [`MAX_STREAM_BYTES`].
    StreamTooLarge {
        /// Bytes assembled before the limit was hit.
        size: usize,
    },
}

impl From<TransportError> for SessionError {
    fn from(value: TransportError) -> Self {
        Self::Transport(value)
    }
}

impl From<ProtocolError> for SessionError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(err) => write!(f, "transport error: {err}"),
            Self::Protocol(err) => write!(f, "protocol error: {err}"),
            Self::NotReady(state) => write!(f, "session is not ready (state: {state})"),
            Self::HandshakeFailed { attempts, last } => {
                write!(f, "handshake failed after {attempts} attempt(s): {last}")
            }
            Self::EventChannelNotOpen => {
                write!(
                    f,
                    "event channel is not open; call open_event_channel first"
                )
            }
            Self::StreamAlreadyUsed => {
                write!(f, "a preset stream was already read in this session")
            }
            Self::StreamRequiresFreshSession => {
                write!(
                    f,
                    "preset streaming requires a fresh session; reconnect first"
                )
            }
            Self::StreamTooLarge { size } => {
                write!(f, "preset stream exceeded the size limit at {size} B")
            }
        }
    }
}

impl std::error::Error for SessionError {}

/// Retry policy for the handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Maximum number of full handshake attempts (at least 1).
    pub max_attempts: u32,
    /// Base backoff; the delay for attempt `n` is `base * (n + 1)`.
    pub base_backoff: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            base_backoff: Duration::from_millis(300),
        }
    }
}

impl RetryPolicy {
    /// Delay before the next attempt (linear backoff).
    #[must_use]
    pub fn delay(&self, attempt: u32) -> Duration {
        self.base_backoff * attempt.saturating_add(1)
    }
}

/// A sleeping strategy, injected so tests stay deterministic.
pub trait Sleeper {
    /// Sleep for `duration`.
    fn sleep(&mut self, duration: Duration);
}

/// A sleeper that does nothing. Suitable for tests and for callers that manage
/// their own scheduling.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopSleeper;

impl Sleeper for NoopSleeper {
    fn sleep(&mut self, _duration: Duration) {}
}

/// A raw streamed setlist, before decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetStream {
    /// Reassembled bytes, including any head carried by the open response.
    pub raw: Vec<u8>,
    /// Number of chunk requests issued (including the terminating empty one).
    pub chunks: usize,
}

impl PresetStream {
    /// Parse the reassembled bytes into entries, assigning slots in stream order.
    ///
    /// # Errors
    ///
    /// Returns [`podgo_domain::DomainError::InvalidContainer`] when the buffer
    /// contains no recognisable preset entry.
    pub fn entries(&self) -> Result<Vec<podgo_domain::PresetEntry>, podgo_domain::DomainError> {
        podgo_domain::parse_preset_list(&self.raw)
    }
}

/// An established (or establishing) session.
pub struct Session<T: Transport> {
    transport: T,
    state: State,
    seq: u8,
    transaction: u64,
    event_seq: u8,
    event_cursor: u32,
    event_open: bool,
    stream_used: bool,
}

// Manual implementation so that `Result<Session<_>, _>::unwrap_err()` works
// without requiring the transport itself to implement `Debug`.
impl<T: Transport> fmt::Debug for Session<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("state", &self.state)
            .field("seq", &self.seq)
            .field("transaction", &self.transaction)
            .field("event_cursor", &self.event_cursor)
            .field("event_open", &self.event_open)
            .field("stream_used", &self.stream_used)
            .finish_non_exhaustive()
    }
}

impl<T: Transport> Session<T> {
    /// Connect with the default retry policy and no sleeping.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::HandshakeFailed`] if the handshake does not
    /// complete.
    pub fn connect(transport: T) -> Result<Self, SessionError> {
        Self::connect_with_retry(transport, RetryPolicy::default(), &mut NoopSleeper)
    }

    /// Connect with an explicit retry policy.
    ///
    /// The handshake is retried as a whole; a partially completed handshake is
    /// never resumed.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::HandshakeFailed`] when every attempt fails.
    pub fn connect_with_retry(
        mut transport: T,
        policy: RetryPolicy,
        sleeper: &mut dyn Sleeper,
    ) -> Result<Self, SessionError> {
        let max_attempts = policy.max_attempts.max(1);
        let mut last = String::new();

        for attempt in 0..max_attempts {
            match Self::perform_handshake(&mut transport) {
                Ok(()) => {
                    return Ok(Self {
                        transport,
                        state: State::Ready,
                        seq: FIRST_APP_SEQ,
                        transaction: 1000,
                        event_seq: EVENT_FIRST_SEQ,
                        event_cursor: EVENT_REST_CURSOR,
                        event_open: false,
                        stream_used: false,
                    });
                }
                Err(err) => {
                    last = err.to_string();
                    if attempt + 1 < max_attempts {
                        sleeper.sleep(policy.delay(attempt));
                    }
                }
            }
        }

        Err(SessionError::HandshakeFailed {
            attempts: max_attempts,
            last,
        })
    }

    fn perform_handshake(transport: &mut T) -> Result<(), SessionError> {
        let mut buffer = [0u8; READ_BUFFER];
        for packet in READ_SEQUENCE {
            transport.write(packet)?;
            transport.read(&mut buffer, OP_TIMEOUT)?;
        }
        Ok(())
    }

    /// Current state.
    #[must_use]
    pub fn state(&self) -> State {
        self.state
    }

    /// Next application sequence number that will be used.
    #[must_use]
    pub fn seq(&self) -> u8 {
        self.seq
    }

    /// Next transaction id.
    #[must_use]
    pub fn transaction(&self) -> u64 {
        self.transaction
    }

    /// Borrow the underlying transport (for diagnostics).
    #[must_use]
    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// Send one frame and read exactly one response frame.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::NotReady`] if the session is not ready, or a
    /// transport/protocol error.
    pub fn transact(&mut self, frame: &[u8]) -> Result<Frame, SessionError> {
        self.ensure_ready()?;
        self.transport.write(frame)?;
        let mut buffer = [0u8; READ_BUFFER];
        let read = self.transport.read(&mut buffer, OP_TIMEOUT)?;
        Ok(Frame::parse(&buffer[..read])?)
    }

    /// Read one object using an OPEN request.
    ///
    /// `cursor` is caller-supplied because the cursor for arbitrary objects is
    /// not yet understood (`docs/reverse-engineering/unknowns-and-hypotheses.md`).
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::Protocol`] for a non-zero device status, a
    /// missing status field or a codec error.
    pub fn read_object(
        &mut self,
        operation: u64,
        params: Value,
        cursor: u32,
    ) -> Result<Value, SessionError> {
        let seq = self.next_seq();
        let request = OpenRequest {
            transaction: self.transaction,
            operation,
            params,
        };
        self.transaction = self.transaction.wrapping_add(1);
        let frame = encode_open(&request, READ_SRC, READ_DST, seq, cursor)?;
        let response = self.transact(&frame)?;
        let decoded = decode_open_response(&response)?;
        decoded.ensure_ok().map_err(SessionError::Protocol)
    }

    /// Stream one setlist and reassemble the raw preset-list buffer.
    ///
    /// Mirrors the reference flow: send `OPEN_PRESETS`, then `OPEN_STREAM`
    /// with the setlist selector byte, keep any data carried by the open
    /// response, then request `0x100`-byte windows starting at `0x1000`.
    ///
    /// Each response is a 512-byte packet whose trailing half repeats part of
    /// the stream, so payloads are written at their absolute position:
    /// the next window overwrites the repetition. Truncating to the fresh
    /// window instead would lose entries that straddle a boundary.
    ///
    /// The stream ends naturally on an empty payload, or early once
    /// [`PRESET_COUNT`] entries are visible. Streaming requires a fresh
    /// session: the reference re-handshakes before every setlist because a
    /// second stream on a used session desynchronises the device.
    ///
    /// # Errors
    ///
    /// - [`SessionError::StreamAlreadyUsed`] if this session already streamed.
    /// - [`SessionError::StreamRequiresFreshSession`] if other traffic ran.
    /// - [`SessionError::StreamTooLarge`] if reassembly exceeds
    ///   [`MAX_STREAM_BYTES`].
    /// - [`SessionError::NotReady`] or a transport/protocol error.
    pub fn read_preset_stream(&mut self, setlist: u8) -> Result<PresetStream, SessionError> {
        self.ensure_ready()?;
        if self.stream_used {
            return Err(SessionError::StreamAlreadyUsed);
        }
        if self.seq != FIRST_APP_SEQ || self.transaction != 1000 || self.event_open {
            return Err(SessionError::StreamRequiresFreshSession);
        }
        // A failed stream may leave the device mid-message, so the session is
        // spent even if this call returns an error.
        self.stream_used = true;

        self.transact(OPEN_PRESETS)?;
        self.seq = self.seq.wrapping_add(1);

        let open_stream = build_open_stream(setlist)?;
        let ack = self.transact(&open_stream)?;
        self.seq = self.seq.wrapping_add(1);

        let head_start = FIRST_DATA_HEADER_LEN - HEADER_LEN;
        let head = ack.body().get(head_start..).unwrap_or_default();
        if head.len() > MAX_STREAM_BYTES {
            return Err(SessionError::StreamTooLarge { size: head.len() });
        }
        let mut buffer = head.to_vec();

        let base = STREAM_BASE_OFFSET;
        let mut offset = base;
        let mut seq = CHUNK_FIRST_SEQ;
        let mut chunks = 0usize;

        for _ in 0..MAX_CHUNKS {
            let request = build_chunk_request(seq, offset);
            let response = self.transact(&request)?;
            chunks += 1;

            let payload = response.body();
            if payload.is_empty() {
                break;
            }

            let relative = usize::try_from(offset.saturating_sub(base)).unwrap_or(usize::MAX);
            let start = head.len().saturating_add(relative);
            let end = start.saturating_add(payload.len());
            if end > MAX_STREAM_BYTES {
                return Err(SessionError::StreamTooLarge { size: end });
            }
            if end > buffer.len() {
                buffer.resize(end, 0);
            }
            buffer[start..end].copy_from_slice(payload);

            if scan_preset_entries(&buffer).len() >= PRESET_COUNT {
                break;
            }

            offset = offset.saturating_add(CHUNK_OFFSET_STEP);
            seq = seq.wrapping_add(1);
        }

        Ok(PresetStream {
            raw: buffer,
            chunks,
        })
    }

    /// Open the event channel with the three-packet handshake.
    ///
    /// The event channel is separate from the read channel and must be opened
    /// before polling. It uses source `0x1002` and destination `0x03F0`, starts
    /// at sequence `0x04` and rests at cursor `0x1009`.
    ///
    /// A failure leaves the session `Ready` but with the event channel closed
    /// and any partial channel state discarded; open it again to retry.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::NotReady`] when the session is not ready, or a
    /// transport error from any of the three request/response exchanges.
    pub fn open_event_channel(&mut self) -> Result<(), SessionError> {
        self.ensure_ready()?;
        self.event_open = false;
        self.event_seq = EVENT_FIRST_SEQ;
        self.event_cursor = EVENT_REST_CURSOR;

        let mut buffer = [0u8; READ_BUFFER];
        for packet in EVENT_SEQUENCE {
            self.transport.write(packet)?;
            self.transport.read(&mut buffer, OP_TIMEOUT)?;
        }
        self.event_open = true;
        Ok(())
    }

    /// Poll the event channel and drain the burst of pending events.
    ///
    /// Sends one `cmd=0x10` poll at the current cursor. Each `cmd=0x04` data
    /// frame from `0x03F0` is decoded, the cursor is advanced and a `cmd=0x08`
    /// acknowledgement is sent before reading again. Polling stops at the first
    /// keepalive, non-event frame or timeout, which marks the end of the burst.
    ///
    /// Returns an empty vector when nothing is pending. Malformed event frames
    /// are skipped rather than aborting the burst.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::EventChannelNotOpen`] when
    /// [`Session::open_event_channel`] has not succeeded, or a transport error.
    pub fn poll_events(&mut self) -> Result<Vec<Notification>, SessionError> {
        self.ensure_ready()?;
        if !self.event_open {
            return Err(SessionError::EventChannelNotOpen);
        }

        let seq = self.next_event_seq();
        let poll = build_event_poll(seq, self.event_cursor);
        self.transport.write(&poll)?;

        let mut events = Vec::new();
        loop {
            let mut buffer = [0u8; READ_BUFFER];
            let read = match self.transport.read(&mut buffer, EVENT_TIMEOUT) {
                Ok(read) => read,
                Err(TransportError::Timeout) => break,
                Err(error) => return Err(error.into()),
            };
            let bytes = &buffer[..read];
            if !is_event_data(bytes) {
                break;
            }

            let frame = Frame::parse(bytes)?;
            match decode_notification(&frame) {
                Ok(notification) => events.push(notification),
                Err(ProtocolError::MissingField("105")) => {
                    // Malformed event payload: advance past it and keep draining.
                }
                Err(error) => return Err(SessionError::Protocol(error)),
            }

            self.event_cursor = self.event_cursor.wrapping_add(event_cursor_advance(bytes));
            let ack_seq = self.next_event_seq();
            let ack = build_event_ack(ack_seq, self.event_cursor);
            self.transport.write(&ack)?;
        }
        Ok(events)
    }

    /// Current event cursor (for diagnostics).
    #[must_use]
    pub fn event_cursor(&self) -> u32 {
        self.event_cursor
    }

    /// Whether the event channel is open.
    #[must_use]
    pub fn is_event_channel_open(&self) -> bool {
        self.event_open
    }

    /// Close the session.
    ///
    /// # Errors
    ///
    /// Returns a transport error if closing fails.
    pub fn close(&mut self) -> Result<(), SessionError> {
        let result = self.transport.close();
        self.state = State::Disconnected;
        self.event_open = false;
        result.map_err(Into::into)
    }

    fn ensure_ready(&self) -> Result<(), SessionError> {
        if self.state == State::Ready {
            Ok(())
        } else {
            Err(SessionError::NotReady(self.state))
        }
    }

    fn next_seq(&mut self) -> u8 {
        let current = self.seq;
        self.seq = self.seq.wrapping_add(1);
        current
    }

    fn next_event_seq(&mut self) -> u8 {
        let current = self.event_seq;
        self.event_seq = self.event_seq.wrapping_add(1);
        current
    }
}

/// True when a response is a data frame from the event channel.
fn is_event_data(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER_LEN && bytes[4..6] == [0xf0, 0x03] && bytes[11] == CMD_SESSION_OPEN
}

/// Cursor advance for one event frame: `8 + declared body length`.
///
/// The subheader declares a 32-bit length (bytes 20-23). Capture evidence:
/// fw 2.50 acknowledgements move the host cursor by this amount, from `0x1009`
/// to `0x1037` after 13- and 17-byte bodies.
fn event_cursor_advance(bytes: &[u8]) -> u32 {
    if bytes.len() < 24 {
        return 0;
    }
    let declared = u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    8u32.saturating_add(declared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use podgo_domain::msgpack;
    use podgo_protocol::constants::{KEY_EVENT_OPCODE, KEY_RESULT, KEY_STATUS};
    use podgo_protocol::handshake::READ_SEQUENCE;
    use podgo_protocol::notification::{OP_PRESET_LOADED, OP_SET_PARAM, OP_TEMPO};
    use podgo_transport::MockTransport;

    fn handshake_mock() -> MockTransport {
        let mut mock = MockTransport::new();
        for packet in READ_SEQUENCE {
            mock.expect_write(packet.to_vec());
            mock.queue_read(vec![0u8; 16]);
        }
        mock
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0u8; 16];
        bytes[3] = 0x18;
        bytes[4..6].copy_from_slice(&READ_DST.to_le_bytes());
        bytes[6..8].copy_from_slice(&READ_SRC.to_le_bytes());
        bytes[11] = 0x04;
        bytes.extend_from_slice(&[0x01, 0x00, 0x02, 0x00]);
        bytes.extend_from_slice(&(body.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(body);
        bytes
    }

    fn response_body(status: u64, result: Value) -> Vec<u8> {
        msgpack::encode(&Value::map(vec![
            (Value::uint(KEY_STATUS), Value::uint(status)),
            (Value::uint(KEY_RESULT), result),
        ]))
        .unwrap()
    }

    fn event_body(opcode: u64) -> Vec<u8> {
        msgpack::encode(&Value::map(vec![
            (Value::uint(KEY_EVENT_OPCODE), Value::uint(opcode)),
            (Value::uint(106), Value::map(vec![])),
        ]))
        .unwrap()
    }

    fn event_frame(body: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0u8; 16];
        bytes[3] = 0x18;
        bytes[4..6].copy_from_slice(&0x03F0u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&0x1002u16.to_le_bytes());
        bytes[11] = 0x04;
        bytes.extend_from_slice(&[0x00, 0x00, 0x04, 0x00]);
        bytes.extend_from_slice(&(body.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(body);
        bytes
    }

    fn data_frame(payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0u8; 16];
        bytes[3] = 0x18;
        bytes[4..6].copy_from_slice(&READ_DST.to_le_bytes());
        bytes[6..8].copy_from_slice(&READ_SRC.to_le_bytes());
        bytes[11] = CMD_SESSION_OPEN;
        bytes.extend_from_slice(payload);
        bytes
    }

    fn preset_entry(index: u16, name: &str) -> Vec<u8> {
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

    fn stream_mock(setlist: u8, open_ack: Vec<u8>, chunks: &[(Vec<u8>, Vec<u8>)]) -> MockTransport {
        let mut mock = handshake_mock();
        mock.expect_write(OPEN_PRESETS.to_vec());
        mock.queue_read(vec![0u8; 16]);
        mock.expect_write(build_open_stream(setlist).unwrap());
        mock.queue_read(open_ack);
        for (request, response) in chunks {
            mock.expect_write(request.clone());
            mock.queue_read(response.clone());
        }
        mock
    }

    #[test]
    fn connect_completes_five_packet_handshake() {
        let mock = handshake_mock();
        let session = Session::connect(mock).unwrap();
        assert_eq!(session.state(), State::Ready);
        assert_eq!(session.seq(), FIRST_APP_SEQ);
        assert_eq!(session.transport().writes.len(), 5);
        assert_eq!(session.transport().read_count, 5);
        assert!(session.transport().is_exhausted());
    }

    #[test]
    fn read_object_correlates_sequence_and_decodes_result() {
        let mut mock = handshake_mock();
        let request = OpenRequest::new(1000, 22);
        mock.expect_write(
            encode_open(&request, READ_SRC, READ_DST, FIRST_APP_SEQ, 0x1000).unwrap(),
        );
        mock.queue_read(framed(&response_body(0, Value::str("blob"))));

        let mut session = Session::connect(mock).unwrap();
        let value = session.read_object(22, Value::map(vec![]), 0x1000).unwrap();
        assert_eq!(value.as_str(), Some("blob"));
        assert_eq!(session.seq(), FIRST_APP_SEQ + 1);
        assert_eq!(session.transaction(), 1001);
    }

    #[test]
    fn non_zero_status_becomes_device_status_error() {
        let mut mock = handshake_mock();
        let request = OpenRequest::new(1000, 22);
        mock.expect_write(
            encode_open(&request, READ_SRC, READ_DST, FIRST_APP_SEQ, 0x1000).unwrap(),
        );
        mock.queue_read(framed(&response_body(4, Value::Nil)));

        let mut session = Session::connect(mock).unwrap();
        let err = session
            .read_object(22, Value::map(vec![]), 0x1000)
            .unwrap_err();
        assert_eq!(
            err,
            SessionError::Protocol(ProtocolError::DeviceStatus {
                status: 4,
                code: None
            })
        );
    }

    #[test]
    fn open_event_channel_consumes_three_packets() {
        let mut mock = handshake_mock();
        for packet in EVENT_SEQUENCE {
            mock.expect_write(packet.to_vec());
            mock.queue_read(vec![0u8; 16]);
        }
        let mut session = Session::connect(mock).unwrap();
        assert!(!session.is_event_channel_open());
        session.open_event_channel().unwrap();
        assert!(session.is_event_channel_open());
        assert_eq!(session.event_cursor(), EVENT_REST_CURSOR);
        assert!(session.transport().is_exhausted());
    }

    #[test]
    fn poll_events_drains_burst_and_acks() {
        let mut mock = handshake_mock();
        for packet in EVENT_SEQUENCE {
            mock.expect_write(packet.to_vec());
            mock.queue_read(vec![0u8; 16]);
        }

        let first_body = event_body(OP_SET_PARAM);
        let second_body = event_body(OP_TEMPO);
        mock.expect_write(build_event_poll(EVENT_FIRST_SEQ, EVENT_REST_CURSOR));
        mock.queue_read(event_frame(&first_body));
        let cursor_1 = EVENT_REST_CURSOR + 8 + first_body.len() as u32;
        mock.expect_write(build_event_ack(EVENT_FIRST_SEQ + 1, cursor_1));
        mock.queue_read(event_frame(&second_body));
        let cursor_2 = cursor_1 + 8 + second_body.len() as u32;
        mock.expect_write(build_event_ack(EVENT_FIRST_SEQ + 2, cursor_2));
        mock.queue_read(vec![0u8; 16]);

        let mut session = Session::connect(mock).unwrap();
        session.open_event_channel().unwrap();
        let events = session.poll_events().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].opcode, OP_SET_PARAM);
        assert_eq!(events[1].opcode, OP_TEMPO);
        assert_eq!(session.event_cursor(), cursor_2);
        assert!(session.transport().is_exhausted());
    }

    #[test]
    fn poll_events_advances_over_captured_frames() {
        // Two real notifications from a fw 2.50 capture: 13 and 17 body bytes.
        // The host cursor must move by 8 + declared length for each, while the
        // device echo at bytes 12-15 (0x0209) must be ignored.
        const EVENTS: &[u8] = include_bytes!("../../../fixtures/events_fw250.bin");
        let mut frames = Vec::new();
        let mut pos = 0;
        while pos + 2 <= EVENTS.len() {
            let len = usize::from(u16::from_le_bytes([EVENTS[pos], EVENTS[pos + 1]]));
            pos += 2;
            frames.push(&EVENTS[pos..pos + len]);
            pos += len;
        }
        assert_eq!(frames.len(), 14);

        let mut mock = handshake_mock();
        for packet in EVENT_SEQUENCE {
            mock.expect_write(packet.to_vec());
            mock.queue_read(vec![0u8; 16]);
        }

        mock.expect_write(build_event_poll(EVENT_FIRST_SEQ, EVENT_REST_CURSOR));
        mock.queue_read(frames[0].to_vec());
        let cursor_1 = EVENT_REST_CURSOR + 8 + 13;
        mock.expect_write(build_event_ack(EVENT_FIRST_SEQ + 1, cursor_1));
        mock.queue_read(frames[1].to_vec());
        let cursor_2 = cursor_1 + 8 + 17;
        mock.expect_write(build_event_ack(EVENT_FIRST_SEQ + 2, cursor_2));
        mock.queue_read(vec![0u8; 16]);

        let mut session = Session::connect(mock).unwrap();
        session.open_event_channel().unwrap();
        let events = session.poll_events().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].opcode, 20);
        assert_eq!(events[1].opcode, OP_PRESET_LOADED);
        // 0x1009 + (8 + 13) + (8 + 17) comes from the capture's ACK.
        assert_eq!(session.event_cursor(), 0x1037);
        assert!(session.transport().is_exhausted());
    }

    #[test]
    fn poll_events_without_open_channel_is_rejected() {
        let mock = handshake_mock();
        let mut session = Session::connect(mock).unwrap();
        assert_eq!(
            session.poll_events().unwrap_err(),
            SessionError::EventChannelNotOpen
        );
    }

    #[test]
    fn poll_events_returns_empty_on_timeout() {
        let mut mock = handshake_mock();
        for packet in EVENT_SEQUENCE {
            mock.expect_write(packet.to_vec());
            mock.queue_read(vec![0u8; 16]);
        }
        mock.expect_write(build_event_poll(EVENT_FIRST_SEQ, EVENT_REST_CURSOR));

        let mut session = Session::connect(mock).unwrap();
        session.open_event_channel().unwrap();
        assert!(session.poll_events().unwrap().is_empty());
    }

    #[test]
    fn handshake_failure_is_reported_with_attempt_count() {
        let mut mock = MockTransport::new();
        mock.queue_read_error(TransportError::Timeout);
        let policy = RetryPolicy {
            max_attempts: 1,
            base_backoff: Duration::ZERO,
        };
        let err = Session::connect_with_retry(mock, policy, &mut NoopSleeper).unwrap_err();
        assert!(matches!(
            err,
            SessionError::HandshakeFailed { attempts: 1, .. }
        ));
    }

    #[test]
    fn requests_are_rejected_after_close() {
        let mock = handshake_mock();
        let mut session = Session::connect(mock).unwrap();
        session.close().unwrap();
        assert_eq!(session.state(), State::Disconnected);
        assert_eq!(
            session.transact(&[0u8; 16]).unwrap_err(),
            SessionError::NotReady(State::Disconnected)
        );
    }

    #[test]
    fn preset_stream_reassembles_chunks_until_empty_payload() {
        let first = [preset_entry(128, "First"), preset_entry(129, "Second")].concat();
        let mock = stream_mock(
            0,
            vec![0u8; 16],
            &[
                (
                    build_chunk_request(CHUNK_FIRST_SEQ, STREAM_BASE_OFFSET),
                    data_frame(&first),
                ),
                (
                    build_chunk_request(
                        CHUNK_FIRST_SEQ + 1,
                        STREAM_BASE_OFFSET + CHUNK_OFFSET_STEP,
                    ),
                    vec![0u8; 16],
                ),
            ],
        );

        let mut session = Session::connect(mock).unwrap();
        let stream = session.read_preset_stream(0).unwrap();
        assert_eq!(stream.chunks, 2);
        assert_eq!(stream.raw, first);
        let entries = stream.entries().unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.slot, e.index, e.name.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, 128, "First"), (1, 129, "Second")]
        );
        assert!(session.transport().is_exhausted());
    }

    #[test]
    fn preset_stream_keeps_data_carried_by_open_ack() {
        let head = preset_entry(128, "Head");
        let chunk = preset_entry(129, "Chunk");

        let mut open_ack = vec![0u8; 16];
        open_ack.extend_from_slice(&[0u8; 8]);
        open_ack.extend_from_slice(&head);

        let mock = stream_mock(
            1,
            open_ack,
            &[
                (
                    build_chunk_request(CHUNK_FIRST_SEQ, STREAM_BASE_OFFSET),
                    data_frame(&chunk),
                ),
                (
                    build_chunk_request(
                        CHUNK_FIRST_SEQ + 1,
                        STREAM_BASE_OFFSET + CHUNK_OFFSET_STEP,
                    ),
                    vec![0u8; 16],
                ),
            ],
        );

        let mut session = Session::connect(mock).unwrap();
        let stream = session.read_preset_stream(1).unwrap();
        assert_eq!(stream.raw, [head, chunk].concat());
        assert_eq!(stream.entries().unwrap().len(), 2);
    }

    #[test]
    fn preset_stream_cannot_be_read_twice() {
        let mock = stream_mock(
            0,
            vec![0u8; 16],
            &[(
                build_chunk_request(CHUNK_FIRST_SEQ, STREAM_BASE_OFFSET),
                vec![0u8; 16],
            )],
        );
        let mut session = Session::connect(mock).unwrap();
        session.read_preset_stream(0).unwrap();
        assert_eq!(
            session.read_preset_stream(0).unwrap_err(),
            SessionError::StreamAlreadyUsed
        );
    }

    #[test]
    fn preset_stream_requires_a_fresh_session() {
        let mut mock = handshake_mock();
        let request = OpenRequest::new(1000, 22);
        mock.expect_write(
            encode_open(&request, READ_SRC, READ_DST, FIRST_APP_SEQ, 0x1000).unwrap(),
        );
        mock.queue_read(framed(&response_body(0, Value::Nil)));

        let mut session = Session::connect(mock).unwrap();
        session.read_object(22, Value::map(vec![]), 0x1000).unwrap();
        assert_eq!(
            session.read_preset_stream(0).unwrap_err(),
            SessionError::StreamRequiresFreshSession
        );
    }
}
