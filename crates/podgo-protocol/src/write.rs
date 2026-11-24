//! Write-channel commands (`0x1080 → 0x03ED`), compiled only with the
//! `device-write` feature.
//!
//! Writes are opt-in twice over (ADR-0007): this module only exists when the
//! feature is enabled, and the web app additionally requires the user to arm
//! writes and confirm each change.
//!
//! # Evidence
//!
//! The write channel, its four-packet handshake and the `set_param` payload
//! are documented in `docs/reverse-engineering/protocol-specification.md` §6.11
//! and `docs/protocol/writes.md`. The payload keys come from the reference
//! implementation, which states that they were verified on hardware:
//! parameter index in key `28` (key `26` stays `0`), value in key `119`.
//! Sending the index in key `26` makes the device answer status `255` and
//! apply nothing.
//!
//! No `set_param` request frame exists in the *earlier* captures in
//! `reverse/exports/` (those contain the pedal's op-30 *notifications*, not
//! the editor's request). Ten editor-sent op-30 frames in
//! `podgo-preset-save.pcapng` now match [`encode_set_param`] byte for byte, and
//! that capture also contains the golden [`encode_save_preset`] frame.
//!
//! # `set_param` body
//!
//! | Key | Value | Evidence |
//! |---|---|---|
//! | `102` | transaction id | C, echoed in the status body |
//! | `100` | `30` | C, op table |
//! | `101.98` | raw chain index (input is `0`) | C, reference, hardware-validated |
//! | `101.29` | `true` | C, reference |
//! | `101.26` | `0` | C, reference (must stay `0`) |
//! | `101.28` | parameter index | C, reference, hardware-validated |
//! | `101.119` | value, MessagePack `f32` (`ca`) | C, reference |
//!
//! # `save_preset` body
//!
//! | Key | Value | Evidence |
//! |---|---|---|
//! | `102` | transaction id | C, captured editor frame |
//! | `100` | `71` | C, captured editor frame |
//! | `101.107` | destination setlist (`1` = User) | C, captured editor frame |
//! | `101.108` | destination slot | C, captured editor frame |
//! | `101.109` | visible name + one NUL, `str` | C, captured editor frame |
//!
//! Op 71 is metadata-only: the save capture contains no object-14 access and
//! no preset-body upload.
//!
//! The command frame uses subheader `01 00 06 00`, header byte 0 = `16 + body
//! length`, header byte 3 = `0x18`, header byte 11 = `0x04`. The cursor starts
//! at [`WRITE_OPEN_2_CURSOR`] plus the advance of object 76's response and
//! moves by the command's footprint. The device discards a command whose
//! cursor is out of step (it acks, applies nothing).

use podgo_domain::msgpack::{self, Value};

use crate::constants::{
    CMD_SESSION_OPEN, KEY_ERROR_CODE, KEY_STATUS, MAGIC_STANDARD, READ_DST, READ_SRC, WRITE_DST,
    WRITE_SRC,
};
use crate::error::ProtocolError;
use crate::frame::{Frame, HEADER_LEN};
use crate::notification::{OP_SAVE_PRESET, OP_SET_MODEL, OP_SET_PARAM};

/// Write-channel handshake packet 1 (20 bytes).
///
/// Same body as the read handshake, with `src`/`dst` swapped to
/// `0x1080 → 0x03ED`.
pub const WRITE_HANDSHAKE: &[u8] = &[
    0x0c, 0x00, 0x00, 0x28, 0x80, 0x10, 0xed, 0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x21,
    0x00, 0x10, 0x00, 0x00,
];

/// Write-channel handshake packet 2 (28 bytes): session open, type `6`.
pub const WRITE_OPEN_1: &[u8] = &[
    0x11, 0x00, 0x00, 0x18, 0x80, 0x10, 0xed, 0x03, 0x00, 0x02, 0x00, 0x04, 0x00, 0x10, 0x00, 0x00,
    0x01, 0x00, 0x06, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
];

/// Write-channel handshake packet 3 (16 bytes): chunk grant, cursor `0x1009`.
pub const WRITE_CHUNK_1: &[u8] = &[
    0x08, 0x00, 0x00, 0x18, 0x80, 0x10, 0xed, 0x03, 0x00, 0x03, 0x00, 0x08, 0x09, 0x10, 0x00, 0x00,
];

/// Write-channel handshake packet 4 (36 bytes): open object 76.
pub const WRITE_OPEN_2: &[u8] = &[
    0x19, 0x00, 0x00, 0x18, 0x80, 0x10, 0xed, 0x03, 0x00, 0x04, 0x00, 0x04, 0x09, 0x10, 0x00, 0x00,
    0x01, 0x00, 0x06, 0x00, 0x09, 0x00, 0x00, 0x00, 0x83, 0x66, 0xcd, 0x03, 0xe8, 0x64, 0x4c, 0x65,
    0x80, 0x00, 0x00, 0x00,
];

/// The four packets that open the write channel, in order.
pub const WRITE_SEQUENCE: [&[u8]; 4] = [WRITE_HANDSHAKE, WRITE_OPEN_1, WRITE_CHUNK_1, WRITE_OPEN_2];

/// Cursor carried by [`WRITE_OPEN_2`] (bytes 12..16, little-endian).
pub const WRITE_OPEN_2_CURSOR: u32 = 0x1009;

/// First sequence number used by a write command after the handshake.
///
/// The handshake consumes `0x00..=0x04`; the reference starts commands at
/// `0x05`.
pub const WRITE_FIRST_COMMAND_SEQ: u8 = 0x05;

/// Write-command subheader (`01 00 06 00`).
pub const WRITE_SUBHEADER: [u8; 4] = [0x01, 0x00, 0x06, 0x00];

/// Subheaders that mark a framed write response carrying a status body.
pub const WRITE_FRAMED_SUBHEADERS: [[u8; 4]; 2] =
    [[0x00, 0x00, 0x06, 0x00], [0x01, 0x00, 0x06, 0x00]];

/// Build a `set_param` write frame (operation 30).
///
/// Body: `{102: transaction, 100: 30, 101: {98: block, 29: true, 26: 0,
/// 28: param, 119: value}}`.
///
/// `block` is the **raw** chain index (input is 0), not the processing-slot
/// index. `param` is the catalog position of the parameter.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] when the value is not finite or the
/// body does not fit the header fields, and a MessagePack error when encoding
/// fails.
pub fn encode_set_param(
    block: u32,
    param: u32,
    value: f32,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    if !value.is_finite() {
        return Err(ProtocolError::InvalidFrame("parameter value is not finite"));
    }
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(OP_SET_PARAM)),
        (
            Value::uint(101),
            Value::map(vec![
                (Value::uint(98), Value::uint(u64::from(block))),
                (Value::uint(29), Value::Bool(true)),
                (Value::uint(26), Value::uint(0)),
                (Value::uint(28), Value::uint(u64::from(param))),
                // The device expects a 32-bit float (MessagePack `ca`).
                (Value::uint(119), Value::F32(value)),
            ]),
        ),
    ]);
    let body_bytes = msgpack::encode(&body)?;
    build_write_command(&body_bytes, seq, cursor)
}

