const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const NOSTREAM = 0xffffffff;
const MAXSEC = 0xfffffffa;
const MAX_STREAM = 256 * 1024 * 1024;
const MAX_CHARS = 64 * 1024 * 1024;
const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

const COMPRESSED = new Map([[0x82, 0x201a], [0x83, 0x192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x2c6], [0x89, 0x2030],
  [0x8a, 0x160], [0x8b, 0x2039], [0x8c, 0x152], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013],
  [0x97, 0x2014], [0x98, 0x2dc], [0x99, 0x2122], [0x9a, 0x161], [0x9b, 0x203a], [0x9c, 0x153], [0x9f, 0x178]]);

const u16 = (b, o) => (o >= 0 && o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
const u32 = (b, o) => (o >= 0 && o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);

function readCfb(b, warnings) {
  if (b.length < 512) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null;
  const sh = u16(b, 0x1e), msh = u16(b, 0x20);
  if ((sh !== 9 && sh !== 12) || msh !== 6) return null;
  const ss = 1 << sh, ms = 1 << msh, per = ss >> 2;
  const nFat = u32(b, 0x2c), dir0 = u32(b, 0x30), cutoff = u32(b, 0x38) || 4096;
  const mf0 = u32(b, 0x3c), nMf = u32(b, 0x40), df0 = u32(b, 0x44), nDf = u32(b, 0x48);
  const maxSec = Math.floor(b.length / ss);
  const secOff = (s) => (s + 1) * ss;
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const s = u32(b, 0x4c + i * 4);
    if (s >= MAXSEC) break;
    fatSecs.push(s);
  }
  let df = df0, guard = 0;
  while (df < MAXSEC && fatSecs.length < nFat && guard++ < nDf + 1 && guard < 100000) {
    const o = secOff(df);
    if (o + ss > b.length) { warnings.push('DIFAT sector beyond end of file'); break; }
    for (let i = 0; i < per - 1 && fatSecs.length < nFat; i++) {
      const s = u32(b, o + i * 4);
      if (s < MAXSEC) fatSecs.push(s);
    }
    df = u32(b, o + ss - 4);
  }
  if (fatSecs.length < nFat) warnings.push('FAT is incomplete (file truncated or damaged)');
  const fat = new Uint32Array(fatSecs.length * per).fill(NOSTREAM);
  fatSecs.forEach((s, k) => {
    const o = secOff(s);
    if (o + ss <= b.length) for (let i = 0; i < per; i++) fat[k * per + i] = u32(b, o + i * 4);
  });
  const chain = (start, table) => {
    const out = [], seen = new Set();
    for (let s = start; s < table.length && s < MAXSEC && !seen.has(s); s = table[s]) { seen.add(s); out.push(s); }
    return out;
  };
  const readChain = (start, size) => {
    const secs = chain(start, fat);
    const want = Math.min(size == null ? secs.length * ss : size, secs.length * ss, MAX_STREAM);
    const out = new Uint8Array(want);
    let o = 0;
    for (const s of secs) {
      const p = secOff(s), n = Math.min(ss, want - o, b.length - p);
      if (n <= 0) break;
      out.set(b.subarray(p, p + n), o);
      o += n;
    }
    return o < want ? out.subarray(0, o) : out;
  };
  const dir = readChain(dir0);
  const ents = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = u16(dir, o + 64);
    let name = '';
    if (nl >= 2 && nl <= 64) for (let i = 0; i + 2 < nl; i += 2) name += String.fromCharCode(u16(dir, o + i));
    ents.push({ name, type: dir[o + 66], left: u32(dir, o + 68), right: u32(dir, o + 72), child: u32(dir, o + 76), start: u32(dir, o + 116), size: u32(dir, o + 120) });
  }
  if (!ents.length || ents[0].type !== 5) return null;
  const mini = readChain(ents[0].start, ents[0].size);
  const mfBytes = readChain(mf0, Math.min(nMf, 1 << 20) * ss);
  const minifat = new Uint32Array(mfBytes.length >> 2);
  for (let i = 0; i < minifat.length; i++) minifat[i] = u32(mfBytes, i * 4);
  const streams = new Map(), seen = new Set(), stack = [ents[0].child];
  while (stack.length) {
    const k = stack.pop();
    if (k >= ents.length || seen.has(k)) continue;
    seen.add(k);
    const e = ents[k];
    stack.push(e.left, e.right);
    if (e.type === 2 && !streams.has(e.name.toLowerCase())) streams.set(e.name.toLowerCase(), e);
  }
  const get = (name) => {
    const e = streams.get(name.toLowerCase());
    if (!e) return null;
    if (e.size >= cutoff) return readChain(e.start, e.size);
    const secs = chain(e.start, minifat), out = new Uint8Array(Math.min(e.size, secs.length * ms));
    let o = 0;
    for (const s of secs) {
      const p = s * ms, n = Math.min(ms, out.length - o, mini.length - p);
      if (n <= 0) break;
      out.set(mini.subarray(p, p + n), o);
      o += n;
    }
    return o < out.length ? out.subarray(0, o) : out;
  };
  return { get, has: (n) => streams.has(n.toLowerCase()) };
}

