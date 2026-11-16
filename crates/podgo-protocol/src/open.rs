//! Object/stream open messages and response decoding.
//!
//! Request body layout (MessagePack map, insertion order preserved):
//!
//! ```text
//! {102: transaction, 100: operation, 101: params}
//! ```
//!
//! Wire layout matches the reference `build_vendor_open`: 16-byte header,
//! subheader `01 00 02 00`, a `u16` MessagePack length, two reserved bytes, then
//! the body padded to a multiple of four.
//!
//! The cursor field is not yet understood for arbitrary objects; callers must
//! supply it explicitly. Passing `0` is a documented placeholder, not a
//! verified value.

use podgo_domain::msgpack::{self, Value};

use crate::constants::{CMD_SESSION_OPEN, KEY_ERROR_CODE, KEY_RESULT, KEY_STATUS, MAGIC_STANDARD};
use crate::error::ProtocolError;
use crate::frame::{Frame, HEADER_LEN};

/// A request to open an object or stream.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenRequest {
    /// Transaction id (body key 102).
    pub transaction: u64,
    /// Operation/object id (body key 100).
    pub operation: u64,
    /// Request parameters (body key 101).
    pub params: Value,
}

impl OpenRequest {
    /// Build a request with an empty parameter map.
    #[must_use]
    pub fn new(transaction: u64, operation: u64) -> Self {
        Self {
            transaction,
            operation,
            params: Value::map(Vec::new()),
        }
    }
}

/// Encode an open request for the read or write channel.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] when the MessagePack body exceeds
/// the `u8` length field, or a MessagePack encoding error.
pub fn encode_open(
    request: &OpenRequest,
    source: u16,
    destination: u16,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(request.transaction)),
        (Value::uint(100), Value::uint(request.operation)),
        (Value::uint(101), request.params.clone()),
    ]);
    let body_bytes = msgpack::encode(&body)?;

    let length_byte = u8::try_from(HEADER_LEN + body_bytes.len()).map_err(|_| {
        ProtocolError::InvalidFrame("open body length does not fit in the header byte")
    })?;
    let body_len = u16::try_from(body_bytes.len())
        .map_err(|_| ProtocolError::InvalidFrame("open body exceeds u16 length field"))?;

    let mut header = [0u8; HEADER_LEN];
    header[0] = length_byte;
    header[3] = MAGIC_STANDARD;
    header[4..6].copy_from_slice(&source.to_le_bytes());
    header[6..8].copy_from_slice(&destination.to_le_bytes());
    header[9] = seq;
    header[11] = CMD_SESSION_OPEN;
    header[12..16].copy_from_slice(&cursor.to_le_bytes());

    let mut frame_body = Vec::with_capacity(8 + body_bytes.len() + 3);
    frame_body.extend_from_slice(&[0x01, 0x00, 0x02, 0x00]);
    frame_body.extend_from_slice(&body_len.to_le_bytes());
    frame_body.extend_from_slice(&[0x00, 0x00]);
    frame_body.extend_from_slice(&body_bytes);
    let pad = (4 - body_bytes.len() % 4) % 4;
    frame_body.extend(std::iter::repeat(0u8).take(pad));

    Ok(Frame::from_parts(header, frame_body).to_bytes())
}

/// Extract the MessagePack payload from a response frame.
///
/// Handles both observed shapes:
/// - framed: subheader (`01 00` or `00 00`) + `u16` length + reserved,
/// - raw window: MessagePack starts immediately after the 16-byte header.
///
/// # Errors
///
/// Returns [`ProtocolError::BodyLengthMismatch`] when a framed body is shorter
/// than its declared length.
pub fn payload(frame: &Frame) -> Result<&[u8], ProtocolError> {
    let body = frame.body();
    if body.len() >= 8
        && ((body[0] == 0x01 && body[1] == 0x00) || (body[0] == 0x00 && body[1] == 0x00))
    {
        // The subheader declares a 32-bit body length (confirmed on data and
        // event frames in the fw 2.50 captures).
        let declared = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
        let declared = usize::try_from(declared)
            .map_err(|_| ProtocolError::InvalidFrame("body length overflow"))?;
        let end = 8usize
            .checked_add(declared)
            .ok_or(ProtocolError::InvalidFrame("body length overflow"))?;
        if body.len() < end {
            return Err(ProtocolError::BodyLengthMismatch {
                declared,
                available: body.len().saturating_sub(8),
            });
        }
        Ok(&body[8..end])
    } else {
        Ok(body)
    }
}

/// A decoded open response.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenResponse {
    /// Status (key 103), if present.
    pub status: Option<u64>,
    /// Result payload (key 104), if present.
    pub result: Option<Value>,
    /// Error code (key 111 inside the result), if present.
    pub error_code: Option<u64>,
    /// Full decoded body, for diagnostics and unknown keys.
    pub body: Value,
}

