//! The `l6-helix` preset container and a typed view over its body.
//!
//! Wire shape (confirmed by `fixtures/spec02_obj22_blob.bin`):
//!
//! ```text
//! a9 "l6-helix\0"    MessagePack fixstr(9)
//! da 00 30           str16, 48-byte offset table
//! <48 bytes>         offset table
//! <msgpack map>      preset body
//! ```
//!
//! The offset table is preserved verbatim. Its exact semantics are not fully
//! understood (see `docs/reverse-engineering/unknowns-and-hypotheses.md`), so
//! this crate never recomputes it.
//!
//! Body key constants mirror the evidence in
//! `reverse/openpodgo/src/openpodgo/l6helix.py` and
//! `docs/reverse-engineering/protocol-specification.md`.

use crate::error::DomainError;
use crate::msgpack::{self, Value};

/// Container magic, including the trailing NUL.
pub const MAGIC: &[u8; 9] = b"l6-helix\0";

/// Observed offset-table length.
pub const OFFSET_TABLE_LEN: usize = 48;

/// Top-level body key: DSP0 chain (`{21: index, 22: entries}`).
pub const BODY_DSP0: u64 = 0;
/// Top-level body key: footswitch assignments (not decoded).
pub const BODY_FOOTSWITCH: u64 = 3;
/// Top-level body key: controller assignments (not decoded).
pub const BODY_CONTROLLER: u64 = 4;
/// Top-level body key: globals (`{16: tempo, ...}`).
pub const BODY_GLOBAL: u64 = 5;
/// Top-level body key: metadata (`{35: version, 36: product, 37: firmware}`).
pub const BODY_META: u64 = 7;
/// Top-level body key: snapshots (`{6: current, 10: [4 snapshots]}`).
pub const BODY_SNAPSHOTS: u64 = 10;

/// Metadata: product id string.
pub const META_PRODUCT: u64 = 36;
/// Metadata: firmware/build string.
pub const META_FIRMWARE: u64 = 37;

/// DSP0: chain entries.
pub const DSP_CHAIN: u64 = 22;
/// Chain entry: class.
pub const ENTRY_CLASS: u64 = 19;
/// Chain entry: payload.
pub const ENTRY_PAYLOAD: u64 = 20;

/// Chain class: input.
pub const CLASS_INPUT: u64 = 0;
/// Chain class: output.
pub const CLASS_OUTPUT: u64 = 1;
/// Chain class: processing block.
pub const CLASS_BLOCK: u64 = 6;
/// Chain class: looper.
pub const CLASS_LOOPER: u64 = 7;
/// Chain class: empty slot.
pub const CLASS_EMPTY: u64 = 8;

/// Block payload: category.
pub const BLK_CATEGORY: u64 = 9;
/// Block payload: enabled.
pub const BLK_ENABLED: u64 = 10;
/// Block payload: params (`{2: total, 3: snapshotable, 4: values}`).
pub const BLK_PARAMS: u64 = 11;
/// Block payload: model node (`{23: no_snapshot_bypass, 25: model id}`).
pub const BLK_MODEL: u64 = 24;
/// Model node: model id.
pub const MODEL_ID: u64 = 25;
/// Model node: no-snapshot-bypass flag.
pub const MODEL_NO_SNAPSHOT_BYPASS: u64 = 23;
/// Params: values array.
pub const PARAMS_VALUES: u64 = 4;
/// Input/output params live at key 7 of the payload.
pub const IO_PARAMS: u64 = 7;
/// Looper model id lives at key 8.
pub const LOOPER_MODEL_ID: u64 = 8;

/// Snapshot: valid flag.
pub const SNAP_VALID: u64 = 0;
/// Snapshot: enable list (`[[?, bool], ...]`).
pub const SNAP_ENABLES: u64 = 3;
/// Snapshot: name.
pub const SNAP_NAME: u64 = 4;
/// Snapshot: tempo.
pub const SNAP_TEMPO: u64 = 5;
/// Snapshots: current index.
pub const SNAPS_CURRENT: u64 = 6;
/// Snapshots: list.
pub const SNAPS_LIST: u64 = 10;

