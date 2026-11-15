/**
 * The build id of the code currently deployed.
 *
 * BUMP THIS ON EVERY DEPLOY THAT CHANGES USER-FACING COPY OR THE INSTALL
 * FLOW. The server (/api/version) and the client (the /install page)
 * import the same constant, so a phone holding an OLD tab — opened before
 * the deploy, kept alive in Chrome's tab list or restored from the
 * back-forward cache — can tell it is stale and reload onto the new
 * build instead of showing old instructions forever.
 *
 * Why this exists (14 Nov 2026): a student's phone showed the OLD
 * install page ("Install the Student Platform first… 1. Tap the ⋮ menu…
 * 2. Choose Install app") hours after the new page ("Tap the button
 * below. That's it.") was live and verified. The server was NOT serving
 * it stale — /install is Cache-Control: no-cache, no-store — the phone
 * was showing its own already-open tab (3 tabs open). Nothing on the
 * server can reach into an open tab; only the page itself, on its next
 * check, can notice it is old. PwaBootstrap's service-worker update
 * checks deliberately do NOT run on /install, so this check lives here,
 * on the install page itself.
 *
 * The check never loops: a reload is attempted at most once per server
 * build per tab session (sessionStorage guard). If the fetch fails
 * (offline), nothing happens — the student just sees the page they have.
 */
export const APP_BUILD_ID = "2026-11-14-simple-flow-4";