function readUtf16(b, o, chars) {
  let s = '';
  for (let i = 0; i < chars && o + i * 2 + 2 <= b.length; i++) s += String.fromCharCode(b[o + i * 2] | (b[o + i * 2 + 1] << 8));
  return s;
}

function decode8(b, cp) {
  if (cp === 65001) return new TextDecoder('utf-8').decode(b);
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    s += String.fromCharCode(c >= 0x80 && c < 0xa0 ? CP1252[c - 0x80] : c);
  }
  return s;
}

function readMeta(cfb) {
  const meta = {};
  try {
    const b = cfb.get('\x05SummaryInformation');
    if (!b || b.length < 48) return meta;
    const off = u32(b, 44);
    const base = off;
    const nProps = Math.min(u32(b, base + 4), 64);
    let cp = 1252;
    const props = {};
    for (let i = 0; i < nProps; i++) props[u32(b, base + 8 + i * 8)] = base + u32(b, base + 12 + i * 8);
    if (props[1] != null && u16(b, props[1]) === 2) cp = u16(b, props[1] + 4);
    const str = (o) => {
      const t = u16(b, o);
      const n = u32(b, o + 4);
      if (n > b.length) return undefined;
      let s;
      if (t === 0x1e) {
        let e = o + 8 + n;
        s = decode8(b.subarray(o + 8, Math.min(e, b.length)), cp === 1200 ? 1252 : cp);
      } else if (t === 0x1f) s = readUtf16(b, o + 8, n);
      else return undefined;
      s = s.replace(/\0+$/, '').trim();
      return s || undefined;
    };
    if (props[2] != null) { const t = str(props[2]); if (t) meta.title = t; }
    if (props[4] != null) { const a = str(props[4]); if (a) meta.author = a; }
  } catch (e) {}
  return meta;
}

function parsePieces(wd, tbl, fcClx, lcbClx, warnings) {
  const pieces = [];
  let p = fcClx;
  const end = Math.min(fcClx + lcbClx, tbl.length);
  while (p < end) {
    const t = tbl[p];
    if (t === 1) { p += 3 + u16(tbl, p + 1); continue; }
    if (t !== 2) { warnings.push('Unexpected Clx entry; text may be incomplete'); return pieces; }
    const lcb = u32(tbl, p + 1);
    const n = Math.floor((lcb - 4) / 12);
    const cpBase = p + 5, pcdBase = cpBase + (n + 1) * 4;
    if (pcdBase + n * 8 > tbl.length) { warnings.push('Piece table is truncated'); }
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const cpS = u32(tbl, cpBase + i * 4), cpE = u32(tbl, cpBase + i * 4 + 4);
      const po = pcdBase + i * 8;
      if (po + 8 > tbl.length) break;
      if (cpE < cpS || cpS < prev) { warnings.push('Piece table is not monotonic'); break; }
      prev = cpE;
      const fcRaw = u32(tbl, po + 2);
      const comp = (fcRaw & 0x40000000) !== 0;
      const fc = comp ? (fcRaw & 0x3fffffff) >>> 1 : fcRaw & 0x3fffffff;
      pieces.push({ cpS, cpE, fc, comp });
    }
    return pieces;
  }
  return pieces;
}

function parseStyles(tbl, fc, lcb) {
  const sti = [];
  try {
    if (!lcb || fc >= tbl.length) return sti;
    const end = Math.min(fc + lcb, tbl.length);
    const cbStshi = u16(tbl, fc);
    const cstd = u16(tbl, fc + 2);
    let p = fc + 2 + cbStshi;
    for (let i = 0; i < cstd && p + 2 <= end; i++) {
      const cb = u16(tbl, p);
      sti[i] = cb >= 2 ? u16(tbl, p + 2) & 0xfff : -1;
      p += 2 + cb;
    }
  } catch (e) {}
  return sti;
}

