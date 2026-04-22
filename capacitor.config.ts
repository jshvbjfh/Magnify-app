import type { CapacitorConfig } from '@capacitor/cli'

const configuredAppUrl = process.env.CAPACITOR_SERVER_URL?.trim()
  || process.env.NEXT_PUBLIC_APP_URL?.trim()
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  || 'https://magnify-app-tau.vercel.app'

const appUrl = configuredAppUrl.replace(/\/$/, '')

const config: CapacitorConfig = {
  appId: 'com.magnify.restaurant',
  appName: 'Magnify',
  // Point the WebView at the live deployment so content updates come from Vercel
  // without requiring a fresh Android build for every web-only change.
  server: {
    url: appUrl,
    cleartext: false,
  },
  // webDir is still required by Capacitor even in remote-URL mode
  webDir: 'out',
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#111827', // gray-900 — matches sidebar colour
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#111827',
    },
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false, // set true when debugging on device
  },
}

export default config
