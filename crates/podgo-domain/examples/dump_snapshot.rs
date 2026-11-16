use podgo_domain::l6helix::Container;

fn main() {
    let bytes = std::fs::read("fixtures/spec02_obj22_blob.bin").unwrap();
    let preset = Container::parse_preset(&bytes).unwrap();
    println!("chain={}", preset.chain.len());
    println!("snapshots={}", preset.snapshots.len());
    for (i, snapshot) in preset.snapshots.iter().enumerate() {
        println!(
            "snapshot {i}: name={:?} valid={} tempo={:?} enables={}",
            snapshot.name,
            snapshot.valid,
            snapshot.tempo,
            snapshot.enables.len()
        );
        println!("  {:?}", snapshot.enables);
    }
}
