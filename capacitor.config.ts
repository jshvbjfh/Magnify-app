import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.magnify.restaurant',
  appName: 'Magnify',
  // Point the WebView at the live Vercel deployment.
  // When you push code to Vercel the app updates automatically — no APK rebuild needed.
  server: {
    url: 'https://magnify-app-tau.vercel.app',
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
