//! Deterministic robustness and round-trip properties.
//!
//! These are "fuzz-style" tests without external dependencies: a fixed-seed
//! xorshift generator drives value generation, truncation and byte-mutation
//! sweeps. They assert two things:
//!
//! 1. encode → decode → encode is byte-identical for generated values;
//! 2. no parser panics on truncated or mutated input.
//!
//! Failures are reproducible: every generator uses a constant seed.

use podgo_domain::l6helix::Container;
use podgo_domain::msgpack::{self, Value};

const FIXTURE: &[u8] = include_bytes!("../../../fixtures/spec02_obj22_blob.bin");

/// Small deterministic xorshift64* generator.
struct Rng(u64);

impl Rng {
    const fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound.max(1)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

fn uint_widths(value: u64) -> Vec<u8> {
    let mut widths = vec![9];
    if value <= 0xffff_ffff {
        widths.push(5);
    }
    if value <= 0xffff {
        widths.push(3);
    }
    if value <= 0xff {
        widths.push(2);
    }
    if value <= 0x7f {
        widths.push(1);
    }
    widths
}

fn int_widths(value: i64) -> Vec<u8> {
    let mut widths = vec![9];
    if i32::try_from(value).is_ok() {
        widths.push(5);
    }
    if i16::try_from(value).is_ok() {
        widths.push(3);
    }
    if i8::try_from(value).is_ok() {
        widths.push(2);
    }
    if (-32..=-1).contains(&value) {
        widths.push(1);
    }
    widths
}

fn str_widths(len: usize) -> Vec<u8> {
    let mut widths = vec![3];
    if len <= 0xffff {
        widths.push(2);
    }
    if len <= 0xff {
        widths.push(1);
    }
    if len <= 31 {
        widths.push(0);
    }
    widths
}

fn bin_widths(len: usize) -> Vec<u8> {
    let mut widths = vec![3];
    if len <= 0xffff {
        widths.push(2);
    }
    if len <= 0xff {
        widths.push(1);
    }
    widths
}

fn container_widths(len: usize) -> Vec<u8> {
    if len <= 15 {
        vec![0, 2, 4]
    } else if len <= 0xffff {
        vec![2, 4]
    } else {
        vec![4]
    }
}

fn gen_value(rng: &mut Rng, depth: usize) -> Value {
    match rng.below(12) {
        0 => Value::Nil,
        1 => Value::Bool(rng.below(2) == 0),
        2 => {
            let value = match rng.below(4) {
                0 => rng.below(0x80),
                1 => rng.below(0x1_0000),
                2 => rng.below(0x1_0000_0000),
                _ => rng.next_u64(),
            };
            Value::UInt {
                value,
                width: *rng.pick(&uint_widths(value)),
            }
        }
        3 => {
            let value = match rng.below(3) {
                0 => -(rng.below(32) as i64) - 1,
                1 => i64::from(rng.below(0x1_0000) as i32) - 0x8000,
                _ => rng.next_u64() as i64,
            };
            Value::Int {
                value,
                width: *rng.pick(&int_widths(value)),
            }
        }
        4 => Value::F32((rng.below(20_000) as f32 - 10_000.0) / 7.0),
        5 => Value::F64((rng.below(1_000_000) as f64 - 500_000.0) / 13.0),
        6 | 7 => {
            let len = rng.below(48) as usize;
            let mut text = String::with_capacity(len);
            for _ in 0..len {
                text.push(char::from(b'!' + (rng.below(90) as u8)));
            }
            Value::Str {
                value: text.into_bytes(),
                width: *rng.pick(&str_widths(len)),
            }
        }
        8 => {
            let len = rng.below(48) as usize;
            let data: Vec<u8> = (0..len).map(|_| rng.next_u64() as u8).collect();
            Value::Bin {
                value: data,
                width: *rng.pick(&bin_widths(len)),
            }
        }
        9 if depth < 4 => {
            let len = rng.below(5) as usize;
            let items = (0..len).map(|_| gen_value(rng, depth + 1)).collect();
            Value::Array {
                items,
                width: *rng.pick(&container_widths(len)),
            }
        }
        10 if depth < 4 => {
            let len = rng.below(5) as usize;
            let entries = (0..len)
                .map(|_| (gen_value(rng, depth + 1), gen_value(rng, depth + 1)))
                .collect();
            Value::Map {
                entries,
                width: *rng.pick(&container_widths(len)),
            }
        }
        11 => {
            let len = usize::try_from(*rng.pick(&[0u64, 1, 2, 4, 8, 16, 40])).unwrap_or(0);
            Value::Ext {
                type_id: rng.next_u64() as i8,
                data: (0..len).map(|_| rng.next_u64() as u8).collect(),
            }
        }
        _ => Value::Nil,
    }
}

#[test]
fn generated_values_roundtrip_byte_identically() {
    let mut rng = Rng::new(0x5eed_1234_abcd_0001);
    for iteration in 0..2_000 {
        let value = gen_value(&mut rng, 0);
        let bytes = msgpack::encode(&value).unwrap_or_else(|err| {
            panic!("iteration {iteration}: encode failed for {value:?}: {err}")
        });
        let decoded = msgpack::decode(&bytes).unwrap_or_else(|err| {
            panic!("iteration {iteration}: decode failed for {bytes:02x?}: {err}")
        });
        assert_eq!(
            decoded, value,
            "iteration {iteration}: decoded value differs"
        );
        assert_eq!(
            msgpack::encode(&decoded).unwrap(),
            bytes,
            "iteration {iteration}: re-encode changed bytes"
        );
    }
}

#[test]
fn container_rejects_every_truncation_without_panicking() {
    for len in 0..FIXTURE.len() {
        let _ = Container::parse(&FIXTURE[..len]);
        let _ = msgpack::decode(&FIXTURE[..len]);
    }
}

#[test]
fn parsers_never_panic_on_mutated_input() {
    let mut rng = Rng::new(0x0bad_c0de_0000_0002);

    // Exhaustive single-bit flips at every offset, plus random multi-byte
    // corruption and prefixes. Errors are expected; panics are not.
    for index in 0..FIXTURE.len() {
        for mask in [0x01u8, 0x80] {
            let mut bytes = FIXTURE.to_vec();
            bytes[index] ^= mask;
            let _ = Container::parse(&bytes);
        }
    }

    for _ in 0..5_000 {
        let len = rng.below(FIXTURE.len() as u64) as usize;
        let mut bytes = FIXTURE[..len].to_vec();
        let corruptions = rng.below(4);
        for _ in 0..corruptions {
            if bytes.is_empty() {
                break;
            }
            let index = rng.below(bytes.len() as u64) as usize;
            bytes[index] = rng.next_u64() as u8;
        }
        let _ = Container::parse(&bytes);
        let _ = msgpack::decode(&bytes);
    }

    for _ in 0..1_000 {
        let len = rng.below(256) as usize;
        let bytes: Vec<u8> = (0..len).map(|_| rng.next_u64() as u8).collect();
        let _ = Container::parse(&bytes);
        let _ = msgpack::decode(&bytes);
    }
}

#[test]
fn trailing_bytes_are_preserved_verbatim() {
    let mut rng = Rng::new(0x7ea1_1111_2222_0003);
    for _ in 0..200 {
        let len = rng.below(64) as usize;
        let trailing: Vec<u8> = (0..len).map(|_| rng.next_u64() as u8).collect();
        let mut input = FIXTURE.to_vec();
        input.extend_from_slice(&trailing);

        let container = Container::parse(&input).expect("fixture with trailing bytes parses");
        assert_eq!(container.trailing(), trailing.as_slice());
        assert_eq!(container.to_bytes().unwrap(), input);
    }
}
