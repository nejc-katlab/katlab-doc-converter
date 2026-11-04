export class EbookWorker {
  constructor(url, opts) {
    this.url = url;
    this.type = (opts && opts.type) || 'classic';
    this.baseTimeoutMs = (opts && opts.baseTimeoutMs) || 30000;
    this.msPerMiB = (opts && opts.msPerMiB) || 8000;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.warm = null;
  }

  start() {
    if (this.worker) return this.worker;
    const w = new Worker(this.url, { type: this.type });
    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'ready') {
        if (this.warm) {
          const { resolve, reject } = this.warm;
          this.warm = null;
          if (m.error) reject(new Error(m.error));
          else resolve();
        }
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.fatal) this.reset();
      p.resolve(m);
    };
    w.onerror = (ev) => {
      ev.preventDefault && ev.preventDefault();
      this.failAll('worker error: ' + (ev.message || 'unknown'));
      this.reset();
    };
    this.worker = w;
    return w;
  }

  reset() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  failAll(error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ id, ok: false, output: null, warnings: [], error });
    }
    this.pending.clear();
    if (this.warm) {
      this.warm.reject(new Error(error));
      this.warm = null;
    }
  }

  warmup() {
    const w = this.start();
    return new Promise((resolve, reject) => {
      this.warm = { resolve, reject };
      w.postMessage({ type: 'warmup' });
    });
  }

  convert(op, input, options, timeoutMs) {
    const w = this.start();
    const id = this.nextId++;
    const limit = timeoutMs || this.baseTimeoutMs + (input.byteLength / 1048576) * this.msPerMiB;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failAll('conversion timed out after ' + Math.round(limit / 1000) + ' s; the file may be damaged or too large');
        this.reset();
        resolve({ id, ok: false, output: null, warnings: [], error: 'conversion timed out after ' + Math.round(limit / 1000) + ' s; the file may be damaged or too large' });
      }, limit);
      this.pending.set(id, { resolve, timer });
      w.postMessage({ id, op, input, options }, [input]);
    });
  }
}