/// Build a `set_model` write frame (operation 40).
///
/// Body: `{102: transaction, 100: 40, 101: {98: block, 100: {23:
/// no_snapshot_bypass, 25: wire_id, 26: -1}}}`.
///
/// `block` is the **raw** chain index (input is 0), exactly like
/// [`encode_set_param`]. `wire_id` is the catalog's on-wire model id. The pedal
/// loads the model with its own defaults; parameter values are not part of the
/// command.
///
/// # Evidence
///
/// The layout comes from the MIT reference's annotated
/// `change-pedal-from-app.pcapng` (packet 35), not from a capture stored in
/// this repository. It is therefore `ITM`: unit-tested offline, not yet
/// validated on hardware. The model node mirrors the `l6-helix` key 24 body
/// documented in `docs/protocol/presets.md`.
///
/// # Errors
///
/// Returns a MessagePack error when encoding fails, or
/// [`ProtocolError::InvalidFrame`] when the body does not fit the header.
pub fn encode_set_model(
    block: u32,
    wire_id: u32,
    no_snapshot_bypass: bool,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(OP_SET_MODEL)),
        (
            Value::uint(101),
            Value::map(vec![
                (Value::uint(98), Value::uint(u64::from(block))),
                (
                    Value::uint(100),
                    Value::map(vec![
                        (Value::uint(23), Value::Bool(no_snapshot_bypass)),
                        (Value::uint(25), Value::uint(u64::from(wire_id))),
                        // The reference sends -1, not nil or 0.
                        (Value::uint(26), Value::int(-1)),
                    ]),
                ),
            ]),
        ),
    ]);
    let body_bytes = msgpack::encode(&body)?;
    build_write_command(&body_bytes, seq, cursor)
}

/// Maximum preset-name length accepted by [`encode_save_preset`].
///
/// The pedal stores names as a NUL-terminated string and every name in the
/// captured setlists is at most 16 printable ASCII bytes.
pub const MAX_PRESET_NAME_BYTES: usize = 16;

/// Validate a preset name for [`encode_save_preset`].
///
/// Names are 1..=16 printable ASCII bytes. The device adds the trailing NUL
/// itself; callers pass the visible name only.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an empty, over-long or
/// non-printable name.
pub fn validate_preset_name(name: &str) -> Result<(), ProtocolError> {
    if name.is_empty() {
        return Err(ProtocolError::InvalidFrame("preset name is empty"));
    }
    if name.len() > MAX_PRESET_NAME_BYTES {
        return Err(ProtocolError::InvalidFrame(
            "preset name is longer than 16 bytes",
        ));
    }
    if !name.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
        return Err(ProtocolError::InvalidFrame(
            "preset name contains a non-printable character",
        ));
    }
    Ok(())
}

/// Build a `save_preset` write frame (operation 71).
///
/// Body: `{102: transaction, 100: 71, 101: {107: setlist, 108: slot,
/// 109: "<name>\0"}}`.
///
/// The golden vector in the tests is the exact frame captured from POD Go Edit
/// in `reverse/exports/podgo-preset-save.pcapng` (transaction `1016`,
/// setlist `1`, slot `36`, name `New Preset`, seq `0x3e`, cursor `0x1fe8`).
/// The command is metadata-only: it does not touch object 14 and does not
/// upload the preset body.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an invalid name or a body that
/// does not fit the header fields, and a MessagePack error when encoding
/// fails.
pub fn encode_save_preset(
    setlist: u32,
    slot: u32,
    name: &str,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    validate_preset_name(name)?;

    let mut name_bytes = name.as_bytes().to_vec();
    name_bytes.push(0);
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(OP_SAVE_PRESET)),
        (
            Value::uint(101),
            Value::map(vec![
                (Value::uint(107), Value::uint(u64::from(setlist))),
                (Value::uint(108), Value::uint(u64::from(slot))),
                (Value::uint(109), Value::str_bytes(name_bytes)),
            ]),
        ),
    ]);
    let body_bytes = msgpack::encode(&body)?;
    build_write_command(&body_bytes, seq, cursor)
}

/// Recall a stored preset: make it the pedal's active sound (operation 20).
///
/// Captured in `podgo-bypass-and-remove-effect.pcapng` as
/// `{102: txn, 100: 20, 101: {107: setlist, 108: slot}}`, answered by a framed
/// status **1** (not 0). Recalling does not store anything: it loads the slot
/// into the edit buffer, exactly like turning the pedal's own knob.
pub const OP_RECALL_PRESET: u64 = 20;

/// Set one block's bypass state (operation 41).
///
/// Captured in `podgo-bypass-and-remove-effect.pcapng` as
/// `{102: txn, 100: 41, 101: {98: raw_block, 59: enabled}}`. Key `59` is the
/// block's enabled flag, not its bypass flag: the pedal's op-49 notification
/// echoes the same boolean. Status **0**.
pub const OP_SET_BYPASS: u64 = 41;

/// Remove one effect from the chain (operation 28).
///
/// Captured in `podgo-bypass-and-remove-effect.pcapng` as
/// `{102: txn, 100: 28, 101: {98: raw_block}}`; the official editor sends
/// [`OP_REMOVE_EFFECT_COMMIT`] a few seconds later. Status **0**.
pub const OP_REMOVE_EFFECT: u64 = 28;

/// Second half of the remove-effect pair (operation 78).
///
/// Same body as [`OP_REMOVE_EFFECT`]. The pedal emits op-33/op-49
/// notifications once the slot is empty.
pub const OP_REMOVE_EFFECT_COMMIT: u64 = 78;

/// Upload a whole chain (operation 21).
///
/// The body is `{102: txn, 100: 21, 101: {110: <l6-helix blob>}}`, streamed on
/// the write channel in 512-byte frames. The pedal answers a framed status
/// **1**, which is what advances the stream cursor. See
/// `docs/protocol/writes.md`.
pub const OP_CHAIN_WRITE: u64 = 21;

/// Status meaning "accepted" for a streamed command.
///
/// Ordinary writes answer `0`; op 20 and op 21 answer `1`. The flows accept
/// both where the capture shows both shapes.
pub const WRITE_STATUS_ACCEPTED: u64 = 1;

/// Build a recall-preset frame (operation 20).
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an unknown setlist or a slot
/// above 127, and a MessagePack error when encoding fails.
pub fn encode_recall_preset(
    setlist: u8,
    slot: u8,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    if setlist > 1 {
        return Err(ProtocolError::InvalidFrame(
            "recall setlist must be 0 (Factory) or 1 (User)",
        ));
    }
    if slot >= 128 {
        return Err(ProtocolError::InvalidFrame("recall slot is above 127"));
    }
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(OP_RECALL_PRESET)),
        (
            Value::uint(101),
            Value::map(vec![
                (Value::uint(107), Value::uint(u64::from(setlist))),
                (Value::uint(108), Value::uint(u64::from(slot))),
            ]),
        ),
    ]);
    let body_bytes = msgpack::encode(&body)?;
    build_write_command(&body_bytes, seq, cursor)
}

/// Build a bypass write frame (operation 41).
///
/// `block` is the **raw** chain index (input is 0); `enabled` is the state to
/// apply (`true` = effect on, `false` = bypassed).
///
/// # Errors
///
/// Returns a MessagePack error when encoding fails.
pub fn encode_set_bypass(
    block: u32,
    enabled: bool,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(OP_SET_BYPASS)),
        (
            Value::uint(101),
            Value::map(vec![
                (Value::uint(98), Value::uint(u64::from(block))),
                (Value::uint(59), Value::Bool(enabled)),
            ]),
        ),
    ]);
    let body_bytes = msgpack::encode(&body)?;
    build_write_command(&body_bytes, seq, cursor)
}

