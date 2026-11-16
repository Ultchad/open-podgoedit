//! Transport abstraction.
//!
//! The core session only needs a byte stream. Discovery, permission and
//! claiming are separate concerns because their UX differs per platform:
//! WebUSB needs a user gesture, Android needs an `Intent`, libusb is
//! synchronous. Keeping them out of [`Transport`] prevents platform UX from
//! leaking into the protocol layer.
//!
//! See `docs/architecture/system-design.md` §3.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::VecDeque;
use std::fmt;
use std::time::Duration;

/// A device identity as reported by discovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DeviceId {
    /// USB vendor id.
    pub vendor_id: u16,
    /// USB product id.
    pub product_id: u16,
    /// Bus number, when available.
    pub bus: u8,
    /// Device address, when available.
    pub address: u8,
}

impl DeviceId {
    /// Create a device id.
    #[must_use]
    pub const fn new(vendor_id: u16, product_id: u16, bus: u8, address: u8) -> Self {
        Self {
            vendor_id,
            product_id,
            bus,
            address,
        }
    }
}

/// Byte-level transport errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// The operating system or browser reported an I/O error.
    Io(String),
    /// The operation timed out.
    Timeout,
    /// The device disappeared.
    Disconnected,
    /// The transport does not support the operation on this platform.
    Unsupported(&'static str),
    /// A mock transport received an unexpected write.
    ScriptMismatch {
        /// Expected bytes.
        expected: Vec<u8>,
        /// Actual bytes.
        actual: Vec<u8>,
    },
    /// The caller's read buffer was smaller than the pending response.
    BufferTooSmall {
        /// Buffer size.
        buffer: usize,
        /// Pending response size.
        pending: usize,
    },
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => write!(f, "transport I/O error: {message}"),
            Self::Timeout => write!(f, "transport timeout"),
            Self::Disconnected => write!(f, "device disconnected"),
            Self::Unsupported(what) => write!(f, "unsupported transport operation: {what}"),
            Self::ScriptMismatch { expected, actual } => write!(
                f,
                "mock script mismatch: expected {} bytes, got {} bytes",
                expected.len(),
                actual.len()
            ),
            Self::BufferTooSmall { buffer, pending } => {
                write!(f, "read buffer {buffer} B smaller than pending {pending} B")
            }
        }
    }
}

impl std::error::Error for TransportError {}

/// A bidirectional byte transport.
///
/// Implementations must be synchronous at this level. Async runtimes wrap
/// blocking calls in their own executor.
pub trait Transport {
    /// Write all bytes, returning the number accepted.
    ///
    /// # Errors
    ///
    /// Returns a [`TransportError`] on failure.
    fn write(&mut self, bytes: &[u8]) -> Result<usize, TransportError>;

    /// Read up to `buf.len()` bytes, waiting at most `timeout`.
    ///
    /// # Errors
    ///
    /// Returns [`TransportError::Timeout`] when no data arrives in time.
    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize, TransportError>;

    /// Close the transport.
    ///
    /// # Errors
    ///
    /// Returns a [`TransportError`] if the close fails.
    fn close(&mut self) -> Result<(), TransportError>;
}

/// A mutable reference to a transport is itself a transport.
///
/// This lets a caller retain ownership of a concrete transport (for example a
/// test mock) while lending it to a session, which is useful for inspecting
/// recorded traffic after the session is dropped.
impl<T: Transport + ?Sized> Transport for &mut T {
    fn write(&mut self, bytes: &[u8]) -> Result<usize, TransportError> {
        (**self).write(bytes)
    }

    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize, TransportError> {
        (**self).read(buf, timeout)
    }

    fn close(&mut self) -> Result<(), TransportError> {
        (**self).close()
    }
}

/// Device discovery.
pub trait Discovery {
    /// List candidate devices.
    ///
    /// # Errors
    ///
    /// Returns a [`TransportError`] if enumeration fails.
    fn list(&mut self) -> Result<Vec<DeviceId>, TransportError>;
}

