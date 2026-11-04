import {ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI} from "./wasi-shim/index.js"

const MIME = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    emf: "image/x-emf",
    wmf: "image/x-wmf",
    jfif: "image/jpeg",
    pict: "image/x-pict",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    css: "text/css",
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff"
}

const READERS = new Set(["docx", "odt", "rtf", "epub", "html", "markdown", "fb2"])
const WRITERS = new Set(["gfm", "html", "plain", "docx", "odt", "epub3", "fb2"])
const BINARY = new Set(["docx", "odt", "epub3"])
const EXT = {docx: "docx", odt: "odt", rtf: "rtf", epub: "epub", html: "html", markdown: "md", fb2: "fb2"}

let ready = null
let readyBase = null

export function mimeOf(path) {
    const m = /\.([A-Za-z0-9]+)$/.exec(path)
    return (m && MIME[m[1].toLowerCase()]) || "application/octet-stream"
}

async function sha256Hex(buf) {
    if (!globalThis.crypto || !crypto.subtle) return null
    const d = await crypto.subtle.digest("SHA-256", buf)
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("")
}

export async function loadWasmModule(baseUrl, onProgress) {
    const base = new URL(baseUrl)
    const manifest = await (await fetch(new URL("parts.json", base))).json()
    const whole = new Uint8Array(manifest.total)
    let off = 0
    for (let i = 0; i < manifest.parts.length; i++) {
        const p = manifest.parts[i]
        const res = await fetch(new URL(p.name, base))
        if (!res.ok) throw new Error(`Failed to fetch ${p.name}: ${res.status}`)
        const buf = new Uint8Array(p.size)
        let got = 0
        const reader = res.body.getReader()
        for (;;) {
            const {done, value} = await reader.read()
            if (done) break
            if (got + value.length > p.size) throw new Error(`Size mismatch for ${p.name}`)
            buf.set(value, got)
            got += value.length
            if (onProgress) onProgress(off + got, manifest.total)
        }
        if (got !== p.size) throw new Error(`Size mismatch for ${p.name}`)
        const h = p.sha256 ? await sha256Hex(buf) : null
        if (h && h !== p.sha256) throw new Error(`Checksum mismatch for ${p.name}`)
        whole.set(buf, off)
        off += buf.length
    }
    if (off !== manifest.total) throw new Error("Total size mismatch")
    return {module: await WebAssembly.compile(whole), manifest}
}

async function instantiate(module) {
    const args = ["pandoc.wasm", "+RTS", "-H64m", "-RTS"]
    const fileSystem = new Map()
    const fds = [
        new OpenFile(new File(new Uint8Array(), {readonly: true})),
        ConsoleStdout.lineBuffered(() => {}),
        ConsoleStdout.lineBuffered(() => {}),
        new PreopenDirectory("/", fileSystem)
    ]
    const wasi = new WASI(args, [], fds, {debug: false})
    const instance = await WebAssembly.instantiate(module, {wasi_snapshot_preview1: wasi.wasiImport})
    wasi.initialize(instance)
    instance.exports.__wasm_call_ctors()
    const ex = instance.exports
    const view = () => new DataView(ex.memory.buffer)
    const enc = new TextEncoder()
    const argc_ptr = ex.malloc(4)
    view().setUint32(argc_ptr, args.length, true)
    const argv = ex.malloc(4 * (args.length + 1))
    for (let i = 0; i < args.length; i++) {
        const a = enc.encode(args[i])
        const p = ex.malloc(a.length + 1)
        new Uint8Array(ex.memory.buffer, p, a.length + 1).set([...a, 0])
        view().setUint32(argv + 4 * i, p, true)
    }
    view().setUint32(argv + 4 * args.length, 0, true)
    const argv_ptr = ex.malloc(4)
    view().setUint32(argv_ptr, argv, true)
    ex.hs_init_with_rtsopts(argc_ptr, argv_ptr)

    function run(options, files) {
        const encoded = enc.encode(JSON.stringify(options))
        const ptr = ex.malloc(encoded.length)
        new Uint8Array(ex.memory.buffer, ptr, encoded.length).set(encoded)
        fileSystem.clear()
        const out = new File(new Uint8Array(), {readonly: false})
        const err = new File(new Uint8Array(), {readonly: false})
        const warn = new File(new Uint8Array(), {readonly: false})
        fileSystem.set("stdin", new File(new Uint8Array(), {readonly: true}))
        fileSystem.set("stdout", out)
        fileSystem.set("stderr", err)
        fileSystem.set("warnings", warn)
        const known = new Set(["stdin", "stdout", "stderr", "warnings"])
        for (const [name, data] of Object.entries(files)) {
            fileSystem.set(name, new File(data, {readonly: true}))
            known.add(name)
        }
        if (options["output-file"]) {
            fileSystem.set(options["output-file"], new File(new Uint8Array(), {readonly: false}))
            known.add(options["output-file"])
        }
        ex.convert(ptr, encoded.length)
        const dec = new TextDecoder("utf-8")
        let outputBytes = out.data
        if (options["output-file"]) {
            const f = fileSystem.get(options["output-file"])
            if (f && f.data && f.data.length) outputBytes = f.data
        }
        const media = []
        const walk = (map, prefix) => {
            for (const [name, entry] of map.entries()) {
                const path = prefix ? `${prefix}/${name}` : name
                if (entry instanceof Directory) walk(entry.contents, path)
                else if (!known.has(path) && entry.data && entry.data.length) media.push({path, data: entry.data})
            }
        }
        walk(fileSystem, "")
        let warnings = []
        const rawWarn = dec.decode(warn.data)
        if (rawWarn) {
            try {
                warnings = JSON.parse(rawWarn)
            } catch (e) {
                warnings = [rawWarn]
            }
        }
        const result = {outputBytes, stderr: dec.decode(err.data), warnings, media}
        fileSystem.clear()
        return result
    }

    return {run, memory: ex.memory}
}

