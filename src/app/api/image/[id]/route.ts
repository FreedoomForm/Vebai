import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** GET /api/image/[taskId] — serves a completed image task's PNG from the DB */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const task = await db.agentTask.findUnique({
    where: { id },
    select: { type: true, imageData: true },
  })
  if (!task || task.type !== 'image' || !task.imageData)
    return NextResponse.json({ error: 'image task not found' }, { status: 404 })

  return new NextResponse(new Uint8Array(task.imageData), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
