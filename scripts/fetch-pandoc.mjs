import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VERSION = '3.13';
const ZIP_SHA256 = '234d2020a7f3a9aab387bd35df3c17ca2ba0078a82490e2b3ede890d648d64fe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const zipPath = path.join(build, `pandoc-${VERSION}-wasm.zip`);

await mkdir(build, { recursive: true });
let zip;
try {
  zip = await readFile(zipPath);
} catch {
  const url = `https://github.com/jgm/pandoc/releases/download/${VERSION}/pandoc-${VERSION}-wasm.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  zip = Buffer.from(await res.arrayBuffer());
  await writeFile(zipPath, zip);
}
const sha = createHash('sha256').update(zip).digest('hex');
if (sha !== ZIP_SHA256) throw new Error(`checksum mismatch: ${sha}`);
const out = path.join(build, 'unzipped');
await rm(out, { recursive: true, force: true });
execFileSync('unzip', ['-q', '-o', zipPath, '-d', out]);
const wasm = execFileSync('find', [out, '-name', 'pandoc.wasm']).toString().trim().split('\n')[0];
if (!wasm) throw new Error('pandoc.wasm not found in the release zip');
execFileSync('node', [path.join(root, 'scripts', 'split.mjs'), wasm, path.join(build, 'parts')], { stdio: 'inherit' });
