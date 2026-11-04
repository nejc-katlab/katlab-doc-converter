import { EbookWorker } from '/assets/ebook1/client.js?v=1';
import { tidyKindleEpub } from '/assets/ebook1/tidy.js?v=2';
import { readDoc, docToMarkdown, docToText } from '/assets/doc1/doc-text.js?v=1';

const $ = (id) => document.getElementById(id);
const ENGINE = '/assets/pandoc313/';
const MODE = document.body.dataset.mode || 'docs';
const STORE = MODE === 'ebook' ? 'katlab_ebookconv' : 'katlab_docconv';
const listEl = $('files');
const previewEl = $('preview');
const engineEl = $('engine');
const items = [];
let nextId = 1;
let selected = null;
let worker = null;
let engine = null;
let reqId = 1;
const pending = new Map();
let queue = Promise.resolve();
let md2pdf = null;

const OUT = {
  md: { label: 'Markdown', ext: 'md', mime: 'text/markdown' },
  html: { label: 'HTML', ext: 'html', mime: 'text/html' },
  pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  docx: { label: 'Word', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  odt: { label: 'OpenDocument', ext: 'odt', mime: 'application/vnd.oasis.opendocument.text' },
  txt: { label: 'Plain text', ext: 'txt', mime: 'text/plain' },
  epub: { label: 'EPUB', ext: 'epub', mime: 'application/epub+zip' },
  fb2: { label: 'FictionBook', ext: 'fb2', mime: 'application/x-fictionbook+xml' },
  kepub: { label: 'Kobo KEPUB', ext: 'kepub.epub', mime: 'application/epub+zip' },
  azw3: { label: 'Kindle AZW3', ext: 'azw3', mime: 'application/vnd.amazon.ebook' },
};

const boko = new EbookWorker('/assets/ebook1/boko/worker.js?v=1', { type: 'module' });
const kepubify = new EbookWorker('/assets/ebook1/kepubify/worker.js?v=1', { type: 'classic' });

async function runEngine(w, op, bytes, options) {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const r = await w.convert(op, input, options);
  if (!r.ok) {
    const msg = String(r.error || 'conversion failed');
    if (/drm|encrypt|protected/i.test(msg)) throw new Error(DRM_MESSAGE);
    if (/timed out/i.test(msg)) throw new Error(msg);
    if (/I\/O error|invalid range|Could not find|Unknown book type|Not a valid|EOCD|zip|crashed|unexpected end|out of range/i.test(msg)) throw new Error(`the file looks damaged or incomplete, so it could not be read (${msg.replace(/^(Error|I\/O error):\s*/i, '').slice(0, 120)})`);
    throw new Error(msg.replace(/^Error:\s*/, '').slice(0, 300));
  }
  return new Uint8Array(r.output);
}

async function kindleToEpub(item) {
  if (item.kind !== 'kindle') return;
  item.status = `reading ${item.kindLabel}…`;
  render();
  const epub = await runEngine(boko, 'boko', item.bytes, { from: item.from, to: 'epub' });
  const tidy = tidyKindleEpub(epub, window.fflate);
  item.bytes = tidy.bytes;
  item.kind = 'epub';
  item.fromKindle = true;
  item.kindleNotes = [`Read from ${item.kindLabel} and rebuilt as EPUB${tidy.notes.length ? `; ${tidy.notes.join('; ')}` : ''}.`];
}

async function epubOf(item, o) {
  if (item.kind === 'epub') return item.bytes;
  const r = await convert(item, { ...o, to: 'epub' });
  return new Uint8Array(await r.blob.arrayBuffer());
}

const KIND_LABEL = { docx: 'Word (.docx)', doc: 'Word 97-2003 (.doc)', odt: 'OpenDocument (.odt)', rtf: 'Rich Text (.rtf)', epub: 'EPUB e-book', html: 'HTML', markdown: 'Markdown', fb2: 'FictionBook (.fb2)', text: 'Plain text' };

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function opts() {
  return { to: $('to').value, mdImages: $('mdImages').value, pageSize: $('pageSize').value, pdfFont: $('pdfFont').value };
}

function saveOpts() {
  try {
    localStorage.setItem(STORE, JSON.stringify(opts()));
  } catch {}
}

function restoreOpts() {
  try {
    const o = JSON.parse(localStorage.getItem(STORE) || '{}');
    for (const k of ['to', 'mdImages', 'pageSize', 'pdfFont']) if (o[k] && [...$(k).options].some((x) => x.value === o[k])) $(k).value = o[k];
  } catch {}
}

function syncOptionRows() {
  const to = $('to').value;
  $('row-md').hidden = to !== 'md';
  $('row-pdf').hidden = to !== 'pdf';
}

function ensureWorker() {
  if (worker) return engine;
  worker = new Worker(`${ENGINE}worker.js?v=2`, { type: 'module' });
  engine = new Promise((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m?.type === 'progress') {
        const pct = Math.min(100, Math.round((m.loaded / m.total) * 100));
        engineEl.textContent = `Loading the converter engine (one-time download, cached afterwards): ${pct}%`;
        engineEl.className = 'busy';
        return;
      }
      if (m?.type === 'ready') {
        if (m.error) {
          engineEl.textContent = /compile|opcode|CompileError|WebAssembly/i.test(m.error) ? 'This browser is too old for the converter engine. Please use a current version of Chrome, Edge, Firefox or Safari. Old .doc files still convert to text and Markdown.' : `The converter engine could not load: ${m.error}`;
          engineEl.className = 'bad';
          reject(new Error(m.error));
        } else {
          engineEl.textContent = 'Converter engine ready.';
          engineEl.className = 'ok';
          resolve(true);
        }
        return;
      }
      const p = pending.get(m?.id);
      if (p) {
        pending.delete(m.id);
        p(m);
      }
    };
    worker.onerror = (e) => {
      engineEl.textContent = `The converter engine failed: ${e.message || 'worker error'}`;
      engineEl.className = 'bad';
      reject(new Error(e.message || 'worker error'));
    };
    engineEl.textContent = 'Loading the converter engine…';
    engineEl.className = 'busy';
    worker.postMessage({ type: 'warmup' });
  });
  engine.catch(() => {});
  return engine;
}

