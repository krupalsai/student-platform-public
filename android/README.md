# Student Platform — native Android shell

Wraps the live production site (`capacitor.config.ts`'s `server.url`) in a
real Android app via Capacitor. Every existing page — registration, payments,
admin console, Batch Discussion — works exactly as deployed on Vercel, with
zero app-store update needed for an ordinary web change.

The two things this native shell adds are what a browser genuinely cannot do:

1. **Real FCM push tokens** (`src/lib/hooks` on the web side registers via
   `@capacitor/push-notifications`, not the Web Push VAPID subscriptions the
   PWA uses).
2. **A full-screen incoming-call screen** that can wake the device and ring
   even while the app is fully closed —
   `app/src/main/java/com/studentplatform/app/IncomingCallMessagingService.kt`
   + `IncomingCallActivity.kt`. This is the actual reason a native app exists;
   Web Push alone couldn't do this.

## What's already done, verified in THIS environment

- `./gradlew assembleDebug` succeeds — a real, installable debug APK builds
  cleanly (confirmed, not assumed).
- `tsc --noEmit`, `next lint`, `next build` all clean on the web side changes
  (`/api/push/register-native`, `src/lib/push/native-fcm.ts`,
  `NativeCallBridge.tsx`, `NativePushRegistrar.tsx`).
- `native_push_tokens` table applied to prod (service_role only, same
  GRANT-not-just-RLS convention as every other table in this repo).

## What is NOT done, and cannot be from this environment

1. **No Firebase project exists yet.** Without one:
   - `google-services.json` is missing, so `app/build.gradle`'s own
     conditional skip means the `google-services` Gradle plugin never
     applies — the app still builds (confirmed), but Firebase has no real
     project id to initialize against at runtime, so push tokens will not
     actually register on a real device yet.
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (server env var, Vercel) doesn't exist,
     so `sendNativeCallPush()` silently no-ops (fails open, same posture as
     every other optional external integration in this repo — Gemini/Groq
     vision, Bank SMS, etc.).

   **To finish this**: create a Firebase project (console.firebase.google.com,
   free), add an Android app with package name `com.studentplatform.app`,
   download `google-services.json` into `android/app/`, and download a
   service-account JSON (Project Settings → Service Accounts → Generate new
   private key) — paste its contents into Vercel as `FIREBASE_SERVICE_ACCOUNT_JSON`.
   Nothing else in the code needs to change once both exist.

2. **iOS needs a Mac.** This environment is Linux — there is no Xcode, no
   CocoaPods, no way to build or sign an iOS app here at all. `npx cap add
   ios` would scaffold the project fine, but building/running/testing it
   needs the user's own Mac + Xcode + an Apple Developer account (for
   PushKit/CallKit entitlements specifically — the iOS equivalent of this
   Android full-screen-call feature needs both). Not attempted in this pass;
   ask if the Android shell proves worth extending to iOS.

3. **Play Store signing/publishing.** This debug APK is unsigned for release
   and side-load only. A real release needs a keystore (generated once, kept
   safe forever — losing it means never being able to update the app under
   the same package id again) and a Play Console developer account ($25
   one-time). Both are the user's own accounts/credentials, same class as
   every other external-service credential in this repo.

4. **Never tested on a real device.** No physical Android phone exists in
   this environment. The build compiling is not proof the full-screen call
   UI, the FCM wake-up, or the bridge event actually behave correctly on a
   real device/OS version.

## Android 14 caveat, not a bug

`USE_FULL_SCREEN_INTENT` is auto-granted at install on API ≤ 33. On API 34+
Google lets the user revoke it in Settings for any app that isn't a default
dialer/assistant. If revoked, an incoming call falls back to an ordinary
heads-up notification instead of a full-screen takeover — never a crash.
Nothing to fix in code; worth calling out in the Play Store listing/review
if this ever gets published.

## Local rebuild

```
export ANDROID_HOME=/opt/android-sdk   # wherever your SDK lives
cd android
./gradlew assembleDebug
# APK at app/build/outputs/apk/debug/app-debug.apk
```
