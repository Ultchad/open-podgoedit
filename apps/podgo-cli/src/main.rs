//! `podgo-probe` — offline, read-only preset and setlist inspector.
//!
//! Usage:
//!
//! ```text
//! podgo-probe <path-to-l6-helix-blob.bin>
//! podgo-probe --setlist <path-to-streamed-setlist.bin>
//! ```
//!
//! Exit codes: `0` success (and byte-identical round-trip for presets), `1`
//! parse error or round-trip mismatch, `2` usage error.

use std::ffi::OsStr;
use std::process::ExitCode;

const USAGE: &str = "usage: podgo-probe [--setlist] <path>";

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(first) = args.next() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };

    let (setlist, path) = if first == "--help" || first == "-h" {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    } else if first == "--setlist" {
        let Some(path) = args.next() else {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        };
        (true, path)
    } else {
        (false, first)
    };

    if args.next().is_some() {
        eprintln!("error: expected exactly one path argument");
        return ExitCode::from(2);
    }

    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("error: cannot read {}: {err}", path.to_string_lossy());
            return ExitCode::from(1);
        }
    };

    if setlist {
        return inspect_setlist(&path, &bytes);
    }
    inspect_preset(&path, &bytes)
}

fn inspect_setlist(path: &OsStr, bytes: &[u8]) -> ExitCode {
    match podgo_cli::inspect_setlist(bytes) {
        Ok(report) => {
            println!("file:      {}", path.to_string_lossy());
            print!("{}", podgo_cli::render_setlist(&report));
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::from(1)
        }
    }
}

fn inspect_preset(path: &OsStr, bytes: &[u8]) -> ExitCode {
    match podgo_cli::inspect(bytes) {
        Ok(report) => {
            println!("file:      {}", path.to_string_lossy());
            print!("{}", podgo_cli::render(&report));
            if report.byte_identical {
                ExitCode::SUCCESS
            } else {
                eprintln!("error: local re-encode differs from the input; do not write it back");
                ExitCode::from(1)
            }
        }
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::from(1)
        }
    }
}
