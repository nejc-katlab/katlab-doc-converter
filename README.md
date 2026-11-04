# katlab document converter

The source of the document converter at https://tools.katlab.dev/document-converter/. It converts Word (.docx and old .doc), OpenDocument, RTF, EPUB, HTML and Markdown files to Markdown, HTML, PDF, Word, OpenDocument or plain text, entirely in the browser.

Licensed under the GNU General Public License, version 2 or later (see `LICENSE`), because it ships Pandoc.

## Parts

- `src/pandoc/`: runs the official Pandoc WebAssembly build in a module worker (`worker.js`, `engine.js`). The wasm is split into parts under 25 MiB and checked against sha256 sums when it loads.
- `src/pandoc/wasi-shim/`: `@bjorn3/browser_wasi_shim` 0.4.2 (MIT OR Apache-2.0), unmodified.
- `src/doc/doc-text.js`: a small reader for old binary Word 97-2003 files that recovers text, headings and tables.
- `src/page.js`: the converter page. PDF output goes through the katlab Markdown to PDF engine (`/assets/md2pdf-v1.js`, pdfmake), which is loaded from the site.

## Pandoc

- Version 3.13, the unmodified `pandoc-3.13-wasm.zip` release asset (sha256 `234d2020a7f3a9aab387bd35df3c17ca2ba0078a82490e2b3ede890d648d64fe`).
- Corresponding source: https://github.com/jgm/pandoc/tree/3.13, with the WebAssembly build described in that repository.
- Pandoc is copyright John MacFarlane and contributors, GPL-2.0-or-later. `licenses/pandoc-COPYING.md` and `licenses/pandoc-COPYRIGHT` are shipped next to the wasm.

## Build

```
node scripts/fetch-pandoc.mjs
node scripts/sync.mjs ../katlab-tools
```

`fetch-pandoc.mjs` downloads the release, verifies its checksum and writes the parts to `build/parts/`. `sync.mjs` copies the engine to `/assets/pandoc313/`, the .doc reader to `/assets/doc1/` and the page script to `/document-converter/page.js` in the site checkout.