function pandoc(input, from, to, options = {}, resources = []) {
  const run = async () => {
    await ensureWorker();
    const id = reqId++;
    const copy = input instanceof ArrayBuffer ? input.slice(0) : new TextEncoder().encode(input).buffer;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, input: copy, inputName: 'document', from, to, options, resources }, [copy]);
    });
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p.then((r) => {
    if (!r.ok) throw new Error(cleanError(r.error));
    return r;
  });
}

function cleanError(e) {
  const s = String(e || 'conversion failed');
  if (/central directory|unpack docx|zip/i.test(s)) return 'the file is damaged or not a real document (its ZIP container could not be opened)';
  if (/ePub/i.test(s)) return 'the e-book could not be opened; it may be damaged or DRM-protected';
  return s.replace(/^ERROR:\s*/i, '').slice(0, 300);
}

function u16(bytes, str) {
  const pat = [];
  for (const ch of str) pat.push(ch.charCodeAt(0), 0);
  outer: for (let i = 0; i + pat.length <= Math.min(bytes.length, 1 << 20); i++) {
    for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

function zipNames(bytes) {
  const names = [];
  let mimetype = '';
  try {
    window.fflate.unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        return f.name === 'mimetype' && f.originalSize < 200;
      },
    });
  } catch {
    return null;
  }
  let encryption = '';
  try {
    const want = (f) => (f.name === 'mimetype' && f.originalSize < 200) || (f.name === 'META-INF/encryption.xml' && f.originalSize < 4 << 20);
    const got = window.fflate.unzipSync(bytes, { filter: want });
    if (got.mimetype) mimetype = new TextDecoder().decode(got.mimetype).trim();
    if (got['META-INF/encryption.xml']) encryption = new TextDecoder().decode(got['META-INF/encryption.xml']);
  } catch {}
  return { names, mimetype, encryption };
}

const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

function epubDrm(z) {
  if (z.names.includes('META-INF/rights.xml')) return true;
  if (!z.encryption) return false;
  const methods = [...z.encryption.matchAll(/<(?:\w+:)?EncryptionMethod\b[^>]*\bAlgorithm="([^"]+)"/g)].map((m) => m[1]);
  return methods.some((a) => !FONT_OBFUSCATION.has(a));
}

const DRM_MESSAGE = 'this book is protected by DRM (copy protection), so it cannot be converted; this tool works with DRM-free books only';

