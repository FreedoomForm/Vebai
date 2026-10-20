/**
 * BrowserTerminal — the client engine behind /terminal.
 *
 * Boots a real Alpine Linux in the browser tab via v86 (BSD-2-Clause),
 * talks to it over the serial console rendered into xterm.js, executes
 * the queued TerminalCommands from Neon and snapshots the whole VM to
 * IndexedDB so the workspace survives reloads.
 *
 * Everything runs client-side; the server only stores state (sessions,
 * command queue, file manifests) — Vercel never executes VM commands.
 */

/* interface definitions */

export interface EngineCallbacks {
  onStatus: (stage: 'idle' | 'booting' | 'login' | 'ready' | 'busy' | 'error', detail?: string) => void
  onQueue: (pending: number) => void
  onNotice: (text: string) => void
}

interface PendingCommand {
  id: string
  command: string
  source: string
}

const IDB_NAME = 'vebai-terminal'
const SNAPSHOT_KEY_PREFIX = 'vbterm-state:'

function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbGet(key: string): Promise<ArrayBuffer | null> {
  const db = await idbOpen()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readonly')
    const req = tx.objectStore('kv').get(key)
    req.onsuccess = () => resolve((req.result as ArrayBuffer) || null)
    req.onerror = () => resolve(null)
  })
}

async function idbPut(key: string, value: ArrayBuffer): Promise<boolean> {
  const db = await idbOpen()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(value, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

let libv86Promise: Promise<void> | null = null
function loadLibv86(): Promise<void> {
  if ((window as any).V86) return Promise.resolve()
  if (libv86Promise) return libv86Promise
  libv86Promise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/v86/libv86.js'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('не удалось загрузить libv86.js'))
    document.head.appendChild(s)
  })
  return libv86Promise
}

export class BrowserTerminal {
  private cb: EngineCallbacks
  private sid: string
  private secret: string
  private origin: string
  private ramMb: number
  private wispUrl: string

  private emu: any = null
  private term: any // xterm Terminal
  private sendSerial: ((d: string) => void) | null = null

