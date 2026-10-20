import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** streams a finished job video from the DB with Range support so <video> can seek */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const job = await db.job.findUnique({
    where: { id },
    select: { videoData: true },
  })
  if (!job?.videoData)
    return NextResponse.json({ error: 'video not found' }, { status: 404 })

  const buf = Buffer.from(job.videoData)
  const size = buf.byteLength
  const range = _req.headers.get('range')
  const headersBase = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  }

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    const start = m && m[1] ? parseInt(m[1], 10) : 0
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    if (start >= size || start > end)
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    const chunk = buf.subarray(start, end + 1)
    return new NextResponse(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...headersBase,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    })
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: { ...headersBase, 'Content-Length': String(size) },
  })
}