function sprmSize(b, p, end, op) {
  const spra = op >> 13;
  switch (spra) {
    case 0: case 1: return 1;
    case 2: case 4: case 5: return 2;
    case 3: return 4;
    case 7: return 3;
    default:
      if (p >= end) return -1;
      if (op === 0xc615 && b[p] === 255) return -1;
      return 1 + b[p];
  }
}

function parsePapx(wd, tbl, fc, lcb, warnings) {
  const starts = [], ends = [], flags = [], istds = [];
  const n = Math.floor((lcb - 4) / 8);
  if (n <= 0) return null;
  const pn0 = fc + (n + 1) * 4;
  for (let i = 0; i < n; i++) {
    const pn = u32(tbl, pn0 + i * 4) & 0x3fffff;
    const o = pn * 512;
    if (o + 512 > wd.length) continue;
    const crun = wd[o + 511];
    const bx0 = o + (crun + 1) * 4;
    for (let k = 0; k < crun; k++) {
      const s = u32(wd, o + k * 4), e = u32(wd, o + k * 4 + 4);
      let f = 0, ist = 0;
      const boff = wd[bx0 + k * 13] * 2;
      if (boff > 0 && o + boff < o + 511) {
        let cb = wd[o + boff], q = o + boff + 1;
        if (cb === 0) { cb = wd[q] * 2; q++; } else cb = cb * 2 - 1;
        const pend = Math.min(q + cb, o + 511);
        if (cb >= 2) {
          ist = u16(wd, q);
          let sp = q + 2;
          while (sp + 2 <= pend) {
            const op = u16(wd, sp);
            sp += 2;
            const sz = sprmSize(wd, sp, pend, op);
            if (sz < 0) break;
            const v = wd[sp];
            if (op === 0x2416 || op === 0x2417) { if (v & 1) f |= op === 0x2417 ? 3 : 1; }
            else if (op === 0x244b) { if (v & 1) f |= 4; }
            else if (op === 0x244c) { if (v & 1) f |= 12; }
            sp += sz;
          }
        }
      }
      if (e > s) { starts.push(s); ends.push(e); flags.push(f); istds.push(ist); }
    }
  }
  if (!starts.length) return null;
  const idx = starts.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
  const S = idx.map((i) => starts[i]), E = idx.map((i) => ends[i]), F = idx.map((i) => flags[i]), I = idx.map((i) => istds[i]);
  return {
    at(fcv) {
      let lo = 0, hi = S.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (fcv < S[m]) hi = m - 1;
        else if (fcv >= E[m]) lo = m + 1;
        else return { f: F[m], istd: I[m] };
      }
      return null;
    },
  };
}

export function readDoc(input) {
  const result = { paragraphs: [], encrypted: false, warnings: [], meta: {} };
  const warnings = result.warnings;
  try {
    let b;
    if (input instanceof Uint8Array) b = input;
    else if (ArrayBuffer.isView(input)) b = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (input instanceof ArrayBuffer || (input && typeof input.byteLength === 'number' && typeof input.slice === 'function')) b = new Uint8Array(input);
    else { warnings.push('Input is not an ArrayBuffer'); return result; }
    const cfb = readCfb(b, warnings);
    if (!cfb) { warnings.push('Not an OLE2 compound file (not a .doc file, or damaged)'); return result; }
    result.meta = readMeta(cfb);
    const wd = cfb.get('WordDocument');
    if (!wd) { warnings.push('No WordDocument stream found'); return result; }
    if (wd.length < 0x40) { warnings.push('WordDocument stream is too short'); return result; }
    const wIdent = u16(wd, 0), nFib = u16(wd, 2), fl = u16(wd, 10);
    if (wIdent !== 0xa5ec) {
      warnings.push('Unsupported Word version (wIdent 0x' + wIdent.toString(16) + '); this is not a Word 97-2003 file');
      return result;
    }
    if (fl & 0x100) {
      result.encrypted = true;
      warnings.push('The document is encrypted or password protected');
      return result;
    }
    if (nFib < 101 || nFib < 0xc1) return readLegacy(wd, nFib, fl, result);
    const csw = u16(wd, 32), cslwO = 34 + csw * 2, cslw = u16(wd, cslwO), lwO = cslwO + 2;
    if (cslw < 4) { warnings.push('FIB is too short'); return result; }
    const ccpText = u32(wd, lwO + 12), ccpFtn = u32(wd, lwO + 16);
    const fbO = lwO + cslw * 4, cbRg = u16(wd, fbO), fb = fbO + 2;
    if (cbRg < 34) { warnings.push('FIB has no Clx entry'); return result; }
    const pair = (i) => [u32(wd, fb + i * 8), u32(wd, fb + i * 8 + 4)];
    const [fcClx, lcbClx] = pair(33);
    const tblName = fl & 0x200 ? '1Table' : '0Table';
    let tbl = cfb.get(tblName);
    if (!tbl) {
      tbl = cfb.get(fl & 0x200 ? '0Table' : '1Table');
      if (tbl) warnings.push('Expected table stream ' + tblName + ' is missing; used the other one');
    }
    if (!tbl) { warnings.push('Table stream is missing'); return result; }
    if (!lcbClx || fcClx >= tbl.length) { warnings.push('Clx is missing or outside the table stream'); return result; }
    const pieces = parsePieces(wd, tbl, fcClx, lcbClx, warnings);
    if (!pieces.length) { warnings.push('No text pieces found'); return result; }
    let papx = null;
    try {
      const [fcP, lcbP] = pair(13);
      if (lcbP >= 12 && fcP + lcbP <= tbl.length) papx = parsePapx(wd, tbl, fcP, lcbP, warnings);
    } catch (e) {}
    if (!papx) warnings.push('Paragraph properties could not be read; table structure is guessed and headings are not detected');
    let stis = [];
    if (papx) { const [fcS, lcbS] = pair(1); stis = parseStyles(tbl, fcS, lcbS); }
    const total = Math.min(ccpText, MAX_CHARS);
    const mainEnd = pieces[pieces.length - 1].cpE;
    if (total > mainEnd) warnings.push('Document text is shorter than the header says (truncated file?)');
    extract(wd, pieces, Math.min(total, mainEnd), papx, stis, result);
    if (ccpFtn > 0) warnings.push('Footnotes/endnotes, headers, footers and comments are not included');
  } catch (e) {
    warnings.push('Unexpected error while reading the file: ' + (e && e.message ? e.message : String(e)));
  }
  return result;
}