/// Global: tempo.
pub const GLOBAL_TEMPO: u64 = 16;

/// Footswitch node: groups per switch (`[[entry, ...], ...]`).
pub const FS_GROUPS: u64 = 8;
/// Footswitch entry: order within the group.
pub const FS_ORDER: u64 = 10;
/// Footswitch entry: assignment (`{5: label, 7: enabled, 8: block}`).
pub const FS_TARGET: u64 = 11;
/// Footswitch target: custom label.
pub const FST_LABEL: u64 = 5;
/// Footswitch target: enabled flag.
pub const FST_ENABLED: u64 = 7;
/// Footswitch target: 1-based block slot.
pub const FST_BLOCK: u64 = 8;

/// Controller entry: assignment definition.
pub const CTL_DEF: u64 = 1;
/// Controller definition: `@controller` number.
pub const CTLD_NUM: u64 = 0;
/// Controller definition: parameter index.
pub const CTLD_PARAM: u64 = 4;
/// Controller definition: minimum value.
pub const CTLD_MIN: u64 = 2;
/// Controller definition: maximum value.
pub const CTLD_MAX: u64 = 3;

/// Number of footswitch groups addressable by the expression-pedal toe switch.
pub const FS_GROUP_EXP_TOE: usize = 8;

/// A parsed `l6-helix` container that preserves every original byte.
#[derive(Debug, Clone, PartialEq)]
pub struct Container {
    magic: Vec<u8>,
    offset_table: Vec<u8>,
    body: Value,
    trailing: Vec<u8>,
}

impl Container {
    /// Parse a container from raw bytes.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidContainer`] if the magic or offset-table
    /// header is wrong, and [`DomainError::UnexpectedEof`] if the input is
    /// truncated.
    pub fn parse(bytes: &[u8]) -> Result<Self, DomainError> {
        if bytes.len() < 10 {
            return Err(DomainError::UnexpectedEof {
                offset: 0,
                needed: 10,
            });
        }
        if bytes[0] != 0xa9 || &bytes[1..10] != MAGIC {
            return Err(DomainError::InvalidContainer(
                "expected MessagePack fixstr(9) \"l6-helix\\0\" magic",
            ));
        }

        let mut pos = 10;
        if bytes.len() < pos + 3 {
            return Err(DomainError::UnexpectedEof {
                offset: pos,
                needed: 3,
            });
        }
        if bytes[pos] != 0xda {
            return Err(DomainError::InvalidContainer(
                "expected str16 header for the offset table",
            ));
        }
        let table_len = usize::from(u16::from_be_bytes([bytes[pos + 1], bytes[pos + 2]]));
        pos += 3;
        let table_end = pos
            .checked_add(table_len)
            .ok_or(DomainError::LengthOverflow)?;
        if bytes.len() < table_end {
            return Err(DomainError::UnexpectedEof {
                offset: pos,
                needed: table_len,
            });
        }
        let offset_table = bytes[pos..table_end].to_vec();
        pos = table_end;

        let (body, used) = msgpack::decode_prefix(&bytes[pos..])?;
        let trailing = bytes[pos + used..].to_vec();

        Ok(Self {
            magic: bytes[1..10].to_vec(),
            offset_table,
            body,
            trailing,
        })
    }

    /// Parse a container and return it with a typed preset view.
    ///
    /// # Errors
    ///
    /// Returns any error from [`Container::parse`].
    pub fn parse_preset(bytes: &[u8]) -> Result<Preset, DomainError> {
        let container = Self::parse(bytes)?;
        Ok(Preset::from_container(container))
    }

    /// Re-encode the container.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::LengthOverflow`] if the offset table exceeds the
    /// `u16` length field, or a MessagePack encoding error.
    pub fn to_bytes(&self) -> Result<Vec<u8>, DomainError> {
        let table_len =
            u16::try_from(self.offset_table.len()).map_err(|_| DomainError::LengthOverflow)?;
        let mut out = Vec::new();
        out.push(0xa9);
        out.extend_from_slice(&self.magic);
        out.push(0xda);
        out.extend_from_slice(&table_len.to_be_bytes());
        out.extend_from_slice(&self.offset_table);
        msgpack::encode_into(&self.body, &mut out)?;
        out.extend_from_slice(&self.trailing);
        Ok(out)
    }

