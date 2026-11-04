import init, { convert } from './boko.js';

let ready = null;

function load() {
  if (!ready) {
    ready = init({ module_or_path: new URL('./boko_bg.wasm', import.meta.url) });
  }
  return ready;
}

function fail(id, error, fatal) {
  self.postMessage({ id, ok: false, output: null, warnings: [], error: String(error), fatal: !!fatal });
}

let chain = Promise.resolve();

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'warmup') {
    load().then(
      () => self.postMessage({ type: 'ready' }),
      (e) => self.postMessage({ type: 'ready', error: String(e) })
    );
    return;
  }
  chain = chain.then(() => run(msg));
};

async function run(msg) {
  const id = msg.id;
  try {
    if (msg.op !== 'boko') {
      fail(id, 'unknown op: ' + msg.op);
      return;
    }
    const o = msg.options || {};
    if (!o.from || !o.to) {
      fail(id, 'options.from and options.to are required');
      return;
    }
    if (!(msg.input instanceof ArrayBuffer)) {
      fail(id, 'input must be an ArrayBuffer');
      return;
    }
    await load();
    let out;
    try {
      out = convert(new Uint8Array(msg.input), String(o.from), String(o.to));
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        fail(id, 'converter crashed on this file: ' + e.message, true);
        self.close();
        return;
      }
      fail(id, e);
      return;
    }
    const buf = out.buffer.byteLength === out.byteLength ? out.buffer : out.slice().buffer;
    self.postMessage({ id, ok: true, output: buf, warnings: [], error: null }, [buf]);
  } catch (e) {
    fail(id, e);
  }
}