function detect(bytes, name) {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const b = bytes;
  if (b.length < 4) return { error: 'the file is empty' };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    if (u16(b, 'EncryptedPackage')) return { error: 'the document is password-protected; open it in Word, remove the password, then try again' };
    if (u16(b, 'WordDocument')) return { kind: 'doc' };
    if (u16(b, 'Workbook') || u16(b, 'Book')) return { error: 'this is an old Excel spreadsheet, not a text document' };
    if (u16(b, 'PowerPoint Document')) return { error: 'this is an old PowerPoint file, not a text document' };
    if (u16(b, 'MatOST') || ext === 'wps') return { error: 'Microsoft Works documents are not supported; open the file in Word or LibreOffice and save it as .docx' };
    return { error: 'this Office file is not a Word document' };
  }
  if (b[0] === 0x50 && b[1] === 0x4b) {
    const z = zipNames(b);
    if (!z) return { error: 'the ZIP container is damaged' };
    const has = (p) => z.names.some((n) => n === p || n.startsWith(p));
    if (has('word/')) return { kind: 'docx' };
    if (z.mimetype === 'application/vnd.oasis.opendocument.text' || (has('content.xml') && ext === 'odt')) return { kind: 'odt' };
    if (z.mimetype === 'application/epub+zip' || has('META-INF/container.xml')) return epubDrm(z) ? { error: DRM_MESSAGE } : { kind: 'epub' };
    if (has('xl/') || /spreadsheet/.test(z.mimetype)) return { error: 'this is a spreadsheet, not a text document' };
    if (has('ppt/') || /presentation/.test(z.mimetype)) return { error: 'this is a presentation, not a text document' };
    if (has('Index/') && z.names.some((n) => n.endsWith('.iwa'))) return { error: 'Apple Pages files are not supported; in Pages choose File > Export To > Word, then convert the .docx' };
    const fb2 = z.names.find((n) => /\.fb2$/i.test(n));
    if (fb2) return { kind: 'fb2', inner: fb2 };
    if (z.names.some((n) => /\.(jpe?g|png|gif|webp)$/i.test(n)) && /^(cbz|zip)$/.test(ext)) return { error: 'this is a comic or image archive, not a text document' };
    return { error: 'this ZIP file is not a document' };
  }
  if (b.length > 68) {
    const tag = String.fromCharCode(...b.subarray(60, 68));
    if (tag === 'BOOKMOBI' || tag === 'TEXtREAd') {
      if (MODE !== 'ebook') return { error: 'this is a Kindle ebook; use the Ebook Converter (tools.katlab.dev/ebook-converter/) to convert it' };
      return { kind: 'kindle', from: ext === 'azw3' ? 'azw3' : 'mobi', label: ext === 'azw3' ? 'Kindle AZW3' : ext === 'prc' || ext === 'pdb' ? 'Mobipocket' : ext === 'azw' ? 'Kindle AZW' : 'Kindle MOBI' };
    }
  }
  if (b[0] === 0xea && b[1] === 0x44 && b[2] === 0x52 && b[3] === 0x4d) return { error: DRM_MESSAGE };
  if (b[0] === 0x43 && b[1] === 0x4f && b[2] === 0x4e && b[3] === 0x54) {
    if (MODE !== 'ebook') return { error: 'this is a Kindle ebook; use the Ebook Converter (tools.katlab.dev/ebook-converter/) to convert it' };
    return { kind: 'kindle', from: 'kfx', label: 'Kindle KFX' };
  }
  if (b[0] === 0xff && b[1] === 0x57 && b[2] === 0x50 && b[3] === 0x43) return { error: 'WordPerfect documents are not supported; open the file in LibreOffice or WordPerfect and save it as .docx' };
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 4096)).replace(/^﻿/, '');
  if (/^\s*\{\\rtf/.test(head) || (ext === 'rtf' && /^\s*\{/.test(head))) return { kind: 'rtf' };
  if (/^\s*(<!doctype html|<html|<\?xml[^>]*>\s*<html)/i.test(head) || ['html', 'htm', 'xhtml'].includes(ext)) return { kind: 'html' };
  if (/<FictionBook[\s>]/.test(head)) return { kind: 'fb2' };
  if (['md', 'markdown', 'mdown'].includes(ext)) return { kind: 'markdown' };
  if (ext === 'txt' || ext === 'text' || !ext) return { kind: 'text' };
  if (ext === 'pages') return { error: 'Apple Pages files are not supported; in Pages choose File > Export To > Word, then convert the .docx' };
  return { error: 'this file type is not supported' };
}

function base(name) {
  return (name.replace(/\.[^.]+$/, '').replace(/\.(fb2|kepub)$/i, '') || 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

function normPath(p) {
  return String(p || '').replace(/^\.\//, '').replace(/\\/g, '/');
}

function safePath(p) {
  return normPath(p).split('/').filter((s) => s && s !== '..' && s !== '.').join('/') || 'media/file';
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return '';
  return (m[2] ?? m[3] ?? m[4] ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function mdEscapeAlt(s) {
  return s.replace(/[\[\]\\]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
}

function mdUrl(u) {
  return /[\s()<>]/.test(u) ? `<${u.replace(/[<>]/g, encodeURIComponent)}>` : u;
}

function tidyMarkdown(md) {
  let out = md.replace(/<figure[^>]*>([\s\S]*?)<\/figure>/gi, (all, inner) => {
    const img = inner.match(/<img\b[^>]*>/i);
    if (!img) return all;
    const cap = (inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const alt = attr(img[0], 'alt') || cap;
    const src = attr(img[0], 'src');
    if (!src) return all;
    const title = cap && cap !== alt ? ` "${cap.replace(/"/g, '\\"')}"` : '';
    return `![${mdEscapeAlt(alt)}](${mdUrl(src)}${title})`;
  });
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, 'src');
    if (!src) return tag;
    return `![${mdEscapeAlt(attr(tag, 'alt'))}](${mdUrl(src)})`;
  });
  return out;
}

function cellText(node) {
  const parts = [];
  const walk = (n, prefix) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        const t = c.nodeValue.replace(/\s+/g, ' ');
        if (t.trim()) parts.push({ t, prefix });
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      if (tag === 'li') {
        parts.push({ br: true });
        walk(c, '• ');
      } else if (['p', 'div', 'ul', 'ol', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'].includes(tag)) {
        parts.push({ br: true });
        walk(c, prefix);
        parts.push({ br: true });
      } else if (tag === 'img') parts.push({ t: c.getAttribute('alt') || '', prefix });
      else if (tag === 'strong' || tag === 'b') {
        const t = c.textContent.replace(/\s+/g, ' ').trim();
        if (t) parts.push({ t: `**${t}**`, prefix, raw: true });
      } else if (tag === 'em' || tag === 'i') {
        const t = c.textContent.replace(/\s+/g, ' ').trim();
        if (t) parts.push({ t: `*${t}*`, prefix, raw: true });
      } else walk(c, prefix);
    }
  };
  walk(node, '');
  const lines = [];
  let cur = '';
  let usedPrefix = false;
  for (const p of parts) {
    if (p.br) {
      if (cur.trim()) lines.push(cur.trim());
      cur = '';
      usedPrefix = false;
      continue;
    }
    if (!usedPrefix && p.prefix) {
      cur += p.prefix;
      usedPrefix = true;
    }
    cur += p.raw ? p.t : p.t.replace(/([\\`*_[\]|<>])/g, '\\$1');
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('<br>').replace(/\|/g, '\\|');
}

function flattenTables(md) {
  return md.replace(/<table[\s\S]*?<\/table>/gi, (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...doc.querySelectorAll('tr')];
    if (!rows.length) return '';
    const cells = rows.map((r) => [...r.children].filter((c) => /^(td|th)$/i.test(c.tagName)).map(cellText));
    const n = Math.max(...cells.map((r) => r.length), 1);
    const pad = (r) => [...r, ...Array(n - r.length).fill('')];
    const line = (r) => `| ${pad(r).map((c) => c || ' ').join(' | ')} |`;
    return ['', line(cells[0]), `|${' --- |'.repeat(n)}`, ...cells.slice(1).map(line), ''].join('\n');
  });
}

function pdfMath(md) {
  return md.replace(/\$\$`([^`]+)`\$\$/g, (m, t) => `\n$$\n${t}\n$$\n`).replace(/\$`([^`\n]+)`\$/g, (m, t) => `$${t}$`);
}

let mathjax = null;

function loadMathJax() {
  if (!mathjax) {
    mathjax = new Promise((resolve, reject) => {
      window.MathJax = {
        loader: { load: [] },
        svg: { fontCache: 'none' },
        options: { enableMenu: false },
        startup: {
          typeset: false,
          ready() {
            window.MathJax.startup.defaultReady();
            window.MathJax.startup.promise.then(() => resolve(window.MathJax), reject);
          },
        },
      };
      const sc = document.createElement('script');
      sc.src = '/assets/mathjax-3.2.2/tex-svg.js';
      sc.onerror = () => reject(new Error('math engine failed to load'));
      document.head.append(sc);
    });
    mathjax.catch(() => {
      mathjax = null;
    });
  }
  return mathjax;
}

function texToSvg(MJ, tex, color) {
  const node = MJ.tex2svg(tex, { display: true });
  const svg = node.querySelector('svg');
  const widthEx = parseFloat(svg.getAttribute('width')) || 10;
  const heightEx = parseFloat(svg.getAttribute('height')) || 2;
  svg.removeAttribute('style');
  svg.setAttribute('width', String(widthEx * 8));
  svg.setAttribute('height', String(heightEx * 8));
  const error = node.querySelector('[data-mjx-error]')?.getAttribute('data-mjx-error') || null;
  return { svg: new XMLSerializer().serializeToString(svg).replace(/currentColor/g, color), widthEx, heightEx, error };
}

function mediaMap(media) {
  const m = new Map();
  for (const x of media) m.set(normPath(x.path), x);
  return m;
}

function b64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

function viewable(mime) {
  return /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)$/.test(mime);
}

function mediaWarnings(media) {
  const odd = media.filter((m) => /^image\//.test(m.mime) && !viewable(m.mime));
  if (!odd.length) return [];
  const kinds = [...new Set(odd.map((m) => m.path.split('.').pop().toUpperCase()))].join(', ');
  return [`${odd.length} image${odd.length === 1 ? ' is' : 's are'} in an old Windows format (${kinds}) that browsers cannot show; ${odd.length === 1 ? 'it is' : 'they are'} kept as files but missing from previews and the PDF.`];
}

async function source(item) {
  if (item.src) return item.src;
  if (item.kind === 'doc') {
    const r = readDoc(item.bytes);
    if (r.encrypted) throw new Error('the document is password-protected; open it in Word, remove the password, then try again');
    const md = docToMarkdown(r);
    if (!md.trim()) throw new Error(r.warnings[0] || 'no text could be found in this file');
    item.src = { md, text: docToText(r), media: [], title: r.meta?.title || '', warnings: ['Old Word 97-2003 file: the text, headings and tables were recovered, but formatting, images, list numbering and footnotes were not. For a full conversion, open it in Word or LibreOffice, save it as .docx, and convert that.', ...r.warnings.slice(0, 3)] };
    return item.src;
  }
  const r = await pandoc(...pin(item), 'gfm', { to: 'gfm' });
  const media = r.media.map((m) => ({ ...m, path: safePath(m.path), bytes: new Uint8Array(m.data) }));
  item.src = { md: tidyMarkdown(r.output), media, warnings: [...mediaWarnings(media), ...r.warnings.filter(usefulWarning).slice(0, 4)] };
  return item.src;
}

function usefulWarning(w) {
  return !/Could not fetch resource|LoadedResource|NoTitleElement/i.test(w);
}

function inputBuffer(item) {
  return item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength);
}

function pin(item) {
  if (item.kind === 'text') return [item.textMd, 'markdown'];
  return [inputBuffer(item), item.kind];
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), enc: 'UTF-16' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), enc: 'UTF-16' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, ''), enc: 'UTF-8' };
  } catch {
    const count = (s, re) => (s.match(re) || []).length;
    const w1252 = new TextDecoder('windows-1252').decode(bytes);
    const w1250 = new TextDecoder('windows-1250').decode(bytes);
    const w1251 = new TextDecoder('windows-1251').decode(bytes);
    const s1252 = count(w1252, /[\u00e0\u00e1\u00e2\u00e4\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f1\u00f2\u00f3\u00f4\u00f6\u00f9\u00fa\u00fb\u00fc\u00ff\u00e6\u00f8\u00e5\u00c0\u00c1\u00c2\u00c4\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d1\u00d2\u00d3\u00d4\u00d6\u00d9\u00da\u00db\u00dc\u00c6\u00d8\u00c5\u00df]/g);
    const s1250 = count(w1250, /[\u010d\u0107\u017e\u0161\u0111\u0159\u011b\u0142\u0151\u0171\u0105\u0119\u015b\u017a\u0148\u0165\u010f\u013e\u013a\u0155\u016f\u010c\u0106\u017d\u0160\u0110\u0158\u011a\u0141\u0150\u0170\u0104\u0118\u015a\u0179\u0147\u0164\u010e\u013d\u0139\u0154\u016e]/g);
    const s1251 = count(w1251, /[\u0430-\u044f\u0410-\u042f\u0451\u0401]/g);
    if (s1251 > 2 * Math.max(s1250, s1252, 1)) return { text: w1251, enc: 'Windows-1251 (Cyrillic)' };
    if (s1250 > s1252) return { text: w1250, enc: 'Windows-1250 (Central European)' };
    return { text: w1252, enc: 'Windows-1252 (Western)' };
  }
}

const CHAPTER = /^(chapter|part|book|section|volume|prologue|epilogue|preface|introduction|afterword|appendix|kapitel|teil|poglavje|del|capítulo|capitulo|chapitre|partie|capitolo|parte|hoofdstuk|rozdział|глава|часть)\b/i;

function mdEscapeLine(s) {
  return s.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, '$1\\$2$3').replace(/^(\s*)([=-]{3,})\s*$/, '$1\\$2');
}

function textToMarkdown(text) {
  const norm = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const lines = norm.split('\n');
  const hasBlank = lines.some((l, i) => i > 0 && i < lines.length - 1 && !l.trim());
  const paras = hasBlank ? norm.split(/\n\s*\n+/) : lines;
  let chapters = 0;
  const out = [];
  for (const raw of paras) {
    const p = raw.trim();
    if (!p) continue;
    const single = !p.includes('\n');
    const caps = single && p.length < 60 && /[A-ZÀ-ÞА-Я]/.test(p) && p === p.toUpperCase() && /[A-ZÀ-ÞА-Я]{3}/.test(p);
    const roman = single && /^[IVXLC]+\.?$/.test(p);
    if (single && p.length < 80 && (CHAPTER.test(p) || caps || roman)) {
      chapters++;
      out.push(`# ${mdEscapeLine(p)}`);
      continue;
    }
    out.push(p.split('\n').map((l) => mdEscapeLine(l.trim())).filter(Boolean).join(hasBlank ? ' ' : '\n'));
  }
  return { md: out.join('\n\n'), chapters };
}

function metaResource(title) {
  return [{ path: 'katlab-meta.yaml', data: new TextEncoder().encode(`title: ${JSON.stringify(title)}\nlang: ${JSON.stringify(document.documentElement.lang || 'en')}\n`).buffer }];
}

async function htmlPreview(item) {
  if (item.previewHtml) return item.previewHtml;
  let html;
  if (item.kind === 'doc') {
    const s = await source(item);
    html = (await pandoc(s.md, 'markdown', 'html')).output;
  } else html = (await pandoc(...pin(item), 'html')).output;
  item.previewHtml = html;
  return html;
}

function embedImages(md, media) {
  const mm = mediaMap(media);
  return md.replace(/(!\[[^\]]*\]\()(<[^>]+>|[^)\s]+)/g, (all, pre, src) => {
    const key = normPath(src.replace(/^<|>$/g, ''));
    const m = mm.get(key);
    if (!m) return all;
    return `${pre}data:${m.mime};base64,${b64(m.bytes)}`;
  });
}

async function convert(item, o) {
  const key = JSON.stringify([o.to, o.to === 'md' ? o.mdImages : '', o.to === 'pdf' ? [o.pageSize, o.pdfFont] : '']);
  if (item.results.has(key)) return item.results.get(key);
  const name = base(item.name);
  const warnings = [];
  let res;
  if (o.to === 'md') {
    const s = await source(item);
    warnings.push(...s.warnings);
    if (s.media.length && o.mdImages === 'zip') {
      const files = { [`${name}.md`]: new TextEncoder().encode(s.md) };
      for (const m of s.media) files[m.path] = m.bytes;
      const zip = window.fflate.zipSync(files, { level: 6 });
      res = { blob: new Blob([zip], { type: 'application/zip' }), name: `${name}.zip`, files, preview: { kind: 'text', text: s.md }, note: `Markdown + ${s.media.length} image${s.media.length === 1 ? '' : 's'} (ZIP)` };
    } else {
      const md = s.media.length ? embedImages(s.md, s.media) : s.md;
      res = { blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }), name: `${name}.md`, preview: { kind: 'text', text: s.md } };
    }
  } else if (o.to === 'txt') {
    let text;
    if (item.kind === 'doc') {
      const s = await source(item);
      warnings.push(...s.warnings.slice(0, 1));
      text = s.text;
    } else text = (await pandoc(...pin(item), 'plain')).output;
    res = { blob: new Blob([text], { type: 'text/plain;charset=utf-8' }), name: `${name}.txt`, preview: { kind: 'text', text } };
  } else if (o.to === 'html') {
    if (item.kind === 'doc') warnings.push(...(await source(item)).warnings.slice(0, 1));
    else {
      const s = await source(item).catch(() => null);
      if (s) warnings.push(...s.warnings.filter((w) => /Windows format/.test(w)));
    }
    const html = await htmlPreview(item);
    res = { blob: new Blob([html], { type: 'text/html;charset=utf-8' }), name: `${name}.html`, preview: { kind: 'html', html } };
  } else if (o.to === 'epub' && item.fromKindle) {
    warnings.push(...item.kindleNotes);
    res = { blob: new Blob([item.bytes], { type: OUT.epub.mime }), name: `${name}.epub`, preview: { kind: 'lazy' } };
  } else if (o.to === 'kepub') {
    const epub = await epubOf(item, o);
    const out = await runEngine(kepubify, 'kepub', epub, {});
    if (item.fromKindle) warnings.push(...item.kindleNotes);
    warnings.push('Made with kepubify. Copy the .kepub.epub file to your Kobo over USB; Kobo uses it for faster page turns and reading statistics.');
    res = { blob: new Blob([out], { type: OUT.kepub.mime }), name: `${name}.kepub.epub`, preview: { kind: 'lazy' } };
  } else if (o.to === 'azw3') {
    const epub = await epubOf(item, o);
    const out = await runEngine(boko, 'boko', epub, { from: 'epub', to: 'azw3' });
    if (item.fromKindle) warnings.push(...item.kindleNotes);
    warnings.push('Experimental: AZW3 is for copying to a Kindle over USB. To send a book to your Kindle by email or the Send to Kindle app, use EPUB instead; Amazon converts it for you.');
    res = { blob: new Blob([out], { type: OUT.azw3.mime }), name: `${name}.azw3`, preview: { kind: 'lazy' } };
  } else if (['docx', 'odt', 'epub', 'fb2'].includes(o.to)) {
    const target = o.to === 'epub' ? 'epub3' : o.to;
    const extra = o.to === 'epub' ? { 'metadata-files': ['katlab-meta.yaml'] } : o.to === 'fb2' ? { standalone: true } : {};
    const res0 = o.to === 'epub' ? metaResource(name) : [];
    let r;
    if (item.kind === 'doc') {
      const s = await source(item);
      warnings.push(...s.warnings.slice(0, 1));
      r = await pandoc(s.md, 'markdown', target, extra, res0);
    } else {
      const s = await source(item).catch(() => null);
      if (s) warnings.push(...s.warnings.filter((w) => /Windows format/.test(w)));
      r = await pandoc(...pin(item), target, extra, res0);
    }
    if (item.kind === o.to) warnings.push(`This is already ${OUT[o.to].label} format; the file was rewritten in a clean, standard form.`);
    if (item.kind === 'text') warnings.push(...item.textNotes);
    if (o.to === 'fb2') warnings.push('FictionBook has no real lists or tables, so those are written as plain paragraphs.');
    res = { blob: new Blob([r.output], { type: OUT[o.to].mime }), name: `${name}.${o.to}`, preview: { kind: 'html', html: await htmlPreview(item) } };
  } else if (o.to === 'pdf') {
    const s = await source(item);
    warnings.push(...s.warnings);
    const pdf = await makePdf(pdfMath(flattenTables(s.md)), s.media, o, s.title);
    warnings.push(...pdf.warnings);
    res = { blob: new Blob([pdf.bytes], { type: 'application/pdf' }), name: `${name}.pdf`, preview: { kind: 'pdf', bytes: pdf.bytes } };
  }
  res.warnings = [...new Set(warnings)];
  item.results.set(key, res);
  return res;
}

function loadScript(src, test) {
  if (test()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

async function loadMd2pdf() {
  if (md2pdf) return md2pdf;
  md2pdf = (async () => {
    await loadScript('/assets/marked.min.js', () => window.marked);
    await loadScript('/assets/highlight-11.12.0.min.js', () => window.hljs);
    await loadScript('/assets/pdfmake-0.3.11.min.js', () => window.pdfMake);
    const mod = await import('/assets/md2pdf-v2.js');
    window.pdfMake.setUrlAccessPolicy((url) => url.startsWith(`${location.origin}/assets/`));
    let coverage = null;
    try {
      coverage = await (await fetch('/assets/fonts/md2pdf/coverage-v1.json')).json();
    } catch {}
    return { mod, lex: mod.createLexer(window.marked), coverage };
  })();
  md2pdf.catch(() => {
    md2pdf = null;
  });
  return md2pdf;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image could not be decoded'));
    img.src = src;
  });
}

async function prepImage(m) {
  const url = URL.createObjectURL(new Blob([m.bytes], { type: m.mime }));
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth || 1;
    const height = img.naturalHeight || 1;
    if (m.mime === 'image/svg+xml') return { svg: new TextDecoder().decode(m.bytes), width: width || 300, height: height || 150 };
    if (m.mime === 'image/png' || m.mime === 'image/jpeg') return { dataUrl: `data:${m.mime};base64,${b64(m.bytes)}`, width, height };
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d').drawImage(img, 0, 0);
    return { dataUrl: c.toDataURL('image/png'), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function makePdf(md, media, o, title) {
  const { mod, lex, coverage } = await loadMd2pdf();
  const warnings = [];
  const tokens = lex(md);
  const found = mod.collectAssets(tokens);
  const mm = mediaMap(media);
  const images = new Map();
  for (const href of found.images) {
    let key = href;
    try {
      key = decodeURIComponent(href);
    } catch {}
    const m = mm.get(normPath(key));
    if (!m || !viewable(m.mime)) continue;
    try {
      images.set(href, await prepImage(m));
    } catch {}
  }
  const t = mod.THEMES.clean;
  const opts = {
    theme: 'clean',
    body: o.pdfFont,
    code: 'jetbrains-mono',
    fontSize: 11,
    pageSize: o.pageSize,
    orientation: 'portrait',
    margin: 'normal',
    pageNumbers: true,
    toc: false,
    runningTitle: false,
    headingRule: false,
    justify: false,
    colors: { text: t.text, heading: t.heading, link: t.link, accent: t.accent, codeBg: t.codeBg },
    lineHeight: 1.42,
    title: title || mod.firstHeading(tokens) || '',
  };
  const math = new Map();
  if (found.math.length) {
    try {
      const MJ = await loadMathJax();
      for (const tex of found.math) {
        const r = texToSvg(MJ, tex, opts.colors.text);
        if (!r.error) math.set(tex, r);
      }
    } catch {
      warnings.push('The equations could not be typeset, so they are shown as TeX source.');
    }
  }
  const doc = mod.buildDocument(tokens, opts, { images, math, hljs: window.hljs, lex });
  window.pdfMake.setFonts(mod.fontFamilies(location.origin, [...new Set([opts.body, opts.code])]));
  const buffer = await window.pdfMake.createPdf(doc).getBuffer();
  if (coverage?.[opts.body]) {
    const miss = mod.missingGlyphs(md, coverage[opts.body]);
    if (miss.length) warnings.push(`These characters are not in the ${opts.body} font and print as boxes: ${miss.slice(0, 20).join(' ')}. Try another typeface.`);
  }
  return { bytes: new Uint8Array(buffer), warnings };
}

function render() {
  listEl.replaceChildren(...items.map(rowFor));
  $('all').hidden = items.filter((i) => i.result).length < 2;
  $('clearAll').hidden = !items.length;
  $('empty').hidden = items.length > 0;
}

function rowFor(item) {
  const row = el('div', { className: `frow${item === selected ? ' sel' : ''}${item.error ? ' err' : ''}` });
  row.tabIndex = 0;
  const info = el('div', { className: 'info' }, el('div', { className: 'n', textContent: item.name }), el('div', { className: 'sub2', textContent: item.error ? item.error : `${item.kindLabel || KIND_LABEL[item.kind] || ''} · ${fmtSize(item.bytes.length)}${item.status ? ` · ${item.status}` : ''}` }));
  row.append(info);
  if (item.result) {
    const btn = el('button', { className: 'btn small', type: 'button', textContent: `Download .${item.result.name.split('.').pop()}` });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      download(item.result.blob, item.result.name);
    });
    row.append(btn);
  }
  const rm = el('button', { className: 'x', type: 'button', textContent: '×', title: 'Remove' });
  rm.setAttribute('aria-label', `Remove ${item.name}`);
  rm.addEventListener('click', (e) => {
    e.stopPropagation();
    items.splice(items.indexOf(item), 1);
    if (selected === item) selected = items[0] || null;
    render();
    showPreview();
  });
  row.append(rm);
  const pick = () => {
    selected = item;
    render();
    showPreview();
  };
  row.addEventListener('click', pick);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  });
  return row;
}

let pdfjs = null;
let previewSeq = 0;

async function showPreview() {
  const my = ++previewSeq;
  const item = selected;
  const head = $('pvHead');
  const warn = $('pvWarn');
  if (!item) {
    head.textContent = 'Preview';
    warn.replaceChildren();
    previewEl.replaceChildren(el('div', { className: 'empty', textContent: 'Drop documents above to convert them. The result shows here.' }));
    return;
  }
  head.textContent = item.name;
  warn.replaceChildren(...(item.result?.warnings || []).map((w) => el('div', { className: 'warn', textContent: w })));
  if (item.error) {
    previewEl.replaceChildren(el('div', { className: 'empty bad', textContent: `Could not convert: ${item.error}` }));
    return;
  }
  if (!item.result) {
    previewEl.replaceChildren(el('div', { className: 'empty', textContent: item.status || 'Waiting…' }));
    return;
  }
  const p = item.result.preview;
  if (p.kind === 'text') {
    previewEl.replaceChildren(el('pre', { className: 'text', textContent: p.text.length > 400000 ? `${p.text.slice(0, 400000)}\n\n…` : p.text }));
  } else if (p.kind === 'html' || p.kind === 'lazy') {
    if (p.kind === 'lazy') {
      previewEl.replaceChildren(el('div', { className: 'empty', textContent: 'Loading preview…' }));
      try {
        p.html = await htmlPreview(item);
        p.kind = 'html';
      } catch (e) {
        if (my === previewSeq) previewEl.replaceChildren(el('div', { className: 'empty', textContent: `No preview available (${e.message}). The download is not affected.` }));
        return;
      }
      if (my !== previewSeq) return;
    }
    const frame = el('iframe', { className: 'doc', title: 'Document preview' });
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = p.html;
    previewEl.replaceChildren(frame);
  } else if (p.kind === 'pdf') {
    previewEl.replaceChildren(el('div', { className: 'empty', textContent: 'Rendering PDF preview…' }));
    if (!pdfjs) {
      pdfjs = await import('/assets/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.min.mjs';
    }
    const doc = await pdfjs.getDocument({ data: p.bytes.slice(0), isEvalSupported: false }).promise;
    if (my !== previewSeq) return;
    const wrap = el('div', { className: 'pages' });
    const n = Math.min(doc.numPages, 12);
    const width = Math.max(300, previewEl.clientWidth - 40);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      if (my !== previewSeq) return;
      const vp1 = page.getViewport({ scale: 1 });
      const scale = (width / vp1.width) * Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale });
      const c = el('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      wrap.append(c);
      if (i === 1) previewEl.replaceChildren(wrap);
    }
    if (doc.numPages > n) wrap.append(el('div', { className: 'empty', textContent: `${doc.numPages - n} more page${doc.numPages - n === 1 ? '' : 's'} in the download.` }));
  }
}

