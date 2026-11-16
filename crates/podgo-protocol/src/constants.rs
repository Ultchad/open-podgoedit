//! Protocol constants.
//!
//! Confidence and evidence for each value are recorded in
//! `docs/reverse-engineering/protocol-specification.md`.

/// Line 6 vendor id. Confirmed in both 2.50 binaries and the reference project.
pub const VENDOR_ID: u16 = 0x0E41;
/// POD Go product id. Confirmed in both binaries.
pub const PRODUCT_ID_POD_GO: u16 = 0x4247;
/// POD Go Wireless product id. Strongly supported; role not hardware-tested.
pub const PRODUCT_ID_POD_GO_WIRELESS: u16 = 0x424B;
/// NXP vendor id seen in the update/bootloader comparison. Strongly supported.
pub const VENDOR_ID_BOOTLOADER: u16 = 0x1FC9;
/// Bootloader sub-id seen alongside [`VENDOR_ID_BOOTLOADER`].
pub const PRODUCT_ID_BOOTLOADER: u16 = 0x000C;

/// Read channel source.
pub const READ_SRC: u16 = 0x1001;
/// Read channel destination.
pub const READ_DST: u16 = 0x03EF;
/// Write channel source.
pub const WRITE_SRC: u16 = 0x1080;
/// Write channel destination.
pub const WRITE_DST: u16 = 0x03ED;
/// Event channel source (host to device polls).
pub const EVENT_SRC: u16 = 0x1002;
/// Event channel destination.
pub const EVENT_DST: u16 = 0x03F0;

/// Magic byte on the first handshake packet.
pub const MAGIC_HANDSHAKE: u8 = 0x28;
/// Magic byte on every other packet.
pub const MAGIC_STANDARD: u8 = 0x18;

/// First application sequence number after the handshake.
pub const FIRST_APP_SEQ: u8 = 0x06;
/// First sequence number on the event channel after its handshake.
pub const EVENT_FIRST_SEQ: u8 = 0x04;
/// Event-channel rest cursor after opening (`EVENT_CHUNK` cursor field).
pub const EVENT_REST_CURSOR: u32 = 0x1009;
/// Event poll read timeout; the device answers quickly or has nothing.
pub const EVENT_POLL_TIMEOUT_MS: u64 = 200;

/// Command: open object/stream.
pub const CMD_OPEN: u8 = 0x01;
/// Command: handshake.
pub const CMD_HANDSHAKE: u8 = 0x02;
/// Command: session open.
pub const CMD_SESSION_OPEN: u8 = 0x04;
/// Command: session chunk / chunk request.
pub const CMD_SESSION_CHUNK: u8 = 0x08;
/// Command: event poll.
pub const CMD_POLL: u8 = 0x10;

/// Default per-operation timeout in milliseconds.
pub const OP_TIMEOUT_MS: u64 = 2_000;
/// Default stale-data drain timeout in milliseconds.
pub const DRAIN_TIMEOUT_MS: u64 = 50;
/// Default bulk read buffer size.
pub const READ_BUFFER: usize = 512;

/// Preset stream base offset.
pub const STREAM_BASE_OFFSET: u32 = 0x1000;
/// Fresh window per stream chunk.
pub const STREAM_WINDOW: usize = 0x100;
/// Stream chunk offset step.
pub const CHUNK_OFFSET_STEP: u32 = 0x0100;
/// First chunk-request sequence number.
pub const CHUNK_FIRST_SEQ: u8 = 0x08;
/// Maximum chunk requests for one stream.
pub const MAX_CHUNKS: usize = 64;
/// Header bytes before the first data packet's payload.
pub const FIRST_DATA_HEADER_LEN: usize = 24;
/// Maximum bytes assembled for one preset stream (64 KiB).
pub const MAX_STREAM_BYTES: usize = 64 * 1024;
/// Number of presets per setlist.
pub const PRESET_COUNT: usize = 128;
/// Byte of `OPEN_STREAM` that selects the setlist.
pub const OPEN_STREAM_SETLIST_BYTE: usize = 34;

/// Object id: setlists.
pub const OBJECT_SETLISTS: u16 = 0;
/// Object id: preset list.
pub const OBJECT_PRESET_LIST: u16 = 1;
/// Object id: IR list.
pub const OBJECT_IR_LIST: u16 = 13;
/// Object id: per-slot seal table.
pub const OBJECT_SEALS: u16 = 14;
/// Object id: active preset blob.
pub const OBJECT_ACTIVE_PRESET: u16 = 22;
/// Object id: active state.
pub const OBJECT_ACTIVE_STATE: u16 = 23;
/// Object id: flags.
pub const OBJECT_FLAGS: u16 = 24;

/// Response/body key: status.
pub const KEY_STATUS: u64 = 103;
/// Response/body key: result.
pub const KEY_RESULT: u64 = 104;
/// Response/body key: error code.
pub const KEY_ERROR_CODE: u64 = 111;
/// Notification key: opcode.
pub const KEY_EVENT_OPCODE: u64 = 105;
/// Notification key: data.
pub const KEY_EVENT_DATA: u64 = 106;
