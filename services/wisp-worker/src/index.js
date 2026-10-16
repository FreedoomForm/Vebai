/**
 * Vebai WISP v1 relay — Cloudflare Worker.
 *
 * A self-hosted replacement for third-party WISP relays: gives the in-browser
 * v86 VM real TCP (and DNS-over-UDP) networking through a WebSocket.
 *
 * Spec: https://github.com/MercuryWorkshop/wisp-protocol/blob/main/protocol.md
 *   packet = [type u8][streamId u32 LE][payload]
 *   0x01 CONNECT (u8 streamType, u16 port LE, hostname)  0x01 TCP / 0x02 UDP
 *   0x02 DATA (raw)   0x03 CONTINUE (u32 remaining LE)   0x04 CLOSE (u8 reason)
 *   server must send CONTINUE(streamId=0) right after the WS handshake.
 *
 * TCP streams use cloudflare:sockets connect(). UDP is answered for DNS
 * (port 53) via DNS-over-HTTPS; other UDP gets CLOSE(0x48 blocked).
 *
 * Deploy: cd services/wisp-worker && npx wrangler deploy
 * Then set NEXT_PUBLIC_WISP_URL=wss://<worker-host>/ in Vercel env.
 */

import { connect } from 'cloudflare:sockets'

const BUFFER_WINDOW = 0x10000 // per-stream flow-control window
const DNS_DOH = 'https://cloudflare-dns.com/dns-query'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** binary helpers */
function pack(type, streamId, payload = new Uint8Array(0)) {
  const out = new Uint8Array(5 + payload.length)
  const dv = new DataView(out.buffer)
  dv.setUint8(0, type)
  dv.setUint32(1, streamId, true)
  out.set(payload, 5)
  return out
}

class FrameReader {
  push(chunk) { /* one WS message == one WISP packet; nothing to buffer */ }
  frames(chunk) {
    if (chunk.length < 5) return []
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const type = dv.getUint8(0)
    const id = dv.getUint32(1, true)
    return [{ type, id, payload: chunk.slice(5) }]
  }
}

export default {
  // Cron trigger: 24/7 pinger for the Vercel agent worker. GitHub Actions
  // cron proved unreliable (1 scheduled run ever), so the always-on delivery
  // of finished Kaggle jobs rides on this schedule instead. Every 5 minutes:
  // /api/agent/tick -> agentTick() -> syncStudio() -> pick up clips + merges.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch('https://vebai-six.vercel.app/api/agent/tick')
        .then((r) => r.text())
        .catch(() => {}),
    )
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (!url.pathname.endsWith('/')) {
      return new Response('wisp relay: connect to /', { status: 404 })
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('vebai wisp relay (v1). WebSocket only.\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    if (env.WISP_SECRET) {
      const got = url.searchParams.get('secret') || request.headers.get('x-wisp-secret') || ''
      if (got !== env.WISP_SECRET) return new Response('forbidden', { status: 403 })
    }

    const pair = new WebSocketPair()
    const server = pair[1]
    server.accept()

    /** per-stream state */
    const streams = new Map() // id -> {writer, credit, socket, dns}

    const wsSend = (u8) => {
      try {
        server.send(u8)
      } catch { /* closing */ }
    }

    const sendContinue = (id, n) => wsSend(pack(0x03, id, new Uint8Array(new Uint32Array([n]).buffer)))
    const closeStream = (id, reason) => {
      wsSend(pack(0x04, id, new Uint8Array([reason])))
      const st = streams.get(id)
      if (st) {
        try { st.writer?.close() } catch { /* noop */ }
        try { st.socket?.close() } catch { /* noop */ }
        streams.delete(id)
      }
    }

    /** pipe a TCP socket reader into DATA frames (with CONTINUE credits) */
    const pipeSocketToWs = (id, socketReader) => {
      ctx.waitUntil(
        (async () => {
          try {
            while (true) {
              const { value, done } = await socketReader.read()
              if (done) break
              wsSend(pack(0x02, id, value))
            }
            closeStream(id, 0x02) // voluntary closure
          } catch {
            closeStream(id, 0x03) // network error
          }
        })(),
      )
    }

    const handleConnect = async (id, payload) => {
      if (payload.length < 4) return closeStream(id, 0x41)
      const streamType = payload[0]
      const port = (payload[1] | (payload[2] << 8))
      const host = dec.decode(payload.slice(3)).replace(/\0.*$/, '').trim()
      if (!host || !port) return closeStream(id, 0x41)

      try {
        if (streamType === 0x01) {
          // ---- TCP
          if (port === 25) return closeStream(id, 0x48) // no smtp on CF
          const socket = connect({ hostname: host, port })
          const writer = socket.writable.getWriter()
          streams.set(id, { socket, writer, credit: BUFFER_WINDOW })
          const ok = await socket.opened.then(() => true, () => false)
          if (!ok) return closeStream(id, 0x42)
          pipeSocketToWs(id, socket.readable.getReader())
          sendContinue(id, BUFFER_WINDOW)
        } else if (streamType === 0x02) {
          // ---- UDP: only DNS (53) via DoH, everything else blocked
          if (port !== 53) return closeStream(id, 0x48)
          streams.set(id, { udp: true, dns: true, credit: BUFFER_WINDOW })
          sendContinue(id, BUFFER_WINDOW)
        } else {
          closeStream(id, 0x41)
        }
      } catch (e) {
        closeStream(id, e && String(e).includes('timed out') ? 0x43 : 0x42)
      }
    }

    const handleData = async (id, payload) => {
      const st = streams.get(id)
      if (!st) return
      if (st.dns) {
        // UDP/DNS: forward the raw DNS message to DoH and stream the answer
        try {
          const resp = await fetch(DNS_DOH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/dns-message' },
            body: payload,
          })
          const ans = new Uint8Array(await resp.arrayBuffer())
          wsSend(pack(0x02, id, ans))
        } catch {
          closeStream(id, 0x03)
        }
        return
      }
      if (st.credit <= 0) return // silently drop over-credit data
      st.credit--
      try {
        await st.writer.write(payload)
      } catch {
        closeStream(id, 0x03)
      }
    }

    // spec: the server sends CONTINUE(streamId=0) immediately after handshake
    sendContinue(0, BUFFER_WINDOW)

    server.addEventListener('message', (ev) => {
      if (!(ev.data instanceof ArrayBuffer) && !(ev.data instanceof Uint8Array)) return
      const chunk = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data)
      if (chunk.length < 5) return
      const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      const type = dv.getUint8(0)
      const id = dv.getUint32(1, true)
      const payload = chunk.slice(5)
      if (type === 0x01) void handleConnect(id, payload)
      else if (type === 0x02) void handleData(id, payload)
      else if (type === 0x04) closeStream(id, 0x02)
    })

    server.addEventListener('close', () => {
      for (const id of [...streams.keys()]) closeStream(id, 0x02)
    })

    return new Response(null, { status: 101, webSocket: pair[0] })
  },
}
