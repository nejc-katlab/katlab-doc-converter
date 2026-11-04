import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2] || path.join(root, '..', 'katlab-tools'));
const eng = path.join(site, 'assets', 'pandoc313');

await rm(eng, { recursive: true, force: true });
await mkdir(eng, { recursive: true });
await cp(path.join(root, 'src', 'pandoc'), eng, { recursive: true });
await cp(path.join(root, 'build', 'parts'), path.join(eng, 'parts'), { recursive: true });
await cp(path.join(root, 'licenses'), path.join(eng, 'licenses'), { recursive: true });
await cp(path.join(root, 'LICENSE'), path.join(eng, 'licenses', 'katlab-doc-converter-LICENSE'));
await mkdir(path.join(site, 'assets', 'doc1'), { recursive: true });
await cp(path.join(root, 'src', 'doc', 'doc-text.js'), path.join(site, 'assets', 'doc1', 'doc-text.js'));
await mkdir(path.join(site, 'document-converter'), { recursive: true });
await cp(path.join(root, 'src', 'page.js'), path.join(site, 'document-converter', 'page.js'));
console.log(`synced into ${site}`);