/// Recall one of the four snapshots (operation 88).
///
/// Captured in `podgo-snapshots.pcapng` (2026-11-24) as
/// `{102: txn, 100: 88, 101: {92: index}}`, answered by status **0** and the
/// `105:42`/`105:46` notifications. The index is 0-based.
pub const OP_SNAPSHOT_RECALL: u64 = 88;

/// Rename one snapshot (operation 89).
///
/// Captured as `{102: txn, 100: 89, 101: {92: index, 109: "<name>\0"}}`,
/// answered by status **0** and the `105:43` notification echoing the name.
pub const OP_SNAPSHOT_RENAME: u64 = 89;

/// Set one snapshot's footswitch LED palette index (operation 98).
///
/// Captured as `{102: txn, 100: 98, 101: {92: index, 66: palette}}`, answered
/// by status **0** and the `105:48` notification.
pub const OP_SNAPSHOT_LED_COLOR: u64 = 98;

/// Assign a parameter to the Snapshots controller (operation 37).
///
/// Captured as
/// `{102: txn, 100: 37, 101: {98: block, 29: true, 26: 0, 28: param, 74: 11, 71: param}}`,
/// answered by status **0**, a `105:34` controller notification and a
/// parameter readback. Key `74` is the controller number; the captured pedal
/// reports **11** for Snapshots (the `.pgp` document uses `10`).
pub const OP_SNAPSHOT_PARAM: u64 = 37;

/// Wire controller number the pedal reports for the Snapshots controller.
///
/// `podgo-snapshots.pcapng` answers op 37 with
/// `{0: 11, 1: <param>, 5: <block>}`, so the on-wire number is `11`. Line 6
/// `.hlx`/`.pgp` documents use `10` for the same controller; the page keeps
/// documents at `10` and translates at the device boundary.
pub const SNAPSHOT_CONTROLLER_WIRE: u64 = 11;

/// Longest snapshot label the pedal's Rename Snapshot screen accepts.
pub const MAX_SNAPSHOT_NAME_BYTES: usize = 10;

/// Validate a snapshot label: printable ASCII, at most 10 bytes, or empty.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for a control byte, a non-ASCII
/// byte or a label longer than [`MAX_SNAPSHOT_NAME_BYTES`].
pub fn validate_snapshot_name(name: &str) -> Result<(), ProtocolError> {
    if name.len() > MAX_SNAPSHOT_NAME_BYTES {
        return Err(ProtocolError::InvalidFrame(
            "snapshot name is longer than 10 bytes",
        ));
    }
    if let Some(byte) = name.bytes().find(|byte| !(0x20..=0x7e).contains(byte)) {
        return Err(ProtocolError::InvalidFrame(if byte < 0x20 {
            "snapshot name contains a control byte"
        } else {
            "snapshot name contains a non-ASCII byte"
        }));
    }
    Ok(())
}

fn validate_snapshot_index(index: u32) -> Result<(), ProtocolError> {
    if index >= 4 {
        return Err(ProtocolError::InvalidFrame("snapshot index is above 3"));
    }
    Ok(())
}

fn encode_snapshot_body(
    operation: u64,
    params: Vec<(Value, Value)>,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(operation)),
        (Value::uint(101), Value::map(params)),
    ]);
    let body_bytes = msgpack::encode(&body)?;
    build_write_command(&body_bytes, seq, cursor)
}

/// Build a snapshot-recall frame (operation 88).
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] when `index` is above 3.
pub fn encode_snapshot_recall(
    index: u32,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    validate_snapshot_index(index)?;
    encode_snapshot_body(
        OP_SNAPSHOT_RECALL,
        vec![(Value::uint(92), Value::uint(u64::from(index)))],
        transaction,
        seq,
        cursor,
    )
}

/// Build a snapshot-rename frame (operation 89).
///
/// The encoder appends the NUL the pedal stores, like `save_preset`.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an index above 3 or an invalid
/// name, and a MessagePack error when encoding fails.
pub fn encode_snapshot_rename(
    index: u32,
    name: &str,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    validate_snapshot_index(index)?;
    validate_snapshot_name(name)?;
    let mut name_bytes = name.as_bytes().to_vec();
    name_bytes.push(0);
    encode_snapshot_body(
        OP_SNAPSHOT_RENAME,
        vec![
            (Value::uint(92), Value::uint(u64::from(index))),
            (Value::uint(109), Value::str_bytes(name_bytes)),
        ],
        transaction,
        seq,
        cursor,
    )
}

/// Build a snapshot LED-colour frame (operation 98).
///
/// `palette` is the index documented for the LED menu: `0` Auto, `1` White,
/// … `11` Off.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an index above 3 or a palette
/// index above 11.
pub fn encode_snapshot_led_color(
    index: u32,
    palette: u32,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    validate_snapshot_index(index)?;
    if palette > 11 {
        return Err(ProtocolError::InvalidFrame(
            "snapshot LED palette is above 11",
        ));
    }
    encode_snapshot_body(
        OP_SNAPSHOT_LED_COLOR,
        vec![
            (Value::uint(92), Value::uint(u64::from(index))),
            (Value::uint(66), Value::uint(u64::from(palette))),
        ],
        transaction,
        seq,
        cursor,
    )
}

/// Build a parameter-to-snapshot assignment frame (operation 37).
///
/// `block` is the raw chain index (input is `0`) and `param` the catalog
/// position. `assigned` maps to key `29`; the captured editor only shows the
/// assigning direction (`true`), so removal is not sent to the pedal yet.
///
/// # Errors
///
/// Returns a MessagePack error when encoding fails.
pub fn encode_snapshot_param(
    block: u32,
    param: u32,
    assigned: bool,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    encode_snapshot_body(
        OP_SNAPSHOT_PARAM,
        vec![
            (Value::uint(98), Value::uint(u64::from(block))),
            (Value::uint(29), Value::Bool(assigned)),
            (Value::uint(26), Value::uint(0)),
            (Value::uint(28), Value::uint(u64::from(param))),
            (
                Value::uint(74),
                Value::uint(SNAPSHOT_CONTROLLER_WIRE),
            ),
            (Value::uint(71), Value::uint(u64::from(param))),
        ],
        transaction,
        seq,
        cursor,
    )
}

/// Build one half of the remove-effect pair (operations 28 and 78).
///
/// `commit` selects operation 78; `false` selects operation 28.
///
/// # Errors
///
/// Returns a MessagePack error when encoding fails.
pub fn encode_remove_effect(
    block: u32,
    commit: bool,
    transaction: u64,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let operation = if commit {
        OP_REMOVE_EFFECT_COMMIT
    } else {
        OP_REMOVE_EFFECT
    };
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(operation)),
        (
            Value::uint(101),
            Value::map(vec![(Value::uint(98), Value::uint(u64::from(block)))]),
        ),
    ]);
    let body_bytes = msgpack::encode(&body)?;
    build_write_command(&body_bytes, seq, cursor)
}

