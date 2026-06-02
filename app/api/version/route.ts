import { NextResponse } from 'next/server'

// Versions are set as Vercel env vars when you publish a new APK.
// When devices call this endpoint they get the latest version to compare against.
export async function GET() {
  return NextResponse.json({
    waiterAndroid: {
      version: process.env.WAITER_ANDROID_VERSION ?? '1.0.3',
      downloadUrl: process.env.WAITER_ANDROID_APK_URL ?? '',
    },
    ownerAndroid: {
      version: process.env.OWNER_ANDROID_VERSION ?? '1.0.0',
      downloadUrl: process.env.OWNER_ANDROID_APK_URL ?? '',
    },
  })
}
