importScripts('wasm_exec.js');

const WASM_URL = new URL('kepubify.wasm', self.location.href).href;
const realPost = self.postMessage.bind(self);
const GLOBAL = 'kepubInit';

let modulePromise = null;
let current = null;

function load() {
  if (!modulePromise) {
    modulePromise = fetch(WASM_URL).then(async (r) => {
      if (!r.ok) throw new Error('kepubify.wasm: HTTP ' + r.status);
      if (WebAssembly.compileStreaming && /wasm/.test(r.headers.get('content-type') || '')) {
        return WebAssembly.compileStreaming(r);
      }
      return WebAssembly.compile(await r.arrayBuffer());
    });
    modulePromise.catch(() => { modulePromise = null; });
  }
  return modulePromise;
}

self.postMessage = function (m) {
  if (current && m && typeof m === 'object' && typeof m.type === 'string') current(m);
  else realPost.apply(self, arguments);
};

function buildConfig(o) {
  if (Array.isArray(o.config)) return o.config;
  const cfg = [];
  if (o.smartypants) cfg.push({ type: 'Smartypants' });
  if (typeof o.dummyTitlepage === 'boolean') cfg.push({ type: 'DummyTitlepage', add: o.dummyTitlepage });
  if (typeof o.hyphenate === 'boolean') cfg.push({ type: 'Hyphenate', hyphenate: o.hyphenate });
  if (o.fullScreenFixes) cfg.push({ type: 'FullScreenFixes' });
  if (typeof o.css === 'string' && o.css.trim() !== '') cfg.push({ type: 'AddCSS', css: o.css });
  if (Array.isArray(o.findReplace)) {
    for (const fr of o.findReplace) {
      if (fr && typeof fr.find === 'string' && fr.find !== '') {
        cfg.push({ type: 'FindReplace', find: fr.find, replace: String(fr.replace == null ? '' : fr.replace) });
      }
    }
  }
  return cfg;
}

function fail(id, error, fatal) {
  realPost({ id, ok: false, output: null, warnings: [], error: String(error), fatal: !!fatal });
}

async function convertOne(input, config) {
  const mod = await load();
  const go = new Go();
  const instance = await WebAssembly.instantiate(mod, go.importObject);
  go.argv = ['kepub', GLOBAL];
  globalThis[GLOBAL] = { epub: input, config, progress: false };
  const result = { output: null, error: null };
  current = (m) => {
    if (m.type === 'success') result.output = m.kepub;
    else if (m.type === 'error') result.error = m.message;
    else if (m.type === 'panic') result.error = 'kepubify panicked: ' + m.message;
  };
  try {
    await go.run(instance);
  } finally {
    current = null;
    delete globalThis[GLOBAL];
  }
  return result;
}

async function run(msg) {
  const id = msg.id;
  try {
    if (msg.op !== 'kepub') return fail(id, 'unknown op: ' + msg.op);
    if (!(msg.input instanceof ArrayBuffer)) return fail(id, 'input must be an ArrayBuffer');
    const r = await convertOne(msg.input, buildConfig(msg.options || {}));
    if (r.error) return fail(id, r.error);
    if (!r.output) return fail(id, 'kepubify produced no output');
    realPost({ id, ok: true, output: r.output, warnings: [], error: null }, [r.output]);
  } catch (e) {
    fail(id, e);
  }
}

let chain = Promise.resolve();

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'warmup') {
    load().then(
      () => realPost({ type: 'ready' }),
      (e) => realPost({ type: 'ready', error: String(e) })
    );
    return;
  }
  chain = chain.then(() => run(msg));
});