impl OpenResponse {
    /// Convert to a result, treating a missing status as a protocol error.
    ///
    /// # Errors
    ///
    /// Returns [`ProtocolError::DeviceStatus`] for a non-zero status and
    /// [`ProtocolError::MissingField`] when key 103 is absent.
    pub fn ensure_ok(self) -> Result<Value, ProtocolError> {
        let Self {
            status,
            result,
            error_code,
            ..
        } = self;
        match status {
            Some(0) => Ok(result.unwrap_or(Value::Nil)),
            Some(status) => Err(ProtocolError::DeviceStatus {
                status,
                code: error_code,
            }),
            None => Err(ProtocolError::MissingField("103")),
        }
    }
}

/// Decode an open response frame.
///
/// # Errors
///
/// Returns framing errors or MessagePack errors.
pub fn decode_open_response(frame: &Frame) -> Result<OpenResponse, ProtocolError> {
    let bytes = payload(frame)?;
    let body = msgpack::decode(bytes)?;
    let status = body.get_u64(KEY_STATUS).and_then(Value::as_u64);
    let result = body.get_u64(KEY_RESULT).cloned();
    let error_code = result
        .as_ref()
        .and_then(|value| value.get_u64(KEY_ERROR_CODE))
        .and_then(Value::as_u64);
    Ok(OpenResponse {
        status,
        result,
        error_code,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{READ_DST, READ_SRC};

    fn framed(body: &[u8]) -> Frame {
        let mut bytes = vec![0u8; HEADER_LEN];
        bytes[3] = 0x18;
        bytes[4..6].copy_from_slice(&READ_DST.to_le_bytes());
        bytes[6..8].copy_from_slice(&READ_SRC.to_le_bytes());
        bytes[11] = 0x04;
        bytes.extend_from_slice(&[0x01, 0x00, 0x02, 0x00]);
        bytes.extend_from_slice(&(body.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(body);
        Frame::parse(&bytes).unwrap()
    }

    #[test]
    fn open_request_has_expected_shape() {
        let request = OpenRequest::new(1002, 22);
        let frame = encode_open(&request, READ_SRC, READ_DST, 0x06, 0x1000).unwrap();
        assert_eq!(frame[3], 0x18);
        assert_eq!(&frame[4..8], &[0x01, 0x10, 0xef, 0x03]);
        assert_eq!(frame[9], 0x06);
        assert_eq!(frame[11], 0x04);
        assert_eq!(&frame[12..16], &0x1000u32.to_le_bytes());
        assert_eq!(&frame[16..20], &[0x01, 0x00, 0x02, 0x00]);
        let decoded = Frame::parse(&frame).unwrap();
        let value = msgpack::decode(payload(&decoded).unwrap()).unwrap();
        assert_eq!(value.get_u64(100).and_then(Value::as_u64), Some(22));
        assert_eq!(value.get_u64(102).and_then(Value::as_u64), Some(1002));
    }

    #[test]
    fn decodes_framed_response() {
        let body = Value::map(vec![
            (Value::uint(KEY_STATUS), Value::uint(0)),
            (Value::uint(KEY_RESULT), Value::str("payload")),
        ]);
        let bytes = msgpack::encode(&body).unwrap();
        let response = decode_open_response(&framed(&bytes)).unwrap();
        assert_eq!(response.status, Some(0));
        assert_eq!(
            response.result.as_ref().and_then(Value::as_str),
            Some("payload")
        );
        assert_eq!(response.ensure_ok().unwrap().as_str(), Some("payload"));
    }

    #[test]
    fn decodes_raw_window_response() {
        let body = Value::map(vec![(Value::uint(KEY_STATUS), Value::uint(0))]);
        let bytes = msgpack::encode(&body).unwrap();
        let mut frame_bytes = vec![0u8; HEADER_LEN];
        frame_bytes.extend_from_slice(&bytes);
        let frame = Frame::parse(&frame_bytes).unwrap();
        let response = decode_open_response(&frame).unwrap();
        assert_eq!(response.status, Some(0));
    }

    #[test]
    fn non_zero_status_is_an_error() {
        let body = Value::map(vec![
            (Value::uint(KEY_STATUS), Value::uint(3)),
            (
                Value::uint(KEY_RESULT),
                Value::map(vec![(Value::uint(KEY_ERROR_CODE), Value::uint(9))]),
            ),
        ]);
        let bytes = msgpack::encode(&body).unwrap();
        let err = decode_open_response(&framed(&bytes))
            .unwrap()
            .ensure_ok()
            .unwrap_err();
        assert_eq!(
            err,
            ProtocolError::DeviceStatus {
                status: 3,
                code: Some(9)
            }
        );
    }

    #[test]
    fn missing_status_is_an_error() {
        let body = Value::map(vec![]);
        let bytes = msgpack::encode(&body).unwrap();
        let err = decode_open_response(&framed(&bytes))
            .unwrap()
            .ensure_ok()
            .unwrap_err();
        assert_eq!(err, ProtocolError::MissingField("103"));
    }

    #[test]
    fn truncated_framed_body_is_rejected() {
        let mut bytes = vec![0u8; HEADER_LEN];
        bytes.extend_from_slice(&[0x01, 0x00, 0x02, 0x00, 0x10, 0x00, 0x00, 0x00]);
        let frame = Frame::parse(&bytes).unwrap();
        assert!(matches!(
            payload(&frame),
            Err(ProtocolError::BodyLengthMismatch { .. })
        ));
    }
}
