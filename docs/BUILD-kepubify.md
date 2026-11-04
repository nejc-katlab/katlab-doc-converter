# kepubify wasm build

Library: github.com/pgaskin/kepubify/v4 v4.0.4 (tag v4.0.4 = commit 8e959eda11d783041fc03c1a8109275a27f2f2dc, MIT), fetched via the Go module proxy and verified against go.sum.
Wrapper: kepubify's gh-pages branch, commit 448534694374e195f8a915c5caf16cdf22ec7792 (2025-12-06), files go.mod, go.sum, src/kepubify/wasm/kepubify.go, src/kepubify/wasm/wasm.go. It pins the library at v4.0.4.
Toolchain: Go 1.26.2 darwin/arm64 (GOOS=js GOARCH=wasm). wasm_exec.js is copied from that Go's lib/wasm/wasm_exec.js (17 KB, BSD, license in LICENSE-go).
Do NOT run `go generate` in the wrapper: wasm_exec.go downloads wasm_exec.js from go.googlesource.com.

Two small patches are required for Go >= 1.18 (upstream was built with Go 1.17, where named js.Value wrapper types were accepted by syscall/js; newer Go panics with "ValueOf: invalid value"):

    wasm/wasm.go    : constructor("Array").Call("isArray", js.Value(a))         (was: a)
                      constructor("Uint8Array").New(js.Value(a))                (was: a)
    wasm/kepubify.go: "kepub": arr.JSValue(),  and transfer list []interface{}{arr.JSValue()}   (was: arr)

Commands:

    mkdir kb && cd kb
    G=https://raw.githubusercontent.com/pgaskin/kepubify/448534694374e195f8a915c5caf16cdf22ec7792
    curl -O $G/go.mod -O $G/go.sum
    mkdir wasm && curl -o wasm/kepubify.go $G/src/kepubify/wasm/kepubify.go -o wasm/wasm.go $G/src/kepubify/wasm/wasm.go
    # apply the two patches above
    GOFLAGS=-mod=readonly GOOS=js GOARCH=wasm go build -trimpath -o kepubify.wasm ./wasm
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" .

kepubify.wasm sha256: bf1711d5c676cdf97539347c68e67b303e128ee0c0ba33c7f7c8724b9d868f88
LICENSE is kepubify's MIT licence; LICENSE-go is Go's BSD licence (applies to wasm_exec.js and the Go runtime inside the wasm). The module also embeds BSD-licensed deps: etree, smartypants, golang.org/x/text and x/sync, and the pgaskin html/zip forks.
worker.js is ours (classic worker, importScripts('wasm_exec.js'), fetches kepubify.wasm relative to itself).
Each conversion instantiates a fresh Go runtime from the compiled module (the Go program is one-shot: main() exits after one book).
