/**
 * Plain-English: this makes sure any link we build for redirecting a student
 * after payment actually points back to OUR website — never to some other
 * address a hacker could sneak in. This is what stops "open redirect"
 * tricks, where a link looks like it's from us but secretly sends someone
 * to a fake site.
 */

const ALLOWED_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").host;
  } catch {
    return "studentplatform.dev";
  }
})();

export function isSafeInternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return parsed.host === ALLOWED_HOST;
  } catch {
    return false;
  }
}

export function buildSafeRedirectUrl(path: string): string {
  if (path.startsWith("//") || path.includes("\\") || /^[a-z]+:/i.test(path.replace(/^\//, ""))) {
    throw new Error("Unsafe redirect path");
  }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev";
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : "/" + path}`;
}
