// Bump VERSION whenever this service worker changes.
const VERSION = "student-platform-pwa-v10"; // v10 (14 Nov 2026): no behaviour change — version bump only, so every phone's old v9 registration is replaced and old caches are deleted on activate after the install-button / stale-tab fix.

/*
 * This worker keeps NO copy of the app, on purpose.
 *
 * Up to v5 it saved the homepage ("/" and "/admin") at install and answered ANY
 * page launch that failed on the network with that saved page. The saved HTML
 * names the script files of the build it came from, and every deploy after that
 * deletes those files from the server (about ten deploys a day), so a launch on
 * a weak signal opened a page that could not load its own code: "Loading chunk
 * ... failed", then "Something went wrong", again on every reload for as long as
 * the signal stayed bad. Client-error reports showed it: one student, two days,
 * always a home-page file that had been removed 23 and 44 hours earlier.
 *
 * A launch with no connection now gets a small page that needs nothing from the
 * server; the next launch with a connection gets the current app.
 */
const OFFLINE_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta name="theme-color" content="#f2f2f7"><title>Student Platform</title>',
  "<style>",
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f2f2f7;color:#1c1c1e}',
  ".w{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}",
  "h1{font-size:20px;margin:0 0 8px}p{font-size:14px;color:#6e6e73;margin:0 0 20px}",
  "button{background:#007aff;color:#fff;border:0;border-radius:12px;padding:13px 28px;font-size:15px;font-weight:600}",
  '</style></head><body><div class="w"><div style="max-width:340px">',
  "<h1>No connection</h1><p>Check your internet, then try again.</p>",
  '<button onclick="location.reload()">Try again</button>',
  "</div></div>",
  '<script>addEventListener("online",function(){location.reload()})</script>',
  "</body></html>",
].join("");

function offlinePage() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

// Delete every saved copy before taking over — including the saved homepage v5
// left on student phones — so none of them can ever be served again.
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks a waiting worker to take over now, so a new build applies
// without waiting for every tab to close (install already skipWaits; this
// is the page-driven half, used by src/lib/pwa-recovery.ts).
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Data requests are never ours to answer. When one failed, this used to hand
  // back the cached HOMEPAGE html as if it were the API's reply; the app then
  // choked on it and bounced the student to "/" — a redirect loop on a flaky
  // connection. Let /api/* fail honestly so the app can retry.
  if (url.pathname.startsWith("/api/")) return;
  // Only a page navigation gets the offline page — never a saved copy of the app.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => offlinePage()));
  }
});

self.addEventListener("push", event => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Student Platform", body: event.data.text() };
  }
  // requireInteraction stays opt-in per notification (only a voice call sets it).
  //
  // Sound: every notification here carries a tag, so a newer one of the same
  // kind REPLACES the one already in the tray — and a replacement is silent
  // unless `renotify` is on: no sound, no vibration, no banner. The login code
  // (tag "login-otp"), the registration code and every "update" of one type
  // share a tag, and a notification stays in the tray until it is swiped away,
  // so the second code of a day arrived without a sound. That is what
  // "the app has no notification sounds" was. Always renotify (a payload may opt
  // out with renotify:false), say "not silent" out loud, and vibrate by default.
  //
  // A login code is also handed straight to any open window, so the login
  // screen fills it in by itself. The notification is still shown (browsers
  // require every push to show one, and it is the fallback when the app is
  // closed).
  const otp = typeof payload.otp === "string" && /^\d{6}$/.test(payload.otp) ? payload.otp : null;
  const relay = otp
    ? self.clients.matchAll({ type: "window", includeUncontrolled: true })
        .then(clients => clients.forEach(c => c.postMessage({ type: "sp_login_otp", otp })))
    : Promise.resolve();
  // Chat messages and support replies name the screen that shows them live
  // (liveOn). When a window of the app is visible, focused and ON that screen,
  // the system alert would only repeat what the student is looking at — the
  // screen refreshes and chimes by itself — so it is shown quietly (it is still
  // shown: every push must show a notification, and iOS cancels subscriptions
  // that don't) and the screen is told to refresh right now.
  const liveOn = typeof payload.liveOn === "string" && payload.liveOn.charAt(0) === "/" ? payload.liveOn : null;
  const watching = liveOn
    ? self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
        const open = clients.filter(c => {
          try {
            const u = new URL(c.url);
            // Exactly that screen: /discussion/call (a group call) is not the chat.
            return c.visibilityState === "visible" && c.focused === true && u.origin === self.location.origin && u.pathname.replace(/\/+$/, "") === liveOn;
          } catch { return false; }
        });
        open.forEach(c => c.postMessage({ type: "sp_live", liveOn }));
        return open.length > 0;
      }).catch(() => false)
    : Promise.resolve(false);
  // renotify needs a non-empty tag, or showNotification() throws a TypeError.
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : "student-platform";
  event.waitUntil(Promise.all([relay, watching]).then(([, quiet]) =>
    self.registration.showNotification(payload.title || "Student Platform", {
      body: payload.body || "",
      tag,
      icon: "/pwa-icon.svg",
      badge: "/pwa-icon.svg",
      data: { url: typeof payload.url === "string" ? payload.url : "/dashboard", otp },
      requireInteraction: payload.requireInteraction === true,
      renotify: !quiet && payload.renotify !== false,
      silent: quiet,
      // silent together with a vibration pattern is a TypeError.
      vibrate: quiet ? undefined : Array.isArray(payload.vibrate) ? payload.vibrate : [200, 100, 200],
    })
  ));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const otp = event.notification.data?.otp;
  if (otp) {
    // Do not navigate an open login screen (that would wipe the number the
    // student typed) — focus it and hand it the code. With no window open,
    // the code travels in the URL fragment, which never reaches the server.
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
        const open = clients.find(c => "focus" in c && new URL(c.url).origin === self.location.origin);
        if (open) {
          open.postMessage({ type: "sp_login_otp", otp });
          return open.focus();
        }
        return self.clients.openWindow(`/login#otp=${otp}`);
      })
    );
    return;
  }
  const target = typeof event.notification.data?.url === "string"
    ? event.notification.data.url
    : "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then(clients => {
      const sameOrigin = clients.find(c => "focus" in c && new URL(c.url).origin === self.location.origin);
      if (sameOrigin) {
        return sameOrigin.navigate(target).then(() => sameOrigin.focus());
      }
      return self.clients.openWindow(target);
    })
  );
});
