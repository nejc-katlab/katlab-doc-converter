# katlab document converter

The source of the document converter at https://tools.katlab.dev/document-converter/. It converts Word (.docx and old .doc), OpenDocument, RTF, EPUB, HTML and Markdown files to Markdown, HTML, PDF, Word, OpenDocument or plain text, entirely in the browser.

katlab's own files are licensed under the GNU General Public License, version 2 or later. Because the converter ships Pandoc (GPL-2.0-or-later) and boko (GPL-3.0-or-later) together, the combined converter is distributed under GPL-3.0-or-later (`licenses/boko-LICENSE-GPL-3.0`). `LICENSE` holds the GPL-2.0 text.

## Parts

- `src/pandoc/`: runs the official Pandoc WebAssembly build in a module worker (`worker.js`, `engine.js`). The wasm is split into parts under 25 MiB and checked against sha256 sums when it loads.
- `src/pandoc/wasi-shim/`: `@bjorn3/browser_wasi_shim` 0.4.2 (MIT OR Apache-2.0), unmodified.
- `src/doc/doc-text.js`: a small reader for old binary Word 97-2003 files that recovers text, headings and tables.
- `src/ebook/boko/`: boko v0.6.0 (GPL-3.0-or-later, https://github.com/zacharydenton/boko, commit 9ac23f67a51e6911125a78fc0f876c8367388f3d) compiled to WebAssembly, unmodified. It reads Kindle MOBI, AZW, AZW3 and KFX and writes EPUB and AZW3. See `docs/BUILD-boko.md`.
- `src/ebook/kepubify/`: kepubify v4.0.4 (MIT, https://github.com/pgaskin/kepubify) with its official web wrapper from the gh-pages branch (commit 448534694374e195f8a915c5caf16cdf22ec7792), built with Go 1.26.2 and two small compatibility patches in `scripts/patches/`. See `docs/BUILD-kepubify.md`.
- `src/ebook/tidy.js`: rewrites leftover Mobipocket markup in Kindle-derived EPUBs as standard CSS and repairs internal links. `src/ebook/client.js` runs the engine workers with timeouts and restarts them after a crash.
- `src/page.js`: the converter page, also used by the ebook page (`data-mode="ebook"`). PDF output goes through the katlab Markdown to PDF engine (`/assets/md2pdf-v1.js`, pdfmake), which is loaded from the site.

## Pandoc

- Version 3.13, the unmodified `pandoc-3.13-wasm.zip` release asset (sha256 `234d2020a7f3a9aab387bd35df3c17ca2ba0078a82490e2b3ede890d648d64fe`).
- Corresponding source: https://github.com/jgm/pandoc/tree/3.13, with the WebAssembly build described in that repository.
- Pandoc is copyright John MacFarlane and contributors, GPL-2.0-or-later. `licenses/pandoc-COPYING.md` and `licenses/pandoc-COPYRIGHT` are shipped next to the wasm.

## Build

```
node scripts/fetch-pandoc.mjs
node scripts/sync.mjs ../katlab-tools
```

`fetch-pandoc.mjs` downloads the release, verifies its checksum and writes the parts to `build/parts/`. `sync.mjs` copies the engine to `/assets/pandoc313/`, the ebook engines to `/assets/ebook1/`, the .doc reader to `/assets/doc1/` and the page script to `/document-converter/page.js` in the site checkout.
