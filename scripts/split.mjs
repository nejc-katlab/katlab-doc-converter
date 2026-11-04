import {createHash} from "node:crypto"
import {readFile, writeFile, mkdir, rm} from "node:fs/promises"
import {fileURLToPath} from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const src = process.argv[2] || path.join(here, "..", "build", "pandoc.wasm")
const outDir = process.argv[3] || path.join(here, "..", "build", "parts")
const partSize = Number(process.argv[4] || 20 * 1024 * 1024)

const buf = await readFile(src)
await rm(outDir, {recursive: true, force: true})
await mkdir(outDir, {recursive: true})
const parts = []
for (let off = 0, i = 1; off < buf.length; off += partSize, i++) {
    const chunk = buf.subarray(off, Math.min(off + partSize, buf.length))
    const name = `pandoc.part${i}.wasm`
    await writeFile(path.join(outDir, name), chunk)
    parts.push({name, size: chunk.length, sha256: createHash("sha256").update(chunk).digest("hex")})
}
const manifest = {
    pandoc: "3.13",
    total: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    parts
}
await writeFile(path.join(outDir, "parts.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(JSON.stringify(manifest, null, 2))
