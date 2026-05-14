# Google Play Release

## What ships to Android

- Android package name: `com.magnify.restaurant`
- App name: `Magnify`
- Current version: `1.0.5` (`versionCode 6`)
- Play upload artifact: `android/app/build/outputs/bundle/release/app-release.aab`
- Runtime web source: `https://magnify-app-tau.vercel.app`

Because the Capacitor app loads the live web app from Vercel, a Play Store rollout should only happen after the matching Vercel production deploy is live.

## Build the signed App Bundle

From the repo root:

```powershell
npm run android:bundle
```

Expected output:

```text
android/app/build/outputs/bundle/release/app-release.aab
```

## Pre-upload checks

1. Deploy the current web build to Vercel production.
2. Confirm the Android app opens the expected production site.
3. Verify login, reports, ordering, camera/photo flows, and file upload on a physical device.
4. Confirm the app version in Android matches the intended Play release.
5. Keep the existing signing key safe. Future updates must use the same key.

## Play Console assets you still need

1. App description: short and full description.
2. Graphics: app icon, feature graphic, phone screenshots, and tablet screenshots if you want tablet support listed.
3. Privacy policy URL.
4. Data safety disclosure.
5. App access instructions if reviewers need a login.
6. Content rating questionnaire.

## Permissions to disclose

The Android manifest currently requests:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `CAMERA`
- `READ_MEDIA_IMAGES`
- `READ_EXTERNAL_STORAGE` on Android 12 and below

That means the Play listing and privacy policy should explain why camera and image access are needed.

## Recommended rollout path

1. Upload the `.aab` to an Internal testing track.
2. Verify install, update, login, and core restaurant workflows on a tester device.
3. Promote to Closed testing if needed.
4. Release to Production after tester approval.

## Versioning for the next release

Before the next Play upload:

1. Increase `versionCode` in `android/app/build.gradle`.
2. Increase `versionName` in `android/app/build.gradle`.
3. Keep `package.json` version aligned with the Android release version.