    /// Borrow the decoded body.
    #[must_use]
    pub fn body(&self) -> &Value {
        &self.body
    }

    /// Mutably borrow the decoded body.
    ///
    /// Mutating the body invalidates the offset table, which is retained
    /// verbatim. Callers must treat the result as "edited" and must not assume
    /// the table still matches the body.
    pub fn body_mut(&mut self) -> &mut Value {
        &mut self.body
    }

    /// Raw offset table.
    #[must_use]
    pub fn offset_table(&self) -> &[u8] {
        &self.offset_table
    }

    /// Bytes that followed the body in the original input.
    #[must_use]
    pub fn trailing(&self) -> &[u8] {
        &self.trailing
    }
}

/// A typed view over a preset body.
#[derive(Debug, Clone, PartialEq)]
pub struct Preset {
    /// Product id string (metadata key 36), NUL-trimmed.
    pub product: String,
    /// Firmware/build string (metadata key 37), NUL-trimmed.
    pub firmware: String,
    /// Global tempo, if present.
    pub tempo: Option<f64>,
    /// Current snapshot index, if present.
    pub current_snapshot: Option<u64>,
    /// Snapshots in order.
    pub snapshots: Vec<Snapshot>,
    /// Signal chain entries.
    pub chain: Vec<ChainEntry>,
    /// Footswitch bypass assignments.
    pub footswitches: Vec<FootswitchAssignment>,
    /// Controller (expression pedal) assignments.
    pub controllers: Vec<ControllerAssignment>,
    /// The original container, including unknown fields.
    pub container: Container,
}

/// A footswitch bypass assignment (`body[3][8]`).
#[derive(Debug, Clone, PartialEq)]
pub struct FootswitchAssignment {
    /// Group index: `0..=7` is `FS1..FS8`, `8` is the expression toe switch.
    pub group: u8,
    /// 1-based block slot the switch toggles (key 8 of the target).
    pub block: u64,
    /// Custom label stored with the assignment, NUL-trimmed.
    pub label: String,
    /// Whether the assignment is active.
    pub enabled: bool,
}

impl FootswitchAssignment {
    /// Switch name as shown by the pedal and POD Go Edit (`FS1`…`FS8`,
    /// `EXP Toe`).
    #[must_use]
    pub fn switch_name(&self) -> String {
        if usize::from(self.group) == FS_GROUP_EXP_TOE {
            "EXP Toe".to_owned()
        } else {
            format!("FS{}", self.group + 1)
        }
    }
}

/// A controller assignment (`body[4]`).
///
/// The target block is *not* stored: the reference implementation binds
/// controller 1 to the wah block and controller 2 to the volume block by role
/// (see `docs/reverse-engineering/unknowns-and-hypotheses.md`).
#[derive(Debug, Clone, PartialEq)]
pub struct ControllerAssignment {
    /// `@controller` number (1 = EXP 1, 2 = EXP 2 in every observed preset).
    pub controller: u64,
    /// Parameter index inside the target block.
    pub param_index: u64,
    /// Lower bound of the pedal sweep.
    pub min: f64,
    /// Upper bound of the pedal sweep.
    pub max: f64,
}

/// One entry in the signal chain.
#[derive(Debug, Clone, PartialEq)]
pub enum ChainEntry {
    /// Input stage.
    Input {
        /// Positional parameter values.
        params: Vec<Value>,
    },
    /// Output stage.
    Output {
        /// Positional parameter values.
        params: Vec<Value>,
    },
    /// A processing block.
    Block(Block),
    /// The looper.
    Looper {
        /// Model id, if present.
        model_id: Option<u32>,
        /// Whether the looper is enabled.
        enabled: bool,
        /// Positional parameter values.
        params: Vec<Value>,
    },
    /// An empty slot.
    Empty,
    /// A class this crate does not model yet.
    Unknown {
        /// Raw class value.
        class: u64,
    },
}