/// Build the MessagePack body of one op-21 chain upload.
///
/// Body: `{102: transaction, 100: 21, 101: {110: <blob>}}`. Key `110` is a
/// MessagePack `str`, like the restore message, and the bytes are the complete
/// `l6-helix` container (magic + offset table + body).
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an empty body or one that
/// exceeds the 64 KiB stream limit, and a MessagePack error when encoding
/// fails.
pub fn encode_chain_upload(blob: &[u8], transaction: u64) -> Result<Vec<u8>, ProtocolError> {
    if blob.is_empty() {
        return Err(ProtocolError::InvalidFrame("chain upload body is empty"));
    }
    if blob.len() > crate::constants::MAX_STREAM_BYTES {
        return Err(ProtocolError::InvalidFrame(
            "chain upload body exceeds the 64 KiB stream limit",
        ));
    }
    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(OP_CHAIN_WRITE)),
        (
            Value::uint(101),
            Value::map(vec![(Value::uint(110), Value::str_bytes(blob.to_vec()))]),
        ),
    ]);
    Ok(msgpack::encode(&body)?)
}

/// Body bytes carried by the first frame of an op-21 upload.
pub const CHAIN_FIRST_BYTES: usize = 488;

/// Body bytes carried by a continuation frame of an op-21 upload.
pub const CHAIN_CHUNK_BYTES: usize = 496;

/// Cursor advance after the framed op-21 status.
///
/// The two uploads in `podgo-move-effect.pcapng` step the cursor
/// `0x1f19 → 0x1f2a` and `0x1f2a → 0x1f3b` (+17) when the `{102, 103: 1}`
/// reply arrives, exactly like a framed write acknowledgement.
pub const CHAIN_CURSOR_ADVANCE: u32 = 17;

/// Build one frame of an op-21 chain upload.
///
/// The first frame carries `01 00 06 00`, the complete MessagePack length as a
/// `u32`, then up to [`CHAIN_FIRST_BYTES`] bytes. Continuations carry up to
/// [`CHAIN_CHUNK_BYTES`] raw bytes after the 16-byte header. The header length
/// field is `frame_length - 8` and the body is zero-padded to four bytes, as in
/// every captured frame.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] when the frame length does not fit
/// the header fields.
pub fn build_chain_frame(
    data: &[u8],
    total: u32,
    first: bool,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let extra = if first { 8 } else { 0 };
    let length = (HEADER_LEN - 8 + extra)
        .checked_add(data.len())
        .ok_or(ProtocolError::InvalidFrame("chain frame length overflow"))?;
    let length_field = u16::try_from(length)
        .map_err(|_| ProtocolError::InvalidFrame("chain frame length does not fit the header"))?;

    let mut header = [0u8; HEADER_LEN];
    header[0..2].copy_from_slice(&length_field.to_le_bytes());
    header[3] = MAGIC_STANDARD;
    header[4..6].copy_from_slice(&WRITE_SRC.to_le_bytes());
    header[6..8].copy_from_slice(&WRITE_DST.to_le_bytes());
    header[9] = seq;
    header[11] = CMD_SESSION_OPEN;
    header[12..16].copy_from_slice(&cursor.to_le_bytes());

    let mut frame_body = Vec::with_capacity(extra + data.len() + 3);
    if first {
        frame_body.extend_from_slice(&WRITE_SUBHEADER);
        frame_body.extend_from_slice(&total.to_le_bytes());
    }
    frame_body.extend_from_slice(data);
    let pad = (4 - frame_body.len() % 4) % 4;
    frame_body.extend(std::iter::repeat(0u8).take(pad));

    Ok(Frame::from_parts(header, frame_body).to_bytes())
}

/// Restore operation: stream one preset body to a setlist slot.
///
/// `reverse/exports/podgo-backup-restore.pcapng` contains 157 of these
/// messages, sent on the **read** channel (`0x1001 → 0x03EF`). See
/// `docs/protocol/writes.md`.
pub const OP_RESTORE_PRESET: u64 = 5;

/// Restore session opener (`SESSION_OPEN_2` in the read handshake).
pub const OP_RESTORE_SESSION: u64 = 254;

/// Subheader of a streamed restore message (`01 00 02 00`).
pub const RESTORE_SUBHEADER: [u8; 4] = [0x01, 0x00, 0x02, 0x00];

/// Body bytes carried by the first restore frame (512-byte frame minus the
/// 24-byte header plus subheader).
pub const STREAM_FIRST_BYTES: usize = 488;

/// Body bytes carried by a continuation restore frame (512-byte frame minus
/// the 16-byte header).
pub const STREAM_CHUNK_BYTES: usize = 496;

/// Cursor advance after a per-frame stream status (`8` header bytes + a 9-byte
/// status body, exactly like a framed write acknowledgement).
///
/// `podgo-backup-restore.pcapng` shows the cursor stepping `0x52fd → 0x530e`
/// (+17) right after the first status and staying there for the frames that
/// follow, then stepping again after the next status.
pub const RESTORE_CURSOR_ADVANCE: u32 = 17;

/// Build the MessagePack body of one op-5 restore message.
///
/// Body: `{102: transaction, 100: 5, 101: {107: setlist, 108: slot,
/// 123: false, 124: false, 125: 0, 110: <blob>}}`.
///
/// Key `110` is a MessagePack `str` (`da`/`db`) whose bytes are the raw
/// `l6-helix` body; the device does not accept a `bin` marker here. The key
/// order is the one observed in every captured message.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an unknown setlist, a slot above
/// 127, an empty body or a body that exceeds the 64 KiB stream limit, and a
/// MessagePack error when encoding fails.
pub fn encode_restore_preset(
    setlist: u8,
    slot: u8,
    blob: &[u8],
    transaction: u64,
) -> Result<Vec<u8>, ProtocolError> {
    if setlist > 1 {
        return Err(ProtocolError::InvalidFrame(
            "restore setlist must be 0 (Factory) or 1 (User)",
        ));
    }
    if slot >= 128 {
        return Err(ProtocolError::InvalidFrame("restore slot is above 127"));
    }
    if blob.is_empty() {
        return Err(ProtocolError::InvalidFrame("restore preset body is empty"));
    }
    if blob.len() > crate::constants::MAX_STREAM_BYTES {
        return Err(ProtocolError::InvalidFrame(
            "restore preset body exceeds the 64 KiB stream limit",
        ));
    }

    let body = Value::map(vec![
        (Value::uint(102), Value::uint(transaction)),
        (Value::uint(100), Value::uint(OP_RESTORE_PRESET)),
        (
            Value::uint(101),
            Value::map(vec![
                (Value::uint(107), Value::uint(u64::from(setlist))),
                (Value::uint(108), Value::uint(u64::from(slot))),
                (Value::uint(123), Value::Bool(false)),
                (Value::uint(124), Value::Bool(false)),
                (Value::uint(125), Value::uint(0)),
                // The device expects a MessagePack `str`, not `bin`.
                (Value::uint(110), Value::str_bytes(blob.to_vec())),
            ]),
        ),
    ]);
    Ok(msgpack::encode(&body)?)
}

/// One frame of a streamed restore message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamFrame {
    /// Complete frame bytes, ready for the bulk OUT endpoint.
    pub bytes: Vec<u8>,
    /// True when the host must wait for a status-1 response before sending the
    /// next frame; the cursor of subsequent frames is already advanced.
    pub window_end: bool,
}

