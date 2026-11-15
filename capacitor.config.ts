import type { CapacitorConfig } from '@capacitor/cli';

/**
 * This wraps the live production site (studentplatform.dev), not a
 * locally bundled build — every existing page (registration, payments, admin
 * console, Batch Discussion, calling) keeps working exactly as deployed on
 * Vercel with zero native rebuild needed for an ordinary web change. The ONLY
 * things this native shell adds are what a browser genuinely cannot do:
 * real FCM push tokens (registered by src/lib/push/native.ts, not the Web
 * Push VAPID subscriptions the PWA uses) and a full-screen incoming-call
 * notification (android/app/src/main/java/.../IncomingCallMessagingService.kt)
 * that can wake the device and ring even while the app is fully closed —
 * the actual reason this app exists.
 */
const config: CapacitorConfig = {
  appId: 'com.studentplatform.app',
  appName: 'Student Platform',
  webDir: 'public',
  server: {
    url: 'https://studentplatform.dev',
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