/// A processing block.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    /// On-wire model id (key 25).
    pub model_id: u32,
    /// On-wire category (key 9).
    pub category: Option<u64>,
    /// Enabled/bypass state (key 10).
    pub enabled: bool,
    /// No-snapshot-bypass flag (key 23 of the model node).
    pub no_snapshot_bypass: bool,
    /// Positional parameter values (key 4 of the params node).
    pub params: Vec<Value>,
}

/// A snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Snapshot name.
    pub name: String,
    /// Validity flag.
    pub valid: bool,
    /// Tempo.
    pub tempo: Option<f64>,
    /// Per-slot enable flags.
    pub enables: Vec<bool>,
}

impl Preset {
    /// Build a typed view over a parsed container.
    ///
    /// Missing or malformed optional fields become `None`/empty rather than
    /// failing, because firmware may omit them. Structural container errors are
    /// still reported by [`Container::parse`].
    #[must_use]
    pub fn from_container(container: Container) -> Self {
        let body = container.body();

        let meta = body.get_u64(BODY_META);
        let product = meta
            .and_then(|m| m.get_u64(META_PRODUCT))
            .and_then(Value::as_str)
            .map(trim_nul)
            .unwrap_or_default();
        let firmware = meta
            .and_then(|m| m.get_u64(META_FIRMWARE))
            .and_then(Value::as_str)
            .map(trim_nul)
            .unwrap_or_default();

        let tempo = body
            .get_u64(BODY_GLOBAL)
            .and_then(|g| g.get_u64(GLOBAL_TEMPO))
            .and_then(Value::as_f64);

        let snap_node = body.get_u64(BODY_SNAPSHOTS);
        let current_snapshot = snap_node
            .and_then(|s| s.get_u64(SNAPS_CURRENT))
            .and_then(Value::as_u64);
        let snapshots = snap_node
            .and_then(|s| s.get_u64(SNAPS_LIST))
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(parse_snapshot).collect())
            .unwrap_or_default();

        let chain = body
            .get_u64(BODY_DSP0)
            .and_then(|d| d.get_u64(DSP_CHAIN))
            .and_then(Value::as_array)
            .map(|entries| entries.iter().filter_map(parse_chain_entry).collect())
            .unwrap_or_default();

        let footswitches = parse_footswitches(body.get_u64(BODY_FOOTSWITCH));
        let controllers = parse_controllers(body.get_u64(BODY_CONTROLLER));

        Self {
            product,
            firmware,
            tempo,
            current_snapshot,
            snapshots,
            chain,
            footswitches,
            controllers,
            container,
        }
    }

    /// Borrow the underlying container body.
    #[must_use]
    pub fn body(&self) -> &Value {
        self.container.body()
    }
}

fn parse_chain_entry(entry: &Value) -> Option<ChainEntry> {
    let class = entry.get_u64(ENTRY_CLASS)?.as_u64()?;
    let payload = entry.get_u64(ENTRY_PAYLOAD);

    match class {
        CLASS_INPUT => Some(ChainEntry::Input {
            params: payload
                .and_then(|p| p.get_u64(IO_PARAMS))
                .and_then(Value::as_array)
                .map(<[Value]>::to_vec)
                .unwrap_or_default(),
        }),
        CLASS_OUTPUT => Some(ChainEntry::Output {
            params: payload
                .and_then(|p| p.get_u64(IO_PARAMS))
                .and_then(Value::as_array)
                .map(<[Value]>::to_vec)
                .unwrap_or_default(),
        }),
        CLASS_BLOCK => {
            let payload = payload?;
            let model_node = payload.get_u64(BLK_MODEL)?;
            let model_id = u32::try_from(model_node.get_u64(MODEL_ID)?.as_u64()?).ok()?;
            let enabled = payload
                .get_u64(BLK_ENABLED)
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let no_snapshot_bypass = model_node
                .get_u64(MODEL_NO_SNAPSHOT_BYPASS)
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let category = payload.get_u64(BLK_CATEGORY).and_then(Value::as_u64);
            let params = payload
                .get_u64(BLK_PARAMS)
                .and_then(|p| p.get_u64(PARAMS_VALUES))
                .and_then(Value::as_array)
                .map(<[Value]>::to_vec)
                .unwrap_or_default();
            Some(ChainEntry::Block(Block {
                model_id,
                category,
                enabled,
                no_snapshot_bypass,
                params,
            }))
        }
        CLASS_LOOPER => {
            let payload = payload?;
            let model_id = payload
                .get_u64(LOOPER_MODEL_ID)
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok());
            let enabled = payload
                .get_u64(BLK_ENABLED)
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let params = payload
                .get_u64(IO_PARAMS)
                .and_then(Value::as_array)
                .map(<[Value]>::to_vec)
                .unwrap_or_default();
            Some(ChainEntry::Looper {
                model_id,
                enabled,
                params,
            })
        }
        CLASS_EMPTY => Some(ChainEntry::Empty),
        other => Some(ChainEntry::Unknown { class: other }),
    }
}