export function init(baseUrl, onProgress) {
    const base = baseUrl || new URL("./parts/", import.meta.url).href
    if (ready && readyBase === base) return ready
    readyBase = base
    ready = loadWasmModule(base, onProgress).then(async ({module, manifest}) => {
        const inst = await instantiate(module)
        return {module, manifest, inst}
    })
    ready.catch(() => {
        ready = null
    })
    return ready
}

let broken = false

async function instanceFor(baseUrl) {
    const state = await init(baseUrl)
    if (broken) {
        state.inst = await instantiate(state.module)
        broken = false
    }
    return state.inst
}

function warningText(w) {
    if (typeof w === "string") return w
    if (w && typeof w === "object") {
        const type = w.type || ""
        const rest = Object.entries(w).filter(([k]) => k !== "type").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")
        return `${type} ${rest}`.trim()
    }
    return String(w)
}

export async function convertDocument(msg, baseUrl) {
    const {id, input, inputName, from, to, options, resources} = msg
    try {
        if (!READERS.has(from)) throw new Error(`Unsupported input format: ${from}`)
        if (!WRITERS.has(to)) throw new Error(`Unsupported output format: ${to}`)
        const inst = await instanceFor(baseUrl)
        const inFile = `input.${EXT[from]}`
        const files = {[inFile]: new Uint8Array(input)}
        for (const r of resources || []) files[r.path] = new Uint8Array(r.data)
        const opts = {
            from,
            to,
            "input-files": [inFile],
            "extract-media": ".",
            verbosity: "WARNING",
            ...(options || {})
        }
        if (to === "gfm" || to === "plain") opts.wrap = opts.wrap ?? "none"
        if (!(options && options.to) && to === "gfm") opts.to = "gfm-raw_html"
        if (BINARY.has(to)) opts["output-file"] = `output.${to}`
        if (to === "html") {
            opts.standalone = opts.standalone ?? true
            opts["embed-resources"] = opts["embed-resources"] ?? true
            delete opts["extract-media"]
            const title = String(inputName || "document").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") || "document"
            opts.metadata = {pagetitle: title, ...(opts.metadata || {})}
        }
        if (BINARY.has(to)) delete opts["extract-media"]
        let r
        try {
            r = inst.run(opts, files)
        } catch (e) {
            broken = true
            throw new Error(`The converter crashed on this file (${e && e.message ? e.message : e}). It may be too large or damaged.`)
        }
        const verbose = !!(options && options.verbosity === "INFO")
        const warnings = r.warnings.filter(w => verbose || !(w && w.verbosity === "INFO")).map(warningText)
        if (r.stderr.trim()) warnings.push(r.stderr.trim())
        if (!r.outputBytes.length) {
            throw new Error(warnings.length ? warnings.join("\n") : "Pandoc produced no output")
        }
        let output
        if (BINARY.has(to)) {
            const copy = new Uint8Array(r.outputBytes.length)
            copy.set(r.outputBytes)
            output = copy.buffer
        } else {
            output = new TextDecoder("utf-8").decode(r.outputBytes)
        }
        const media = r.media.map(m => {
            const copy = new Uint8Array(m.data.length)
            copy.set(m.data)
            return {path: m.path, mime: mimeOf(m.path), data: copy.buffer}
        })
        return {id, ok: true, output, media, warnings, error: null}
    } catch (e) {
        return {id, ok: false, output: null, media: [], warnings: [], error: String(e && e.message ? e.message : e)}
    }
}