function extract(wd, pieces, total, papx, stis, result) {
  const out = result.paragraphs;
  const warnings = result.warnings;
  let cur = '', cellParts = [], nested = false, fieldDepthWarn = false;
  const fields = [];
  const dropping = () => {
    for (let i = 0; i < fields.length; i++) if (fields[i] === 0) return true;
    return false;
  };
  const emit = (text, kind) => { out.push({ text, kind }); };
  const endMark = (ch, fc) => {
    const info = papx ? papx.at(fc) : null;
    let f = info ? info.f : 0;
    const text = cur;
    cur = '';
    if (!papx && ch === 7) {
      if (text === '' && cellParts.length === 0 && out.length && out[out.length - 1].kind === 'cell') { emit('', 'rowEnd'); return; }
      emit(text, 'cell');
      return;
    }
    if (f & 4) nested = true;
    if (f & 10) { emit('', 'rowEnd'); cellParts = []; return; }
    if (ch === 7 || f & 4) {
      cellParts.push(text);
      emit(cellParts.join('\n'), 'cell');
      cellParts = [];
      return;
    }
    if (f & 1) { cellParts.push(text); return; }
    let kind = 'p';
    if (info && stis.length) {
      const s = stis[info.istd];
      if (s >= 1 && s <= 3) kind = 'h' + s;
    }
    emit(text, kind);
  };
  let cpPos = 0;
  for (const pc of pieces) {
    if (cpPos >= total) break;
    const s = Math.max(pc.cpS, cpPos), e = Math.min(pc.cpE, total);
    for (let cp = s; cp < e; cp++) {
      const fc = pc.comp ? pc.fc + (cp - pc.cpS) : pc.fc + (cp - pc.cpS) * 2;
      let c;
      if (pc.comp) {
        if (fc >= wd.length) { cpPos = total; break; }
        c = wd[fc];
        if (c >= 0x82 && c <= 0x9f) c = COMPRESSED.get(c) || c;
      } else {
        if (fc + 2 > wd.length) { cpPos = total; break; }
        c = wd[fc] | (wd[fc + 1] << 8);
      }
      if (c === 13 || c === 7) { endMark(c, fc); continue; }
      if (c === 0x13) { if (fields.length < 64) fields.push(0); else if (!fieldDepthWarn) { fieldDepthWarn = true; warnings.push('Fields nested too deeply'); } continue; }
      if (c === 0x14) { if (fields.length) fields[fields.length - 1] = 1; continue; }
      if (c === 0x15) { fields.pop(); continue; }
      if (dropping()) continue;
      if (c === 0x0b) cur += '\n';
      else if (c === 0x0c) { if (cur) { emit(cur, 'p'); cur = ''; } }
      else if (c === 0x1e) cur += '‑';
      else if (c === 0x09 || c >= 0x20) cur += String.fromCharCode(c);
    }
    cpPos = Math.max(cpPos, e);
  }
  if (cellParts.length) { emit(cellParts.join('\n') + (cur ? '\n' + cur : ''), 'cell'); cur = ''; }
  else if (cur) emit(cur, 'p');
  if (nested) warnings.push('Nested tables are flattened into the outer table');
}