fn parse_footswitches(node: Option<&Value>) -> Vec<FootswitchAssignment> {
    let groups = node
        .and_then(|fs| fs.get_u64(FS_GROUPS))
        .and_then(Value::as_array)
        .unwrap_or_default();

    let mut out = Vec::new();
    for (group, entries) in groups.iter().enumerate() {
        let Ok(group) = u8::try_from(group) else {
            break;
        };
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            let Some(target) = entry.get_u64(FS_TARGET) else {
                continue;
            };
            let Some(block) = target.get_u64(FST_BLOCK).and_then(Value::as_u64) else {
                continue;
            };
            let label = target
                .get_u64(FST_LABEL)
                .and_then(Value::as_str)
                .map(trim_nul)
                .unwrap_or_default();
            let enabled = target
                .get_u64(FST_ENABLED)
                .and_then(Value::as_bool)
                .unwrap_or(false);
            out.push(FootswitchAssignment {
                group,
                block,
                label,
                enabled,
            });
        }
    }
    out
}

fn parse_controllers(node: Option<&Value>) -> Vec<ControllerAssignment> {
    let Some(list) = node.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entries in list {
        // Each list item is either nil or a list of controller definitions.
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            let Some(def) = entry.get_u64(CTL_DEF) else {
                continue;
            };
            let (Some(controller), Some(param_index)) = (
                def.get_u64(CTLD_NUM).and_then(Value::as_u64),
                def.get_u64(CTLD_PARAM).and_then(Value::as_u64),
            ) else {
                continue;
            };
            out.push(ControllerAssignment {
                controller,
                param_index,
                min: def.get_u64(CTLD_MIN).and_then(Value::as_f64).unwrap_or(0.0),
                max: def.get_u64(CTLD_MAX).and_then(Value::as_f64).unwrap_or(1.0),
            });
        }
    }
    out
}

fn parse_snapshot(value: &Value) -> Option<Snapshot> {
    let name = value
        .get_u64(SNAP_NAME)
        .and_then(Value::as_str)
        .map(trim_nul)
        .unwrap_or_default();
    let valid = value
        .get_u64(SNAP_VALID)
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tempo = value.get_u64(SNAP_TEMPO).and_then(Value::as_f64);
    let enables = value
        .get_u64(SNAP_ENABLES)
        .and_then(Value::as_array)
        .map(|pairs| {
            pairs
                .iter()
                .filter_map(|pair| pair.as_array()?.get(1)?.as_bool())
                .collect()
        })
        .unwrap_or_default();
    Some(Snapshot {
        name,
        valid,
        tempo,
        enables,
    })
}