async function process(item) {
  const o = opts();
  item.result = null;
  item.error = null;
  item.status = `converting to ${OUT[o.to].label}…`;
  render();
  if (item === selected) showPreview();
  try {
    await kindleToEpub(item);
    const pandocFree = (item.kind === 'doc' && ['md', 'txt'].includes(o.to)) || (item.kind === 'epub' && (o.to === 'kepub' || o.to === 'azw3' || (o.to === 'epub' && item.fromKindle)));
    if (!pandocFree) await ensureWorker();
    item.result = await convert(item, o);
    item.status = item.result.note || `→ ${OUT[o.to].label}, ${fmtSize(item.result.blob.size)}`;
  } catch (e) {
    item.error = e.message || String(e);
    item.status = '';
  }
  render();
  if (item === selected) showPreview();
}

let running = Promise.resolve();

function processAll(list) {
  for (const it of list) running = running.then(() => process(it));
  return running;
}

async function addFiles(files) {
  const added = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const d = detect(bytes, f.name);
    const item = { id: nextId++, name: f.name, bytes, kind: d.kind || null, from: d.from || null, kindLabel: d.label || null, error: d.error || null, results: new Map(), result: null, status: d.error ? '' : 'queued' };
    if (d.inner) {
      try {
        item.bytes = window.fflate.unzipSync(bytes, { filter: (x) => x.name === d.inner })[d.inner];
      } catch {
        item.error = 'the FictionBook ZIP is damaged';
      }
    }
    if (item.kind === 'text') {
      const { text, enc } = decodeText(bytes);
      const { md, chapters } = textToMarkdown(text);
      item.textMd = md;
      item.textNotes = [`Plain text read as ${enc}${chapters ? `, with ${chapters} chapter heading${chapters === 1 ? '' : 's'} detected` : '; no chapter headings were detected, so it is one long section'}.`];
      if (!md.trim()) item.error = 'the text file is empty';
    }
    items.push(item);
    if (!item.error) added.push(item);
  }
  if (!selected && items.length) selected = items[items.length - files.length] || items[0];
  render();
  showPreview();
  processAll(added);
}

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function downloadAll() {
  const entries = {};
  const used = new Set();
  const unique = (n) => {
    let out = n;
    let k = 2;
    while (used.has(out.toLowerCase())) out = n.replace(/(\.[^.]+)?$/, (e) => ` (${k++})${e}`);
    used.add(out.toLowerCase());
    return out;
  };
  for (const it of items) {
    if (!it.result) continue;
    if (it.result.files) {
      const dir = unique(it.result.name.replace(/\.zip$/, ''));
      for (const [p, b] of Object.entries(it.result.files)) entries[`${dir}/${p}`] = [b, { level: 6 }];
    } else {
      const n = unique(it.result.name);
      entries[n] = [new Uint8Array(await it.result.blob.arrayBuffer()), { level: /\.(docx|odt|pdf)$/.test(n) ? 0 : 6 }];
    }
  }
  const zip = window.fflate.zipSync(entries);
  download(new Blob([zip], { type: 'application/zip' }), `converted-${OUT[opts().to].ext}.zip`);
}

function init() {
  restoreOpts();
  syncOptionRows();
  for (const id of ['to', 'mdImages', 'pageSize', 'pdfFont']) {
    $(id).addEventListener('change', () => {
      saveOpts();
      syncOptionRows();
      processAll(items.filter((i) => !i.error || i.kind));
    });
  }
  const drop = $('drop');
  const file = $('file');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  file.addEventListener('change', () => {
    if (file.files.length) addFiles([...file.files]);
    file.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });
  $('all').addEventListener('click', downloadAll);
  $('clearAll').addEventListener('click', () => {
    items.length = 0;
    selected = null;
    render();
    showPreview();
  });
  render();
  showPreview();
}

init();
