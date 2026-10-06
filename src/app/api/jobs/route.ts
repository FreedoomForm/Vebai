import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { syncStudio, prepFrameData } from '@/lib/studio'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Prisma Bytes (Uint8Array<ArrayBuffer>) from a Node Buffer */
function toBytes(b: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b) // copy -> fresh ArrayBuffer, satisfies Prisma Bytes
}

export async function GET() {
  const state = await syncStudio()
  const jobs = await db.job.findMany({
    orderBy: { createdAt: 'desc' },
    take: 60,
    select: {
      id: true, prompt: true, seconds: true, status: true, batchId: true,
      shotNum: true, error: true, testMode: true, createdAt: true, updatedAt: true,
    },
  })
  return NextResponse.json({ state, jobs })
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const prompt = String(form.get('prompt') || '').trim()
    if (!prompt)
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
    const seconds = [5, 10].includes(Number(form.get('seconds')))
      ? Number(form.get('seconds'))
      : 5
    const testMode = String(form.get('testMode') || '') === 'true'

    let frameOrig: Buffer | null = null
    const file = form.get('frame')
    if (file && file instanceof File && file.size > 0) {
      frameOrig = Buffer.from(await file.arrayBuffer())
    }

    // prep the 864x480 H3 canvas right away when a frame was uploaded
    const prepped = await prepFrameData(frameOrig)
    const job = await db.job.create({
      data: {
        prompt,
        seconds,
        frameOrigData: frameOrig ? toBytes(frameOrig) : null,
        framePrepped: toBytes(prepped),
        testMode,
      },
    })

    return NextResponse.json({ job: { ...job, frameOrigData: undefined, framePrepped: undefined } })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed to create job' },
      { status: 500 },
    )
  }
}
