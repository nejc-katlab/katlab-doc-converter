# boko wasm build

Source: https://github.com/zacharydenton/boko, tag v0.6.0, commit 9ac23f67a51e6911125a78fc0f876c8367388f3d (GPL-3.0-or-later).
Toolchain: rustc 1.94.1 (rustup, target wasm32-unknown-unknown), wasm-pack 0.14.0 (installs wasm-bindgen-cli 0.2.130 from crates.io and downloads binaryen wasm-opt on first run).
No patches. Cargo.lock from the tag is used as is.

    export PATH=$HOME/.cargo/bin:$PATH
    git clone https://github.com/zacharydenton/boko && cd boko
    git checkout v0.6.0
    git rev-parse HEAD     # 9ac23f67a51e6911125a78fc0f876c8367388f3d
    wasm-pack build --target web --out-dir ../boko-out --no-default-features --features wasm
    cp ../boko-out/boko.js ../boko-out/boko_bg.wasm <dest>/
    cp LICENSE <dest>/LICENSE

The command is the one in the repo's .github/workflows/gh-pages.yml. Build time about 5 min cold.
worker.js is ours (ES module worker; imports ./boko.js, loads ./boko_bg.wasm relative to itself). boko.d.ts, package.json and README.md from wasm-pack are not shipped.

boko_bg.wasm sha256: e07127a7b97780008d8cee5fc206beee31aecafd5c10ef757d472b45de74e5a1
(wasm-opt output may differ byte-wise across wasm-pack/binaryen versions.)

GPL-3.0: the wasm is a derivative work; link the source tag publicly alongside the tool.
