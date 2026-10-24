# Cenacle mobile app

A [Capacitor](https://capacitorjs.com) app for Android and iOS. It opens on a pairing page:
people enter their organization's Cenacle server address, the app checks that it answers as
Cenacle (`/api/meta`) and then opens that server's web app, as the desktop app does. Sign-in,
data and updates come from the server; the app holds only the list of recent servers.

Status: a working scaffold. Push notifications, deep links, switching servers from inside the
app and store releases come with the mobile release (v1.2).

## Build an Android debug APK

Needs JDK 21 and the Android SDK command-line tools (platform 36, build-tools 35).

```sh
export JAVA_HOME=/opt/jdk-21 ANDROID_HOME=/opt/android-sdk
pnpm --filter @cenacle/mobile android:debug
# → mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Install it with `adb install app-debug.apk` or by opening the file on the phone. Debug builds
are signed with the Android debug key and are for testing only.

## iOS

`mobile/ios` is the Xcode project (Swift Package Manager, no CocoaPods). It builds on macOS
with Xcode: `pnpm --filter @cenacle/mobile sync`, then open `mobile/ios/App/App.xcodeproj`.

## Icons, splash screens and version

`pnpm --filter @cenacle/mobile assets` renders the launcher icons and splash screens from
`web/public/brand` and sets the version from `package.json` (versionCode =
major·10⁶ + minor·10³ + patch). Run it when the logo or the version changes and commit the
results.
