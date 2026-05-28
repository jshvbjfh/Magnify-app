import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import path from 'node:path'

import { authOptions } from '@/lib/auth'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) {
    return NextResponse.json({ error: 'No active restaurant branch found.' }, { status: 400 })
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
      return NextResponse.json({ error: 'File size must be less than 10MB.' }, { status: 400 })
    }

    const extension = path.extname(file.name) || '.jpg'
    const filename = `qr-menu-${context.branchId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`

    // Use Vercel Blob when the token is available (production/Vercel),
    // fall back to base64 data URL on Vercel without Blob (ephemeral fs can't persist),
    // and local filesystem for Electron / local dev.
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = await import('@vercel/blob')
      const blob = await put(`qr-menu/${filename}`, file, {
        access: 'public',
        contentType: file.type,
      })
      return NextResponse.json({ ok: true, path: blob.url, filename })
    }

    const bytes = await file.arrayBuffer()

    // On Vercel without Blob token the filesystem is ephemeral — encode to base64
    // data URL so the image is stored directly in the database and always accessible.
    if (process.env.VERCEL) {
      const base64 = Buffer.from(bytes).toString('base64')
      const dataUrl = `data:${file.type};base64,${base64}`
      return NextResponse.json({ ok: true, path: dataUrl, filename })
    }

    // Local filesystem fallback (Electron / dev without Vercel Blob)
    const { mkdir, writeFile } = await import('node:fs/promises')
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'qr-menu')
    await mkdir(uploadDir, { recursive: true })
    const filePath = path.join(uploadDir, filename)
    await writeFile(filePath, Buffer.from(bytes))
    return NextResponse.json({ ok: true, path: `/uploads/qr-menu/${filename}`, filename })
  } catch (error) {
    console.error('[restaurant/qr-menu-image] upload failed', error)
    return NextResponse.json({ error: 'Upload failed.' }, { status: 500 })
  }
}