  private stage: 'idle' | 'booting' | 'login' | 'ready' | 'busy' | 'error' = 'idle'
  private serialTail = ''
  private byteBuf: number[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private lastUserInput = 0
  private paused = false
  private busy = false
  private destroyed = false

  private queueTimer: ReturnType<typeof setInterval> | null = null
  private beatTimer: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setInterval> | null = null

  private netOk = false
  private bootDoneSetup = false
  private restoredSnapshot = false

  constructor(opts: {
    sid: string
    secret: string
    origin: string
    ramMb?: number
    wispUrl?: string
    term: any
    callbacks: EngineCallbacks
  }) {
    this.sid = opts.sid
    this.secret = opts.secret
    this.origin = opts.origin.replace(/\/$/, '')
    this.ramMb = opts.ramMb || 1024
    this.wispUrl = opts.wispUrl || ''
    this.term = opts.term
    this.cb = opts.callbacks
  }

  private setStatus(stage: typeof this.stage, detail?: string) {
    this.stage = stage
    this.cb.onStatus(stage, detail)
  }

  /* ------------------------------------------------------------ serial I/O */

  private handleSerialByte = (b: number) => {
    this.byteBuf.push(b)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        const chunk = new Uint8Array(this.byteBuf)
        this.byteBuf = []
        // decode as utf-8 per chunk; serial console is utf-8
        let text = ''
        try {
          const full = new Uint8Array([...chunk])
          text = new TextDecoder('utf-8', { fatal: false }).decode(full)
        } catch {
          text = String.fromCharCode(...chunk)
        }
        if (!text) return
        this.term.write(text)
        this.serialTail = (this.serialTail + text).slice(-3000)
        this.commandMachine()
      }, 15)
    }
  }

  private send(d: string) {
    if (this.sendSerial) this.sendSerial(d)
  }

  /* --------------------------------------------------------- login machine */

  private loginPoll: ReturnType<typeof setInterval> | null = null

  private startLoginPoll() {
    if (this.loginPoll) return
    let step = 0 // 0: wait login:, 1: wait shell prompt, 2: wait V8# prompt
    this.loginPoll = setInterval(() => {
      if (this.destroyed || this.stage === 'error') {
        if (this.loginPoll) clearInterval(this.loginPoll)
        this.loginPoll = null
        return
      }
      if (step === 0 && /login:/i.test(this.serialTail)) {
        step = 1
        this.send('root\n')
        this.serialTail = ''
        this.setStatus('login', 'вхожу как root…')
      } else if (step === 1 && /:~#/.test(this.serialTail)) {
        step = 2
        this.send("export PS1='V8# '\nstty cols 500 rows 100\n")
        this.serialTail = ''
      } else if (step === 2 && /V8# /.test(this.serialTail)) {
        if (this.loginPoll) clearInterval(this.loginPoll)
        this.loginPoll = null
        this.afterReady()
      }
    }, 500)
  }

  private afterReady() {
    if (this.bootDoneSetup || this.destroyed) return
    this.bootDoneSetup = true
    this.stage = 'ready'
    this.setStatus('ready')
    this.cb.onNotice(this.restoredSnapshot ? 'Сессия восстановлена из снапшота' : 'Linux загружен и готов')
    void this.bootstrapGuest()
  }

  /* --------------------------------------------------------------- booting */

  async start() {
    this.setStatus('booting')
    try {
      await loadLibv86()
    } catch (e) {
      this.setStatus('error', e instanceof Error ? e.message : 'libv86 load failed')
      return
    }

    const snapshot = await idbGet(SNAPSHOT_KEY_PREFIX + this.sid)
    const cdrom = { url: '/v86/alpine-virt.iso', async: true, size: 48_234_496 }

    const config: Record<string, unknown> = {
      wasm_path: '/v86/v86.wasm',
      memory_size: this.ramMb * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
      bios: { url: '/v86/seabios.bin' },
      vga_bios: { url: '/v86/vgabios.bin' },
      cdrom,
      autostart: true,
      disable_speaker: true,
      // v86's browser build requires a structured screen container (text div
      // + canvas) or the CPU loop stalls silently; we keep it hidden — the
      // user-facing console is the SERIAL terminal rendered into xterm.
      screen: { container: this.hiddenScreenContainer() },
    }
    if (this.wispUrl) config.network_relay_url = this.wispUrl

    if (snapshot) {
      this.restoredSnapshot = true
      config.initial_state = { buffer: snapshot }
      this.cb.onNotice('Восстанавливаю VM из снапшота…')
    } else {
      config.bzimage = { url: '/v86/vmlinuz-virt' }
      config.initrd = { url: '/v86/initramfs-virt' }
      config.cmdline = 'modules=loop,squashfs,sd-mod,usb-storage console=ttyS0,115200'
    }

    try {
      this.emu = new (window as any).V86(config)
    } catch (e) {
      this.setStatus('error', e instanceof Error ? e.message : 'v86 init failed')
      return
    }
    ;(window as any).__vbtEmu = this.emu
    for (const ev of ['emulator-loaded', 'emulator-ready', 'emulator-started']) {
      this.emu.add_listener(ev, () => this.cb.onNotice(`v86: ${ev}`))
    }
    // debug: keep the last VGA text chars around for headless diagnostics
    ;(window as any).__vbtScreenTail = ''
    this.emu.add_listener('screen-put-char', (...args: number[]) => {
      const chr = args[2]
      const c = chr >= 32 && chr < 127 ? String.fromCharCode(chr) : ''
      if (c) (window as any).__vbtScreenTail = ((window as any).__vbtScreenTail + c).slice(-200)
    })

    this.emu.add_listener('serial0-output-byte', this.handleSerialByte)
    this.sendSerial = (d: string) => this.emu.serial0_send(d)

    // user typing goes straight to the guest
    this.term.onData((d: string) => {
      this.lastUserInput = Date.now()
      if (this.stage !== 'error') this.send(d)
    })

    this.emu.add_listener('download-error', (e: any) => {
      this.setStatus('error', `загрузка образа не удалась: ${e?.request?.status || ''} ${e?.file_name || ''}`)
    })

    this.setStatus('login', snapshot ? 'снапшот загружен, проверяю шелл…' : 'жду загрузку системы…')
    this.stage = 'login'

    if (snapshot) {
      // snapshot keeps the shell; wake it and check the prompt is alive
      setTimeout(() => {
        if (this.stage === 'ready') return
        this.send('\n')
      }, 3000)
      setTimeout(() => {
        if (this.stage === 'ready') return
        if (/V8# /.test(this.serialTail) || /:~#/.test(this.serialTail)) {
          this.restoredSnapshot = this.hasExportedPrompt()
          this.afterReady()
        } else {
          this.restoredSnapshot = false
          this.cb.onNotice('Снапшот не содержит живого шелла — перезагружаюсь заново')
          void this.restartFresh()
        }
      }, 7000)
    }

    this.startLoginPoll()
    this.startTimers()
  }

  private hasExportedPrompt(): boolean {
    return /V8# /.test(this.serialTail)
  }

  /** snapshot turned out to be dead: drop it and boot from scratch */
  private async restartFresh() {
    try {
      const db = await idbOpen()
      if (db) {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').delete(SNAPSHOT_KEY_PREFIX + this.sid)
      }
    } catch { /* ignore */ }
    try {
      this.emu?.destroy()
    } catch { /* noop */ }
    this.emu = null
    this.bootDoneSetup = false
    this.loginPoll = null
    if (this.queueTimer) { clearInterval(this.queueTimer); this.queueTimer = null }
    if (this.beatTimer) { clearInterval(this.beatTimer); this.beatTimer = null }
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null }
    this.term.reset()
    this.term.writeln('\x1b[33mПересоздаю VM (снапшот был повреждён)…\x1b[0m')
    await this.start()
  }

  private hiddenScreenContainer(): HTMLElement {
    // exact structure v86's ScreenAdapter expects (see v86 basic.html):
    // container -> [text_screen div, canvas]
    const div = document.createElement('div')
    div.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    const text = document.createElement('div')
    text.style.cssText = 'white-space:pre;font:14px monospace;line-height:14px'
    const canvas = document.createElement('canvas')
    canvas.style.display = 'none'
    div.appendChild(text)
    div.appendChild(canvas)
    document.body.appendChild(div)
    return div
  }

  /* ---------------------------------------------------------- guest setup */

  /** check network, restore files into an empty workspace, start sync daemon */
  private async bootstrapGuest() {
    setTimeout(() => {
      this.send("wget -q --spider -T 8 http://9.9.9.9/ 2>/dev/null; if wget -q --spider -T 8 https://one.one.one.one 2>/dev/null; then touch /tmp/.vnet; else rm -f /tmp/.vnet; fi\n")
      setTimeout(() => {
        this.netOk = this.stage === 'ready'
        const probeCmd =
          "if [ -f /tmp/.vnet ]; then echo VEBAINET_OK; else echo VEBAINET_NO; fi"
        this.send(probeCmd + '\n')
        setTimeout(() => {
          this.netOk = /VEBAINET_OK/.test(this.serialTail)
          if (!this.netOk) {
            this.cb.onNotice('Сеть VM недоступна (WISP relay не настроен?) — синхронизация файлов выключена, команды работают локально')
            return
          }
          // install the sync daemon (idempotent)
          this.send(
            `wget -qO- "${this.origin}/api/terminal/guest/init.sh" | sh -s "${this.origin}" "${this.sid}" "${this.secret}"\n`,
          )
          // restore files only into an empty workspace
          setTimeout(() => {
            this.send(
              `test -z "$(ls -A /root/workspace 2>/dev/null)" && wget -qO- "${this.origin}/api/terminal/guest/restore.sh" | sh -s "${this.origin}" "${this.sid}" "${this.secret}"\n`,
            )
          }, 4000)
        }, 6000)
      }, 9000)
    }, 1500)
  }

  /* ----------------------------------------------------------- timers */

  private startTimers() {
    this.queueTimer = setInterval(() => void this.queueTick(), 3000)
    this.beatTimer = setInterval(() => void this.heartbeat(), 30_000)
    this.saveTimer = setInterval(() => void this.saveSnapshot(), 120_000)
    window.addEventListener('pagehide', this.onHide)
    document.addEventListener('visibilitychange', this.onHide)
    void this.heartbeat()
  }

  private onHide = (ev?: Event) => {
    if (document.visibilityState === 'hidden' || ev?.type === 'pagehide') {
      void this.saveSnapshot()
    }
  }

  async heartbeat() {
    if (this.destroyed) return
    try {
      const res = await fetch(`/api/terminal/sessions/${this.sid}/heartbeat`, { method: 'POST' })
      if (res.ok) {
        const j = (await res.json()) as { pending?: number }
        this.cb.onQueue(j.pending || 0)
      }
    } catch { /* offline tab */ }
  }

  async saveSnapshot() {
    // never snapshot a half-booted/dead VM — restore would wedge the session
    if (this.destroyed || !this.emu || this.busy || this.stage !== 'ready') return
    try {
      const state = await this.emu.save_state()
      const ok = await idbPut(SNAPSHOT_KEY_PREFIX + this.sid, state)
      if (ok) this.cb.onNotice('Снапшот сохранён (' + Math.round(state.byteLength / 1048576) + ' МБ)')
      else this.cb.onNotice('Снапшот не влез в хранилище браузера')
    } catch { /* emulator busy */ }
  }

  destroy() {
    this.destroyed = true
    if (this.queueTimer) clearInterval(this.queueTimer)
    if (this.beatTimer) clearInterval(this.beatTimer)
    if (this.saveTimer) clearInterval(this.saveTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    window.removeEventListener('pagehide', this.onHide)
    try { void this.emu?.destroy() } catch { /* noop */ }
  }

  setPaused(p: boolean) {
    this.paused = p
  }

  /* --------------------------------------------------------- command queue */

  private execResolve: ((r: { done: boolean; exit: number; output: string }) => void) | null = null

  private async queueTick() {
    if (this.destroyed || this.busy || this.paused || this.stage !== 'ready') return
    // don't fight the user for the keyboard
    if (Date.now() - this.lastUserInput < 8000) return
    try {
      const res = await fetch(`/api/terminal/sessions/${this.sid}/commands?status=pending&limit=1`)
      if (!res.ok) return
      const j = (await res.json()) as { commands: PendingCommand[] }
      this.cb.onQueue(j.commands.length)
      const cmd = j.commands[0]
      if (cmd) await this.runCommand(cmd)
    } catch { /* network hiccup */ }
  }

  private commandMachine() {
    // resolves the current exec when the DONE marker shows up
    if (!this.execResolve) return
    const m = /V8D_(\d+):V8E/.exec(this.serialTail)
    if (m) {
      const exit = parseInt(m[1], 10)
      const output = this.extractOutput()
      const resolve = this.execResolve
      this.execResolve = null
      resolve({ done: true, exit, output })
    }
  }

  private execStartText = ''

  private extractOutput(): string {
    // take the serial tail since the command was sent, strip the echo and
    // the marker line, collapse CR artifacts
    let raw = this.serialTail.slice(-4000)
    const markerIdx = raw.search(/V8D_\d+:V8E/)
    if (markerIdx >= 0) raw = raw.slice(0, markerIdx)
    const cmdIdx = raw.indexOf(this.execStartText.slice(0, Math.min(48, this.execStartText.length)))
    if (cmdIdx >= 0) raw = raw.slice(cmdIdx + Math.min(48, this.execStartText.length))
    return raw
      .replace(/\r/g, '')
      .split('\n')
      .filter((l) => l.trim() !== 'echo V8D_$?:V8E' && l.trim() !== 'V8# ' && !/^V8# /.test(l.trim()))
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '') || '(ok)'
  }

  private async runCommand(cmd: PendingCommand) {
    if (this.stage !== 'ready') return
    this.busy = true
    this.setStatus('busy', cmd.command.slice(0, 60))
    this.execStartText = cmd.command
    this.serialTail = ''

    await fetch(`/api/terminal/sessions/${this.sid}/commands/${cmd.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    }).catch(() => {})

    const result = await new Promise<{ done: boolean; exit: number; output: string }>((resolve) => {
      this.execResolve = resolve
      this.send(cmd.command + '\n')
      this.send('echo V8D_$?:V8E\n')
      setTimeout(() => {
        if (this.execResolve === resolve) {
          this.execResolve = null
          resolve({ done: false, exit: 124, output: this.extractOutput() })
        }
      }, 240_000)
    })

    if (result.done) {
      await fetch(`/api/terminal/sessions/${this.sid}/commands/${cmd.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', output: result.output, exitCode: result.exit }),
      }).catch(() => {})
    } else {
      this.cb.onNotice('Команда не уложилась в 240с — частичный вывод записан, процесс отправлен Ctrl+C')
      await fetch(`/api/terminal/sessions/${this.sid}/commands/${cmd.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          output: result.output + '\n(таймаут 240с; процессу отправлен Ctrl+C)',
          exitCode: 124,
        }),
      }).catch(() => {})
      this.send('\u0003') // Ctrl+C — вернуть шелл в порядок
    }

    this.busy = false
    this.execStartText = ''
    this.setStatus('ready')
  }
}