/// Split a restore body into read-channel frames.
///
/// The first frame carries [`STREAM_FIRST_BYTES`] body bytes after an 8-byte
/// subheader and the complete body length as a `u32`. Continuations carry
/// [`STREAM_CHUNK_BYTES`] raw body bytes after the 16-byte header. Every frame
/// body is padded with zeros to a 4-byte boundary.
///
/// The pedal acknowledges **each frame**, not a fixed byte window:
/// `podgo-backup-restore.pcapng` answers `{102: tx, 103: 1, 104: nil}` after
/// 488, 917, 1313, … body bytes, i.e. once per USB packet. Every frame is
/// therefore marked [`StreamFrame::window_end`], and the cursor advances by
/// [`RESTORE_CURSOR_ADVANCE`] after each granted status.
///
/// # Errors
///
/// Returns [`ProtocolError::InvalidFrame`] for an empty or over-long body, or
/// when a frame length does not fit the header byte.
pub fn encode_restore_stream(
    body: &[u8],
    seq_start: u8,
    cursor: u32,
) -> Result<Vec<StreamFrame>, ProtocolError> {
    if body.is_empty() {
        return Err(ProtocolError::InvalidFrame("restore body is empty"));
    }
    if body.len() > crate::constants::MAX_STREAM_BYTES {
        return Err(ProtocolError::InvalidFrame(
            "restore body exceeds the 64 KiB stream limit",
        ));
    }

    let total = u32::try_from(body.len())
        .map_err(|_| ProtocolError::InvalidFrame("restore body length overflow"))?;
    let mut frames = Vec::with_capacity(body.len() / STREAM_CHUNK_BYTES + 2);
    let mut position = 0usize;
    let mut seq = seq_start;
    let mut cursor = cursor;
    let mut first = true;

    while position < body.len() {
        let chunk = if first {
            STREAM_FIRST_BYTES.min(body.len() - position)
        } else {
            STREAM_CHUNK_BYTES.min(body.len() - position)
        };

        let bytes =
            build_stream_frame(&body[position..position + chunk], total, first, seq, cursor)?;
        // Every frame is acknowledged by the pedal before the next one is sent.
        frames.push(StreamFrame {
            bytes,
            window_end: true,
        });

        position += chunk;
        seq = seq.wrapping_add(1);
        first = false;
        cursor = cursor.wrapping_add(RESTORE_CURSOR_ADVANCE);
    }

    Ok(frames)
}

/// Build one frame of a streamed restore message.
fn build_stream_frame(
    data: &[u8],
    total: u32,
    first: bool,
    seq: u8,
    cursor: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let extra = if first { 8 } else { 0 };
    let length = (HEADER_LEN - 8 + extra)
        .checked_add(data.len())
        .ok_or(ProtocolError::InvalidFrame("stream frame length overflow"))?;
    // Bytes 0..2 are a little-endian u16, like every other streamed frame in
    // the capture (a 512-byte frame carries 504).
    let length_field = u16::try_from(length)
        .map_err(|_| ProtocolError::InvalidFrame("stream frame length does not fit the header"))?;

    let mut header = [0u8; HEADER_LEN];
    header[0..2].copy_from_slice(&length_field.to_le_bytes());
    header[3] = MAGIC_STANDARD;
    header[4..6].copy_from_slice(&READ_SRC.to_le_bytes());
    header[6..8].copy_from_slice(&READ_DST.to_le_bytes());
    header[9] = seq;
    header[11] = CMD_SESSION_OPEN;
    header[12..16].copy_from_slice(&cursor.to_le_bytes());

    let mut frame_body = Vec::with_capacity(extra + data.len() + 3);
    if first {
        frame_body.extend_from_slice(&RESTORE_SUBHEADER);
        frame_body.extend_from_slice(&total.to_le_bytes());
    }
    frame_body.extend_from_slice(data);
    let pad = (4 - frame_body.len() % 4) % 4;
    frame_body.extend(std::iter::repeat(0u8).take(pad));

    Ok(Frame::from_parts(header, frame_body).to_bytes())
}

/// Wrap an encoded MessagePack body in a write-channel command frame.
fn build_write_command(body_bytes: &[u8], seq: u8, cursor: u32) -> Result<Vec<u8>, ProtocolError> {
    let length_byte = u8::try_from(HEADER_LEN + body_bytes.len())
        .map_err(|_| ProtocolError::InvalidFrame("write body length does not fit in the header"))?;
    let body_len = u16::try_from(body_bytes.len())
        .map_err(|_| ProtocolError::InvalidFrame("write body exceeds u16 length field"))?;

    let mut header = [0u8; HEADER_LEN];
    header[0] = length_byte;
    header[3] = MAGIC_STANDARD;
    header[4..6].copy_from_slice(&WRITE_SRC.to_le_bytes());
    header[6..8].copy_from_slice(&WRITE_DST.to_le_bytes());
    header[9] = seq;
    header[11] = CMD_SESSION_OPEN;
    header[12..16].copy_from_slice(&cursor.to_le_bytes());

    let mut frame_body = Vec::with_capacity(8 + body_bytes.len() + 3);
    frame_body.extend_from_slice(&WRITE_SUBHEADER);
    frame_body.extend_from_slice(&body_len.to_le_bytes());
    frame_body.extend_from_slice(&[0x00, 0x00]);
    frame_body.extend_from_slice(body_bytes);
    let pad = (4 - body_bytes.len() % 4) % 4;
    frame_body.extend(std::iter::repeat(0u8).take(pad));

    Ok(Frame::from_parts(header, frame_body).to_bytes())
}

/// How much the write-stream cursor advances after one response.
///
/// - bare ack (16 bytes or less): `0`;
/// - framed response: `8 + u16 body length`;
/// - raw data window: every byte after the header.
#[must_use]
pub fn write_cursor_advance(response: &[u8]) -> u32 {
    if response.len() <= HEADER_LEN {
        return 0;
    }
    if response.len() >= 20
        && WRITE_FRAMED_SUBHEADERS.contains(&response[16..20].try_into().unwrap())
    {
        let length = u16::from_le_bytes([response[20], response[21]]);
        return 8 + u32::from(length);
    }
    u32::try_from(response.len() - HEADER_LEN).unwrap_or(0)
}

/// Status reported by a framed write response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteStatus {
    /// Status value (key 103). `0` means the device applied the command.
    pub status: u64,
    /// Optional error code (key 111).
    pub code: Option<u64>,
}

impl WriteStatus {
    /// True when the device reported success.
    #[must_use]
    pub fn is_ok(self) -> bool {
        self.status == 0
    }
}

