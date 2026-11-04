const XHTML = 'http://www.w3.org/1999/xhtml';
const FONT_SIZE = { 1: '0.63em', 2: '0.82em', 3: '1em', 4: '1.13em', 5: '1.5em', 6: '2em', 7: '3em' };
const KEEP_DIMENSIONS = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'embed', 'object', 'col', 'colgroup', 'td', 'th', 'table']);
const TABLE_DIMENSIONS = new Set(['td', 'th', 'table', 'col', 'colgroup']);

function cssLength(v) {
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return `${s}px`;
  if (/^-?\d+(\.\d+)?(em|ex|px|pt|%|rem|cm|mm|in|pc)$/i.test(s)) return s;
  return null;
}

function addStyle(el, decl) {
  const cur = (el.getAttribute('style') || '').trim();
  el.setAttribute('style', cur ? `${cur.replace(/;?\s*$/, ';')} ${decl}` : decl);
}

function fixElement(el) {
  const tag = el.localName.toLowerCase();
  if (el.hasAttribute('align') && tag !== 'img') {
    const a = el.getAttribute('align').toLowerCase();
    el.removeAttribute('align');
    if (['left', 'right', 'center', 'justify'].includes(a)) addStyle(el, `text-align: ${a};`);
  } else if (el.hasAttribute('align') && tag === 'img') {
    const a = el.getAttribute('align').toLowerCase();
    el.removeAttribute('align');
    if (a === 'left' || a === 'right') addStyle(el, `float: ${a};`);
    else if (a === 'middle' || a === 'top' || a === 'bottom') addStyle(el, `vertical-align: ${a === 'middle' ? 'middle' : a};`);
  }
  if (!KEEP_DIMENSIONS.has(tag)) {
    if (el.hasAttribute('height')) {
      const v = cssLength(el.getAttribute('height'));
      el.removeAttribute('height');
      if (v && !/^0(px|pt|em)?$/.test(v)) addStyle(el, `margin-top: ${v};`);
    }
    if (el.hasAttribute('width')) {
      const v = cssLength(el.getAttribute('width'));
      el.removeAttribute('width');
      if (v && !/^0(px|pt|em)?$/.test(v)) addStyle(el, `text-indent: ${v};`);
    }
  } else if (TABLE_DIMENSIONS.has(tag)) {
    for (const k of ['width', 'height']) {
      if (!el.hasAttribute(k) || (tag === 'table' && k === 'width')) continue;
      const v = cssLength(el.getAttribute(k));
      el.removeAttribute(k);
      if (v) addStyle(el, `${k}: ${v};`);
    }
    if (tag === 'table' && el.hasAttribute('width')) {
      const v = cssLength(el.getAttribute('width'));
      el.removeAttribute('width');
      if (v) addStyle(el, `width: ${v};`);
    }
  }
  for (const k of ['bgcolor', 'valign', 'nowrap', 'vspace', 'hspace', 'clear']) {
    if (!el.hasAttribute(k)) continue;
    const v = el.getAttribute(k);
    el.removeAttribute(k);
    if (k === 'bgcolor') addStyle(el, `background-color: ${v};`);
    else if (k === 'valign') addStyle(el, `vertical-align: ${v};`);
    else if (k === 'nowrap') addStyle(el, 'white-space: nowrap;');
    else if (k === 'clear' && tag === 'br') addStyle(el, `clear: ${v === 'all' ? 'both' : v};`);
  }
}

function replaceTag(doc, el, tag, styles) {
  const n = doc.createElementNS(XHTML, tag);
  for (const a of [...el.attributes]) if (!['size', 'face', 'color'].includes(a.name)) n.setAttribute(a.name, a.value);
  for (const s of styles) addStyle(n, s);
  while (el.firstChild) n.appendChild(el.firstChild);
  el.parentNode.replaceChild(n, el);
  return n;
}

