import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import path from 'node:path'

import { authOptions } from '@/lib/auth'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) {
    return NextResponse.json({ error: 'No active restaurant branch found.' }, { status: 400 })
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Image storage is not configured.' }, { status: 503 })
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No image file provided.' }, { status: 400 })
    }

    if (!file.type.startsWith('image/')) {
      return NextResponse.json({ error: 'File must be an image.' }, { status: 400 })
    }

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image must be under 10MB.' }, { status: 400 })
    }

    const extension = path.extname(file.name) || '.jpg'
    const filename = `qr-menu-${context.branchId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`

    const { put } = await import('@vercel/blob')
    const blob = await put(`qr-menu/${filename}`, file, {
      access: 'public',
      contentType: file.type,
    })

    return NextResponse.json({ ok: true, path: blob.url, filename })
  } catch (error) {
    console.error('[restaurant/qr-menu-image] upload failed', error)
    return NextResponse.json({ error: 'Upload failed.' }, { status: 500 })
  }
}