/// Decode the status of a write response, if it carries one.
///
/// Bare acknowledgements (16-byte frames) return `None`; the framed echo with
/// a `{102, 103, 104}` body returns the status.
#[must_use]
pub fn decode_write_status(response: &[u8]) -> Option<WriteStatus> {
    let frame = Frame::parse(response).ok()?;
    let body = crate::open::payload(&frame).ok()?;
    if body.is_empty() {
        return None;
    }
    let (message, _) = msgpack::decode_prefix(body).ok()?;
    let status = message.get_u64(KEY_STATUS)?.as_u64()?;
    let code = message.get_u64(KEY_ERROR_CODE).and_then(Value::as_u64);
    Some(WriteStatus { status, code })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn set_param_frame_matches_the_golden_vector() {
        let frame = encode_set_param(6, 3, 0.5, 1000, WRITE_FIRST_COMMAND_SEQ, 0x203f).unwrap();
        let expected = concat!(
            "27 00 00 18 80 10 ed 03 00 05 00 04 3f 20 00 00 ",
            "01 00 06 00 17 00 00 00 ",
            "83 66 cd 03 e8 64 1e 65 85 ",
            "62 06 1d c3 1a 00 1c 03 77 ca 3f 00 00 00 ",
            "00"
        );
        assert_eq!(hex(&frame), expected);
    }

    #[test]
    fn set_param_rejects_a_non_finite_value() {
        let err = encode_set_param(0, 0, f32::NAN, 1, 5, 0).unwrap_err();
        assert!(err.to_string().contains("not finite"), "{err}");
    }

    #[test]
    fn set_model_frame_carries_the_raw_block_and_nested_model_node() {
        // Layout from the MIT reference's `change-pedal-from-app.pcapng`
        // packet 35 (op 40). No capture of this request is stored in the
        // repository, so this is an offline structure test only.
        let frame = encode_set_model(5, 433, false, 1013, 0x70, 0x203f).unwrap();
        assert_eq!(&frame[4..8], &[0x80, 0x10, 0xed, 0x03]);
        assert_eq!(frame[9], 0x70);
        assert_eq!(frame[11], 0x04);
        assert_eq!(&frame[12..16], &0x203fu32.to_le_bytes());
        assert_eq!(&frame[16..20], &WRITE_SUBHEADER);

        let parsed = Frame::parse(&frame).unwrap();
        let body = crate::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        assert_eq!(value.get_u64(102).unwrap().as_u64(), Some(1013));
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(40));
        let inner = value.get_u64(101).unwrap();
        assert_eq!(inner.get_u64(98).unwrap().as_u64(), Some(5));
        let model = inner.get_u64(100).unwrap();
        assert_eq!(model.get_u64(23).unwrap().as_bool(), Some(false));
        assert_eq!(model.get_u64(25).unwrap().as_u64(), Some(433));
        assert_eq!(model.get_u64(26).unwrap().as_i64(), Some(-1));
    }

    #[test]
    fn set_model_can_flag_no_snapshot_bypass() {
        let frame = encode_set_model(1, 7, true, 1, 5, 0).unwrap();
        let parsed = Frame::parse(&frame).unwrap();
        let body = crate::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        let model = value.get_u64(101).unwrap().get_u64(100).unwrap();
        assert_eq!(model.get_u64(23).unwrap().as_bool(), Some(true));
    }

    #[test]
    fn save_preset_frame_matches_the_captured_editor_frame() {
        // Exact write-channel frame from POD Go Edit (POD Go Wireless, fw
        // 2.50) in `reverse/exports/podgo-preset-save.pcapng`.
        let frame = encode_save_preset(1, 36, "New Preset", 1016, 0x3e, 0x1fe8).unwrap();
        let expected = concat!(
            "2a 00 00 18 80 10 ed 03 00 3e 00 04 e8 1f 00 00 ",
            "01 00 06 00 1a 00 00 00 ",
            "83 66 cd 03 f8 64 47 65 83 6b 01 6c 24 6d ab ",
            "4e 65 77 20 50 72 65 73 65 74 00 ",
            "00 00"
        );
        assert_eq!(hex(&frame), expected);
        assert_eq!(frame.len(), 52);
        assert_eq!(frame[0], 42);
        assert_eq!(frame[9], 0x3e);
        assert_eq!(&frame[12..16], &0x1fe8u32.to_le_bytes());
    }

    #[test]
    fn save_preset_appends_one_nul_to_the_visible_name() {
        let frame = encode_save_preset(1, 0, "ABCDEFGHIJKLMNOP", 7, 5, 0).unwrap();
        let parsed = Frame::parse(&frame).unwrap();
        let body = crate::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        let inner = value.get_u64(101).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(71));
        assert_eq!(inner.get_u64(107).unwrap().as_u64(), Some(1));
        assert_eq!(inner.get_u64(108).unwrap().as_u64(), Some(0));
        assert_eq!(
            inner.get_u64(109).unwrap().as_str(),
            Some("ABCDEFGHIJKLMNOP\u{0}")
        );
    }

    #[test]
    fn save_preset_rejects_invalid_names() {
        for name in ["", "seventeen bytes!!", "line\nbreak"] {
            let err = encode_save_preset(1, 0, name, 1, 5, 0).unwrap_err();
            assert!(
                matches!(err, ProtocolError::InvalidFrame(_)),
                "{name:?}: {err}"
            );
        }
        assert!(validate_preset_name("Comandant_Clean1").is_ok());
    }

    #[test]
    fn recall_frame_matches_the_captured_editor_frame() {
        // Exact write-channel frame from POD Go Edit (fw 2.50) in
        // `podgo-bypass-and-remove-effect.pcapng` (transaction 1006).
        let frame = encode_recall_preset(1, 36, 1006, 0x3e, 0x1eb2).unwrap();
        let expected = concat!(
            "1d 00 00 18 80 10 ed 03 00 3e 00 04 b2 1e 00 00 ",
            "01 00 06 00 0d 00 00 00 ",
            "83 66 cd 03 ee 64 14 65 82 6b 01 6c 24 ",
            "00 00 00"
        );
        assert_eq!(hex(&frame), expected);
    }

    #[test]
    fn snapshot_frames_match_the_captured_editor_frames() {
        // POD Go Edit, fw 2.50, `podgo-snapshots.pcapng` (2026-11-24).
        let recall = encode_snapshot_recall(0, 1006, 0x1f, 0x1efd).unwrap();
        assert_eq!(
            hex(&recall),
            concat!(
                "1b 00 00 18 80 10 ed 03 00 1f 00 04 fd 1e 00 00 ",
                "01 00 06 00 0b 00 00 00 ",
                "83 66 cd 03 ee 64 58 65 81 5c 00 ",
                "00"
            )
        );

        let rename = encode_snapshot_rename(0, "test1", 1013, 0x51, 0x2df8).unwrap();
        assert_eq!(
            hex(&rename),
            concat!(
                "23 00 00 18 80 10 ed 03 00 51 00 04 f8 2d 00 00 ",
                "01 00 06 00 13 00 00 00 ",
                "83 66 cd 03 f5 64 59 65 82 5c 00 6d a6 74 65 73 74 31 00 ",
                "00"
            )
        );

        let color = encode_snapshot_led_color(0, 3, 1014, 0x56, 0x2e09).unwrap();
        assert_eq!(
            hex(&color),
            concat!(
                "1d 00 00 18 80 10 ed 03 00 56 00 04 09 2e 00 00 ",
                "01 00 06 00 0d 00 00 00 ",
                "83 66 cd 03 f6 64 62 65 82 5c 00 42 03 ",
                "00 00 00"
            )
        );

        let assign = encode_snapshot_param(3, 0, true, 1008, 0x38, 0x2d3d).unwrap();
        assert_eq!(
            hex(&assign),
            concat!(
                "25 00 00 18 80 10 ed 03 00 38 00 04 3d 2d 00 00 ",
                "01 00 06 00 15 00 00 00 ",
                "83 66 cd 03 f0 64 25 65 86 62 03 1d c3 1a 00 1c 00 4a 0b 47 00 ",
                "00 00 00"
            )
        );
    }

    #[test]
    fn snapshot_encoders_reject_out_of_range_values() {
        assert!(encode_snapshot_recall(4, 1, 5, 0).is_err());
        assert!(encode_snapshot_rename(0, "elevenchars", 1, 5, 0).is_err());
        assert!(encode_snapshot_rename(0, "line\nbreak", 1, 5, 0).is_err());
        assert!(encode_snapshot_rename(0, "caf\u{e9}", 1, 5, 0).is_err());
        assert!(encode_snapshot_led_color(0, 12, 1, 5, 0).is_err());
        assert!(validate_snapshot_name("").is_ok());
        assert!(validate_snapshot_name("1234567890").is_ok());
        assert!(validate_snapshot_name("Snapshot 12").is_err());
        assert_eq!(SNAPSHOT_CONTROLLER_WIRE, 11);
    }

    #[test]
    fn bypass_frame_matches_the_captured_editor_frame() {
        // Transaction 1010, block 3, enabled = false.
        let frame = encode_set_bypass(3, false, 1010, 0x5e, 0x2d46).unwrap();
        let expected = concat!(
            "1d 00 00 18 80 10 ed 03 00 5e 00 04 46 2d 00 00 ",
            "01 00 06 00 0d 00 00 00 ",
            "83 66 cd 03 f2 64 29 65 82 62 03 3b c2 ",
            "00 00 00"
        );
        assert_eq!(hex(&frame), expected);

        let parsed = Frame::parse(&frame).unwrap();
        let body = crate::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(41));
        let inner = value.get_u64(101).unwrap();
        assert_eq!(inner.get_u64(98).unwrap().as_u64(), Some(3));
        assert_eq!(inner.get_u64(59).unwrap().as_bool(), Some(false));
    }

    #[test]
    fn remove_frames_match_the_captured_editor_frames() {
        let first = encode_remove_effect(3, false, 1014, 0x71, 0x2d8a).unwrap();
        let expected_first = concat!(
            "1b 00 00 18 80 10 ed 03 00 71 00 04 8a 2d 00 00 ",
            "01 00 06 00 0b 00 00 00 ",
            "83 66 cd 03 f6 64 1c 65 81 62 03 ",
            "00"
        );
        assert_eq!(hex(&first), expected_first);

        let commit = encode_remove_effect(3, true, 1015, 0x76, 0x2d9b).unwrap();
        let expected_commit = concat!(
            "1b 00 00 18 80 10 ed 03 00 76 00 04 9b 2d 00 00 ",
            "01 00 06 00 0b 00 00 00 ",
            "83 66 cd 03 f7 64 4e 65 81 62 03 ",
            "00"
        );
        assert_eq!(hex(&commit), expected_commit);
    }

    #[test]
    fn chain_upload_body_uses_a_str_blob_under_key_110() {
        let blob = vec![0xa9, b'l', b'6', b'-', b'h', b'e', b'l', b'i', b'x', 0];
        let body = encode_chain_upload(&blob, 1007).unwrap();
        let (value, _) = msgpack::decode_prefix(&body).unwrap();
        assert_eq!(value.get_u64(102).unwrap().as_u64(), Some(1007));
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(21));
        let inner = value.get_u64(101).unwrap();
        assert_eq!(
            inner.get_u64(110).unwrap().as_str_bytes(),
            Some(blob.as_slice())
        );
    }

    #[test]
    fn chain_frames_reassemble_into_the_original_body() {
        let body: Vec<u8> = (0..1500u32).map(|index| (index % 251) as u8).collect();
        let total = u32::try_from(body.len()).unwrap();
        let mut frames = Vec::new();
        let mut position = 0usize;
        let mut first = true;
        let mut seq = 0x2bu8;
        while position < body.len() {
            let chunk = if first {
                CHAIN_FIRST_BYTES.min(body.len() - position)
            } else {
                CHAIN_CHUNK_BYTES.min(body.len() - position)
            };
            frames.push(
                build_chain_frame(&body[position..position + chunk], total, first, seq, 0x1f19)
                    .unwrap(),
            );
            position += chunk;
            first = false;
            seq = seq.wrapping_add(1);
        }

        // The first frame carries the 8-byte subheader and the declared total.
        let parsed = Frame::parse(&frames[0]).unwrap();
        let payload = parsed.body();
        assert_eq!(&payload[0..4], &WRITE_SUBHEADER);
        assert_eq!(&payload[4..8], &total.to_le_bytes());
        assert_eq!(parsed.header()[4..8], [0x80, 0x10, 0xed, 0x03]);
        assert_eq!(parsed.header()[0..2], 504u16.to_le_bytes());

        // Every continuation carries raw bytes only.
        assert_eq!(Frame::parse(&frames[1]).unwrap().body().len(), 496);

        let mut reassembled = payload[8..].to_vec();
        for frame in &frames[1..] {
            reassembled.extend_from_slice(Frame::parse(frame).unwrap().body());
        }
        reassembled.truncate(body.len());
        assert_eq!(reassembled, body);
    }

    #[test]
    fn cursor_advance_follows_the_framed_or_raw_shape() {
        assert_eq!(write_cursor_advance(&[0u8; 16]), 0);
        assert_eq!(write_cursor_advance(&[0u8; 12]), 0);

        let mut framed = vec![0u8; 24];
        framed[16..20].copy_from_slice(&[0x00, 0x00, 0x06, 0x00]);
        framed[20..22].copy_from_slice(&23u16.to_le_bytes());
        assert_eq!(write_cursor_advance(&framed), 8 + 23);

        let raw = vec![0u8; 40];
        assert_eq!(write_cursor_advance(&raw), 24);
    }

    #[test]
    fn status_is_read_from_the_framed_echo() {
        let body = msgpack::encode(&Value::map(vec![
            (Value::uint(102), Value::uint(1005)),
            (Value::uint(103), Value::uint(0)),
            (Value::uint(104), Value::Nil),
        ]))
        .unwrap();
        let mut frame = vec![0u8; HEADER_LEN];
        frame.extend_from_slice(&[0x00, 0x00, 0x06, 0x00]);
        frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
        frame.extend_from_slice(&[0x00, 0x00]);
        frame.extend_from_slice(&body);

        let status = decode_write_status(&frame).unwrap();
        assert!(status.is_ok());
        assert_eq!(status.code, None);
    }

    #[test]
    fn a_non_zero_status_carries_the_error_code() {
        let body = msgpack::encode(&Value::map(vec![
            (Value::uint(102), Value::uint(1006)),
            (Value::uint(103), Value::uint(255)),
            (Value::uint(111), Value::uint(7)),
        ]))
        .unwrap();
        let mut frame = vec![0u8; HEADER_LEN];
        frame.extend_from_slice(&[0x01, 0x00, 0x06, 0x00]);
        frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
        frame.extend_from_slice(&[0x00, 0x00]);
        frame.extend_from_slice(&body);

        let status = decode_write_status(&frame).unwrap();
        assert!(!status.is_ok());
        assert_eq!(status.status, 255);
        assert_eq!(status.code, Some(7));
    }

    #[test]
    fn bare_acks_have_no_status() {
        assert!(decode_write_status(&[0u8; 16]).is_none());
    }

    #[test]
    fn handshake_packets_target_the_write_channel() {
        assert_eq!(WRITE_SEQUENCE.len(), 4);
        for packet in WRITE_SEQUENCE {
            assert_eq!(&packet[4..6], &[0x80, 0x10]);
            assert_eq!(&packet[6..8], &[0xed, 0x03]);
        }
        assert_eq!(WRITE_OPEN_2.len(), 36);
        assert_eq!(&WRITE_OPEN_2[12..16], &WRITE_OPEN_2_CURSOR.to_le_bytes());
    }

    #[test]
    fn repacking_the_body_keeps_the_key_order_the_device_expects() {
        // Keys must stay in insertion order: 102, 100, then 101 with
        // 98, 29, 26, 28, 119 inside.
        let frame = encode_set_param(1, 2, 0.25, 7, 5, 0).unwrap();
        let parsed = Frame::parse(&frame).unwrap();
        let body = crate::open::payload(&parsed).unwrap();
        let (value, _) = msgpack::decode_prefix(body).unwrap();
        let entries = value.as_map().unwrap();
        let keys: Vec<u64> = entries
            .iter()
            .map(|(key, _)| key.as_u64().unwrap())
            .collect();
        assert_eq!(keys, vec![102, 100, 101]);
        let inner = value.get_u64(101).unwrap();
        let inner_keys: Vec<u64> = inner
            .as_map()
            .unwrap()
            .iter()
            .map(|(key, _)| key.as_u64().unwrap())
            .collect();
        assert_eq!(inner_keys, vec![98, 29, 26, 28, 119]);
        assert_eq!(inner.get_u64(119).unwrap().as_f64(), Some(0.25));
    }

    #[test]
    fn restore_session_matches_the_captured_opening_frame() {
        // `SESSION_OPEN_2` from the read handshake is the op-254 command at
        // cursor 0x1009 (captured at packet 59 of
        // `podgo-backup-restore.pcapng`).
        let request = crate::open::OpenRequest {
            transaction: 1000,
            operation: OP_RESTORE_SESSION,
            params: Value::map(Vec::new()),
        };
        let frame = crate::open::encode_open(&request, READ_SRC, READ_DST, 4, 0x1009).unwrap();
        assert_eq!(frame, crate::handshake::SESSION_OPEN_2);
        assert_eq!(frame.len(), 36);
        assert_eq!(&frame[4..8], &[0x01, 0x10, 0xef, 0x03]);
        assert_eq!(&frame[9..10], &[0x04]);
    }

    #[test]
    fn restore_body_keeps_the_captured_key_order_and_str_marker() {
        // More than 255 bytes forces the `str16` marker (`da`) the capture
        // uses for key 110.
        let mut blob = vec![0xa9u8, b'l', b'6', b'-', b'h', b'e', b'l', b'i', b'x', 0];
        blob.resize(300, 0);
        let body = encode_restore_preset(1, 36, &blob, 1747).unwrap();
        let (value, used) = msgpack::decode_prefix(&body).unwrap();
        assert_eq!(used, body.len());

        let keys: Vec<u64> = value
            .as_map()
            .unwrap()
            .iter()
            .map(|(key, _)| key.as_u64().unwrap())
            .collect();
        assert_eq!(keys, vec![102, 100, 101]);
        assert_eq!(value.get_u64(100).unwrap().as_u64(), Some(5));
        // Transaction 1747 uses the compact `cd` (u16) marker, as captured.
        assert_eq!(&body[2..5], &[0xcd, 0x06, 0xd3]);

        let inner = value.get_u64(101).unwrap();
        let inner_keys: Vec<u64> = inner
            .as_map()
            .unwrap()
            .iter()
            .map(|(key, _)| key.as_u64().unwrap())
            .collect();
        assert_eq!(inner_keys, vec![107, 108, 123, 124, 125, 110]);
        assert_eq!(inner.get_u64(107).unwrap().as_u64(), Some(1));
        assert_eq!(inner.get_u64(108).unwrap().as_u64(), Some(36));
        assert_eq!(inner.get_u64(123).unwrap().as_bool(), Some(false));
        assert_eq!(inner.get_u64(124).unwrap().as_bool(), Some(false));
        assert_eq!(inner.get_u64(125).unwrap().as_u64(), Some(0));
        let encoded = inner.get_u64(110).unwrap();
        assert_eq!(encoded.as_str_bytes(), Some(blob.as_slice()));
        // Key 110 is a `str`, never a `bin`.
        let encoded_at = body
            .windows(2)
            .position(|window| window == [0x6e, 0xda])
            .unwrap();
        assert_eq!(body[encoded_at + 1], 0xda);
        assert!(body.iter().position(|byte| *byte == 0xc4).is_none());
    }

    #[test]
    fn restore_stream_splits_and_pads_like_the_capture() {
        let blob = vec![0x5au8; 4171 - 23];
        let body = encode_restore_preset(0, 0, &blob, 1579).unwrap();
        assert_eq!(body.len(), 4171);

        let frames = encode_restore_stream(&body, 6, 0x52fd).unwrap();
        // One 488-byte opening frame, then seven full 496-byte continuations
        // and one short tail: 1 + 7 + 1 = 9 frames.
        assert_eq!(frames.len(), 9);

        // First frame: 8-byte subheader, u32 total length, 488 body bytes.
        let first = &frames[0].bytes;
        assert_eq!(first.len(), 512);
        assert_eq!(&first[16..20], &RESTORE_SUBHEADER);
        assert_eq!(&first[20..24], &4171u32.to_le_bytes());
        assert_eq!(&first[24..], &body[..STREAM_FIRST_BYTES]);
        assert_eq!(u16::from_le_bytes([first[0], first[1]]), 504);
        assert_eq!(&first[4..8], &[0x01, 0x10, 0xef, 0x03]);

        // The pedal acknowledges every frame, so each one ends a window.
        let mut sent = 0usize;
        for (index, frame) in frames.iter().enumerate() {
            let first_frame = index == 0;
            let declared = u16::from_le_bytes([frame.bytes[0], frame.bytes[1]]) as usize;
            let carried = if first_frame {
                declared - 16
            } else {
                declared - 8
            };
            sent += carried;
            assert!(frame.window_end, "frame {index} must wait for a status");
        }
        assert_eq!(sent, body.len());

        // The cursor advances by 17 after every granted status, so frame `n`
        // carries `0x52fd + 17 * n`.
        for (index, frame) in frames.iter().enumerate() {
            let cursor = u32::from_le_bytes(frame.bytes[12..16].try_into().unwrap());
            let expected = 0x52fd + 17 * index as u32;
            assert_eq!(cursor, expected, "frame {index}");
            if index > 0 {
                assert_ne!(&frame.bytes[16..20], &RESTORE_SUBHEADER);
            }
        }

        // Every frame body is padded to a 4-byte boundary.
        for frame in &frames {
            assert_eq!(frame.bytes.len() % 4, 0);
        }

        // The last frame carries only the remaining body bytes.
        let last = &frames.last().unwrap().bytes;
        let declared = u16::from_le_bytes([last[0], last[1]]) as usize;
        let tail = (4171 - STREAM_FIRST_BYTES) % STREAM_CHUNK_BYTES;
        assert_eq!(tail, 211);
        assert_eq!(declared, 8 + tail);
    }

    #[test]
    fn small_restore_bodies_fit_in_one_frame() {
        let blob = vec![1u8; 100];
        let body = encode_restore_preset(1, 0, &blob, 7).unwrap();
        let frames = encode_restore_stream(&body, 6, 0x101a).unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].window_end);
        let frame = &frames[0].bytes;
        assert_eq!(
            u16::from_le_bytes([frame[0], frame[1]]) as usize,
            16 + body.len()
        );
        assert_eq!(&frame[20..24], &(body.len() as u32).to_le_bytes());
        // Body + subheader is padded to four bytes.
        assert_eq!(frame.len() % 4, 0);
        assert_eq!(&frame[24..24 + body.len()], body.as_slice());
    }

    #[test]
    fn restore_presets_reject_out_of_range_targets() {
        assert!(encode_restore_preset(2, 0, &[1], 1).is_err());
        assert!(encode_restore_preset(0, 128, &[1], 1).is_err());
        assert!(encode_restore_preset(0, 0, &[], 1).is_err());
        assert!(encode_restore_stream(&[], 6, 0).is_err());
    }
}