function fixFont(doc, el) {
  const styles = [];
  const size = el.getAttribute('size');
  if (size) {
    const m = size.trim().match(/^([+-]?)(\d)$/);
    if (m) {
      const n = Math.max(1, Math.min(7, m[1] === '+' ? 3 + Number(m[2]) : m[1] === '-' ? 3 - Number(m[2]) : Number(m[2])));
      styles.push(`font-size: ${FONT_SIZE[n]};`);
    }
  }
  if (el.getAttribute('color')) styles.push(`color: ${el.getAttribute('color')};`);
  if (el.getAttribute('face')) styles.push(`font-family: ${el.getAttribute('face')};`);
  replaceTag(doc, el, 'span', styles);
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

function resolve(base, href) {
  const parts = (dirOf(base) + href).split('/');
  const out = [];
  for (const s of parts) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
}

function relative(from, to) {
  const a = dirOf(from).split('/').filter(Boolean);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return '../'.repeat(a.length - i) + b.slice(i).join('/');
}

function parseXhtml(src) {
  const text = src.replace(/<\/?mbp:[^>]*>/gi, '');
  const xml = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (!xml.getElementsByTagName('parsererror').length) return xml;
  const html = new DOMParser().parseFromString(text.replace(/^<\?xml[^>]*\?>\s*/, ''), 'text/html');
  const ser = new XMLSerializer();
  const head = [...html.head.childNodes].map((n) => ser.serializeToString(n)).join('');
  const body = [...html.body.childNodes].map((n) => ser.serializeToString(n)).join('');
  const rebuilt = `<html xmlns="${XHTML}"><head>${head}</head><body>${body}</body></html>`.replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"(?=[^>]*>)/g, (m, off) => (off < 20 ? m : ''));
  const again = new DOMParser().parseFromString(rebuilt, 'application/xhtml+xml');
  return again.getElementsByTagName('parsererror').length ? null : again;
}

export function tidyKindleEpub(bytes, fflate) {
  const files = fflate.unzipSync(bytes);
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const notes = [];
  const container = files['META-INF/container.xml'] ? dec.decode(files['META-INF/container.xml']) : '';
  const opfPath = container.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath || !files[opfPath]) return { bytes, notes: ['the book structure could not be tidied'] };
  const opfDoc = new DOMParser().parseFromString(dec.decode(files[opfPath]), 'application/xml');
  if (opfDoc.getElementsByTagName('parsererror').length) return { bytes, notes: ['the book structure could not be tidied'] };
  const title = opfDoc.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || 'Chapter';
  const items = [...opfDoc.getElementsByTagNameNS('*', 'item')];
  const docs = new Map();
  let fixedAttrs = 0;
  for (const it of items) {
    const mt = it.getAttribute('media-type') || '';
    const path = resolve(opfPath, it.getAttribute('href') || '');
    if (mt === 'text/css' && files[path]) {
      const css = dec.decode(files[path]);
      if (/<svg[\s>]/i.test(css) || /^\s*</.test(css)) {
        delete files[path];
        it.parentNode.removeChild(it);
        notes.push('removed a broken style sheet');
      }
      continue;
    }
    if (mt !== 'application/xhtml+xml' || !files[path]) continue;
    const doc = parseXhtml(dec.decode(files[path]));
    if (!doc) continue;
    docs.set(path, doc);
  }
  const ids = new Map();
  for (const [path, doc] of docs) {
    for (const g of [...doc.getElementsByTagNameNS('*', 'guide')]) g.parentNode.removeChild(g);
    for (const l of [...doc.getElementsByTagNameNS(XHTML, 'link')]) {
      const href = l.getAttribute('href');
      if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !files[resolve(path, href.split('#')[0])]) l.parentNode.removeChild(l);
    }
    for (const tag of ['img', 'embed', 'object', 'iframe']) {
      for (const e of [...doc.getElementsByTagNameNS(XHTML, tag)]) {
        const src = e.getAttribute(tag === 'object' ? 'data' : 'src');
        if (src && /\.css$/i.test(src.split('#')[0])) e.parentNode.removeChild(e);
      }
    }
    const head = doc.getElementsByTagNameNS(XHTML, 'head')[0];
    if (head && !doc.getElementsByTagNameNS(XHTML, 'title').length) {
      const t = doc.createElementNS(XHTML, 'title');
      t.textContent = title;
      head.insertBefore(t, head.firstChild);
    }
    for (const f of [...doc.getElementsByTagNameNS(XHTML, 'font')]) {
      fixFont(doc, f);
      fixedAttrs++;
    }
    for (const el of [...doc.getElementsByTagNameNS(XHTML, '*')]) {
      const before = el.attributes.length;
      fixElement(el);
      if (el.attributes.length !== before) fixedAttrs++;
    }
    const set = new Set();
    for (const el of doc.getElementsByTagNameNS('*', '*')) if (el.getAttribute('id')) set.add(el.getAttribute('id'));
    ids.set(path, set);
  }
  const fixHref = (fromPath, href) => {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
    const hash = href.indexOf('#');
    const file = hash < 0 ? href : href.slice(0, hash);
    const frag = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
    const target = file ? resolve(fromPath, file) : fromPath;
    if (!frag) return href;
    if (ids.get(target)?.has(frag)) return href;
    for (const [p, set] of ids) if (set.has(frag)) return `${relative(fromPath, p)}#${encodeURIComponent(frag)}`;
    return file || relative(fromPath, target);
  };
  let fixedLinks = 0;
  for (const [path, doc] of docs) {
    for (const a of doc.getElementsByTagNameNS(XHTML, 'a')) {
      const h = a.getAttribute('href');
      const n = fixHref(path, h);
      if (n !== h) {
        a.setAttribute('href', n);
        fixedLinks++;
      }
    }
    files[path] = enc.encode(`<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n${new XMLSerializer().serializeToString(doc.documentElement)}`);
  }
  for (const it of items) {
    const mt = it.getAttribute('media-type') || '';
    const path = resolve(opfPath, it.getAttribute('href') || '');
    if (!files[path]) continue;
    if (mt === 'application/x-dtbncx+xml') {
      const ncx = new DOMParser().parseFromString(dec.decode(files[path]), 'application/xml');
      if (ncx.getElementsByTagName('parsererror').length) continue;
      for (const c of ncx.getElementsByTagNameNS('*', 'content')) {
        const h = c.getAttribute('src');
        const n = fixHref(path, h);
        if (n !== h) {
          c.setAttribute('src', n);
          fixedLinks++;
        }
      }
      files[path] = enc.encode(`<?xml version="1.0" encoding="utf-8"?>\n${new XMLSerializer().serializeToString(ncx.documentElement)}`);
    }
  }
  files[opfPath] = enc.encode(`<?xml version="1.0" encoding="utf-8"?>\n${new XMLSerializer().serializeToString(opfDoc.documentElement)}`);
  if (fixedAttrs) notes.push(`old Kindle formatting on ${fixedAttrs} element${fixedAttrs === 1 ? '' : 's'} was turned into standard CSS`);
  if (fixedLinks) notes.push(`${fixedLinks} broken internal link${fixedLinks === 1 ? ' was' : 's were'} repaired`);
  const out = { mimetype: [enc.encode('application/epub+zip'), { level: 0 }] };
  for (const [k, v] of Object.entries(files)) if (k !== 'mimetype') out[k] = [v, { level: /\.(jpe?g|png|gif|webp|woff2?|otf|ttf)$/i.test(k) ? 0 : 6 }];
  return { bytes: fflate.zipSync(out), notes };
}