/// A scripted transport for deterministic tests.
///
/// Writes are checked against an expected queue when one is configured; reads
/// pop queued responses. It never touches hardware.
#[derive(Debug, Default)]
pub struct MockTransport {
    expected_writes: VecDeque<Vec<u8>>,
    reads: VecDeque<Result<Vec<u8>, TransportError>>,
    /// All bytes written, in order.
    pub writes: Vec<Vec<u8>>,
    /// Number of successful reads.
    pub read_count: usize,
    /// Whether [`Transport::close`] was called.
    pub closed: bool,
}

impl MockTransport {
    /// Create an empty mock.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue an expected write. The next write must match exactly.
    pub fn expect_write(&mut self, bytes: impl Into<Vec<u8>>) {
        self.expected_writes.push_back(bytes.into());
    }

    /// Queue a successful read response.
    pub fn queue_read(&mut self, bytes: impl Into<Vec<u8>>) {
        self.reads.push_back(Ok(bytes.into()));
    }

    /// Queue a failed read.
    pub fn queue_read_error(&mut self, error: TransportError) {
        self.reads.push_back(Err(error));
    }

    /// Number of queued reads not yet consumed.
    #[must_use]
    pub fn pending_reads(&self) -> usize {
        self.reads.len()
    }

    /// Number of expected writes not yet consumed.
    #[must_use]
    pub fn pending_writes(&self) -> usize {
        self.expected_writes.len()
    }

    /// True when every scripted write and read was consumed.
    #[must_use]
    pub fn is_exhausted(&self) -> bool {
        self.reads.is_empty() && self.expected_writes.is_empty()
    }
}

impl Transport for MockTransport {
    fn write(&mut self, bytes: &[u8]) -> Result<usize, TransportError> {
        if let Some(expected) = self.expected_writes.pop_front() {
            if expected != bytes {
                return Err(TransportError::ScriptMismatch {
                    expected,
                    actual: bytes.to_vec(),
                });
            }
        }
        self.writes.push(bytes.to_vec());
        Ok(bytes.len())
    }

    fn read(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize, TransportError> {
        match self.reads.pop_front() {
            Some(Ok(response)) => {
                if response.len() > buf.len() {
                    return Err(TransportError::BufferTooSmall {
                        buffer: buf.len(),
                        pending: response.len(),
                    });
                }
                buf[..response.len()].copy_from_slice(&response);
                self.read_count += 1;
                Ok(response.len())
            }
            Some(Err(error)) => Err(error),
            None => Err(TransportError::Timeout),
        }
    }

    fn close(&mut self) -> Result<(), TransportError> {
        self.closed = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_matches_writes_and_returns_reads() {
        let mut mock = MockTransport::new();
        mock.expect_write(vec![1, 2, 3]);
        mock.queue_read(vec![9, 8]);
        assert_eq!(mock.write(&[1, 2, 3]).unwrap(), 3);
        let mut buf = [0u8; 8];
        assert_eq!(mock.read(&mut buf, Duration::ZERO).unwrap(), 2);
        assert_eq!(&buf[..2], &[9, 8]);
        assert!(mock.is_exhausted());
    }

    #[test]
    fn mock_rejects_unexpected_write() {
        let mut mock = MockTransport::new();
        mock.expect_write(vec![1]);
        assert!(matches!(
            mock.write(&[2]),
            Err(TransportError::ScriptMismatch { .. })
        ));
    }

    #[test]
    fn mock_times_out_without_queued_read() {
        let mut mock = MockTransport::new();
        let mut buf = [0u8; 8];
        assert_eq!(
            mock.read(&mut buf, Duration::ZERO).unwrap_err(),
            TransportError::Timeout
        );
    }

    #[test]
    fn mock_rejects_response_larger_than_buffer() {
        let mut mock = MockTransport::new();
        mock.queue_read(vec![0u8; 16]);
        let mut buf = [0u8; 8];
        assert!(matches!(
            mock.read(&mut buf, Duration::ZERO),
            Err(TransportError::BufferTooSmall { .. })
        ));
    }
}
