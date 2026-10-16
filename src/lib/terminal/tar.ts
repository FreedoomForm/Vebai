/**
 * Minimal POSIX ustar reader for the terminal file-sync uploads.
 * The guest sends `tar czf - <files>`; we gunzip and read 512-byte headers.
 */

export interface TarEntry {
  path: string
  size: number
  data: Buffer
}

function parseOctal(s: string): number {
  s = s.replace(/\0/g, '').trim()
  if (!s) return 0
  return parseInt(s, 8) || 0
}

/** decompress and parse a tar(.gz) buffer; supports plain tar too */
export function parseTarGz(input: Buffer): TarEntry[] {
  let buf = input
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    // gzip magic — use zlib
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zlib = require('node:zlib') as typeof import('node:zlib')
    buf = zlib.gunzipSync(buf)
  }
  const out: TarEntry[] = []
  let off = 0
  let longName: string | null = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseOctal(header.subarray(124, 136).toString('utf8'))
    const typeflag = String.fromCharCode(header[156] || 0x30)
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    off += 512
    const data = buf.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512

    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    let path = longName ?? (prefix ? `${prefix}/${name}` : name)
    longName = null
    path = path.replace(/^\.\//, '').replace(/\/+$/, '')
    if (!path || path === 'pax_global_header') continue
    if (typeflag !== '0' && typeflag !== '\0') continue // skip dirs/links
    out.push({ path, size, data: Buffer.from(data) })
  }
  return out
}
