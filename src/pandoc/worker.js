import {convertDocument, init} from "./engine.js"

const progress = (loaded, total) => self.postMessage({type: "progress", loaded, total})

self.onmessage = async ev => {
    const msg = ev.data
    if (msg && msg.type === "warmup") {
        try {
            await init(msg.baseUrl, progress)
            self.postMessage({type: "ready"})
        } catch (e) {
            self.postMessage({type: "ready", error: String(e && e.message ? e.message : e)})
        }
        return
    }
    await init(msg.baseUrl, progress).catch(() => {})
    const res = await convertDocument(msg, msg.baseUrl)
    const transfer = res.media.map(m => m.data)
    if (res.output instanceof ArrayBuffer) transfer.push(res.output)
    self.postMessage(res, transfer)
}