fn trim_nul(value: &str) -> String {
    value.split('\0').next().unwrap_or_default().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../../../fixtures/spec02_obj22_blob.bin");

    #[test]
    fn fixture_round_trips_byte_identically() {
        let container = Container::parse(FIXTURE).expect("fixture parses");
        assert_eq!(container.to_bytes().unwrap(), FIXTURE);
    }

    #[test]
    fn fixture_typed_view_matches_observed_values() {
        let preset = Container::parse_preset(FIXTURE).expect("preset parses");
        assert_eq!(preset.product, "P34");
        assert_eq!(preset.firmware, "v2.00-5-g665e64e");
        assert_eq!(preset.chain.len(), 12);
    }

    #[test]
    fn fixture_contains_expected_chain_classes() {
        let preset = Container::parse_preset(FIXTURE).unwrap();
        let mut input = 0;
        let mut output = 0;
        let mut blocks = 0;
        let mut empty = 0;
        for entry in &preset.chain {
            match entry {
                ChainEntry::Input { .. } => input += 1,
                ChainEntry::Output { .. } => output += 1,
                ChainEntry::Block(_) => blocks += 1,
                ChainEntry::Empty => empty += 1,
                ChainEntry::Looper { .. } | ChainEntry::Unknown { .. } => {}
            }
        }
        // Observed in the fixture: input, nine processing blocks, one empty
        // slot and output (twelve entries total).
        assert_eq!((input, blocks, empty, output), (1, 9, 1, 1));
    }

    #[test]
    fn fixture_decodes_footswitch_assignments() {
        let preset = Container::parse_preset(FIXTURE).unwrap();
        let labels: Vec<(String, u64)> = preset
            .footswitches
            .iter()
            .map(|fs| (fs.switch_name(), fs.block))
            .collect();
        // Observed in the fixture: FS1 -> EQ, FS2 -> FX loop, FS4/FS5/FS6 ->
        // drive/autofilter/growler, and the expression toe switch on the wah
        // and volume blocks.
        assert_eq!(
            labels,
            vec![
                ("FS1".to_owned(), 8),
                ("FS2".to_owned(), 5),
                ("FS4".to_owned(), 3),
                ("FS5".to_owned(), 4),
                ("FS6".to_owned(), 9),
                ("EXP Toe".to_owned(), 2),
                ("EXP Toe".to_owned(), 1),
            ]
        );
        let wah = &preset.footswitches[5];
        assert_eq!(wah.label, "Conductor");
        assert!(!wah.enabled);
        let volume = &preset.footswitches[6];
        assert_eq!(volume.label, "Volume Pedal");
        assert!(volume.enabled);
    }

    #[test]
    fn fixture_decodes_controller_assignments() {
        let preset = Container::parse_preset(FIXTURE).unwrap();
        assert_eq!(preset.controllers.len(), 2);
        // Controller 1 (EXP 1) sweeps parameter 4 (Pedal); controller 2 does
        // the same on the volume block. The target block is role-bound, not
        // stored, so it does not appear here.
        assert_eq!(preset.controllers[0].controller, 1);
        assert_eq!(preset.controllers[0].param_index, 0);
        assert_eq!(
            (preset.controllers[0].min, preset.controllers[0].max),
            (0.0, 1.0)
        );
        assert_eq!(preset.controllers[1].controller, 2);
    }

    #[test]
    fn missing_assignment_nodes_decode_as_empty() {
        let container = Container::parse(FIXTURE).unwrap();
        let entries = container
            .body()
            .as_map()
            .unwrap()
            .iter()
            .filter(|(key, _)| {
                key.as_u64() != Some(BODY_FOOTSWITCH) && key.as_u64() != Some(BODY_CONTROLLER)
            })
            .cloned()
            .collect();
        let preset = Preset::from_container(Container {
            magic: MAGIC.to_vec(),
            offset_table: Vec::new(),
            body: Value::map(entries),
            trailing: Vec::new(),
        });
        assert!(preset.footswitches.is_empty());
        assert!(preset.controllers.is_empty());
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = FIXTURE.to_vec();
        bytes[2] = b'X';
        assert!(matches!(
            Container::parse(&bytes),
            Err(DomainError::InvalidContainer(_))
        ));
    }

    #[test]
    fn rejects_truncated_table() {
        assert!(matches!(
            Container::parse(&FIXTURE[..40]),
            Err(DomainError::UnexpectedEof { .. })
        ));
    }

    #[test]
    fn preserves_trailing_bytes() {
        let mut bytes = FIXTURE.to_vec();
        bytes.extend_from_slice(&[0xde, 0xad]);
        let container = Container::parse(&bytes).unwrap();
        assert_eq!(container.trailing(), &[0xde, 0xad]);
        assert_eq!(container.to_bytes().unwrap(), bytes);
    }
}