function readLegacy(wd, nFib, fl, result) {
  const w = result.warnings;
  w.push('Legacy Word 6/95 file (nFib ' + nFib + '): read as plain text only; tables and styles are not recovered');
  const fcMin = u32(wd, 0x18), fcMac = u32(wd, 0x1c), ccp = u32(wd, 0x34);
  if (fl & 4) {
    w.push('Word 6/95 file with a piece table is not supported; text may be missing');
  }
  if (fcMin < 0x40 || fcMin >= wd.length) { w.push('Invalid text start offset'); return result; }
  const wide = (fl & 0x1000) !== 0;
  const end = Math.min(fcMac > fcMin ? fcMac : fcMin + ccp * (wide ? 2 : 1), fcMin + ccp * (wide ? 2 : 1), wd.length);
  if (end <= fcMin) return result;
  let cur = '';
  const out = result.paragraphs;
  const step = wide ? 2 : 1;
  for (let i = fcMin; i + step <= end; i += step) {
    let c = wide ? wd[i] | (wd[i + 1] << 8) : wd[i];
    if (c === 13 || c === 7) { out.push({ text: cur, kind: 'p' }); cur = ''; continue; }
    if (!wide && c >= 0x80 && c < 0xa0) c = CP1252[c - 0x80];
    if (c === 0x0b) cur += '\n';
    else if (c === 0x1e) cur += '\u2011';
    else if (c === 9 || c >= 0x20) cur += String.fromCharCode(c);
  }
  if (cur) out.push({ text: cur, kind: 'p' });
  return result;
}

export function docToText(result) {
  const lines = [];
  let row = [];
  for (const p of (result && result.paragraphs) || []) {
    if (p.kind === 'cell') row.push(p.text.replace(/\n/g, ' '));
    else if (p.kind === 'rowEnd') { lines.push(row.join('\t')); row = []; }
    else {
      if (row.length) { lines.push(row.join('\t')); row = []; }
      lines.push(p.text);
    }
  }
  if (row.length) lines.push(row.join('\t'));
  return lines.join('\n');
}

function esc(s, cell) {
  s = s.replace(/ /g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');
  if (cell) s = s.replace(/\|/g, '\\|');
  return s;
}

function escLine(s) {
  return s.replace(/^(\s*)([#+-]|\d+[.)])(\s|$)/, (m, a, b, c) => a + (/\d/.test(b[0]) ? b.slice(0, -1) + '\\' + b.slice(-1) : '\\' + b) + c);
}

export function docToMarkdown(result) {
  const blocks = [];
  const ps = (result && result.paragraphs) || [];
  let i = 0;
  while (i < ps.length) {
    const p = ps[i];
    if (p.kind === 'cell' || p.kind === 'rowEnd') {
      const rows = [];
      let row = [];
      while (i < ps.length && (ps[i].kind === 'cell' || ps[i].kind === 'rowEnd')) {
        if (ps[i].kind === 'cell') row.push(ps[i].text);
        else { rows.push(row); row = []; }
        i++;
      }
      if (row.length) rows.push(row);
      const cols = rows.length ? rows[0].length : 0;
      const ok = cols > 0 && rows.every((r) => r.length === cols);
      const cellMd = (t) => esc(t.trim(), true).replace(/\n/g, '<br>');
      if (ok) {
        const lines = ['| ' + rows[0].map(cellMd).join(' | ') + ' |', '| ' + rows[0].map(() => '---').join(' | ') + ' |'];
        for (let r = 1; r < rows.length; r++) lines.push('| ' + rows[r].map(cellMd).join(' | ') + ' |');
        blocks.push(lines.join('\n'));
      } else if (rows.length) {
        blocks.push(rows.map((r) => r.map((t) => esc(t.trim()).replace(/\n/g, ' ')).join(' | ')).join('  \n'));
      }
      continue;
    }
    i++;
    const t = p.text.trim();
    if (!t) continue;
    const m = esc(t).split('\n').map((l) => l.trim()).join('  \n');
    if (p.kind && p.kind[0] === 'h' && p.kind.length === 2) blocks.push('#'.repeat(+p.kind[1]) + ' ' + m.replace(/\s*\n\s*/g, ' '));
    else blocks.push(escLine(m));
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}
