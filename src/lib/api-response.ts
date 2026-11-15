import { NextResponse } from "next/server";
import type { ZodError } from "zod";
export const ok = <T>(d: T, s=200) => NextResponse.json({ success:true, data:d }, { status:s });
export const created = <T>(d: T) => ok(d, 201);
export const unauthorized = () => NextResponse.json({ success:false, error:"Unauthorized", code:"UNAUTHORIZED" }, { status:401 });
export const forbidden = () => NextResponse.json({ success:false, error:"Forbidden", code:"FORBIDDEN" }, { status:403 });
export const notFound = (w="Resource") => NextResponse.json({ success:false, error:`${w} not found`, code:"NOT_FOUND" }, { status:404 });
export const conflict = (msg: string) => NextResponse.json({ success:false, error:msg, code:"CONFLICT" }, { status:409 });
export const badRequest = (msg: string) => NextResponse.json({ success:false, error:msg, code:"BAD_REQUEST" }, { status:400 });
export const serverError = (msg="Internal server error") => NextResponse.json({ success:false, error:msg, code:"SERVER_ERROR" }, { status:500 });
/**
 * For a failed database call. Logs the real Postgres error server-side and
 * returns a safe, human-readable message to the client.
 *
 * Use this instead of `serverError(err.message)`. Postgres messages name
 * constraints, tables and columns ("... violates foreign key constraint
 * \"registration_tokens_profile_id_fkey\""), and several admin screens render
 * the returned `error` string straight into a toast — so passing err.message
 * through leaks schema internals into the UI and tells the operator nothing
 * they can act on.
 */
export function dbError(where: string, err: unknown, msg = "Something went wrong. Please try again.") {
  console.error(`[${where}]`, err);
  return NextResponse.json({ success:false, error:msg, code:"SERVER_ERROR" }, { status:500 });
}
export const tooManyRequests = (msg="Too many requests. Please try again later.") => NextResponse.json({ success:false, error:msg, code:"RATE_LIMITED" }, { status:429 });
// err.issues is read here (not err.errors) so this function works correctly
// whether it's given a real ZodError OR a hand-built { issues: [...] } object
// (see fieldError() below) — both shapes expose .issues, only real ZodError
// instances expose .errors. This was the actual root cause of a live
// TypeError crash: a fake object passed here previously hit `err.errors`
// (undefined) → `.forEach` on undefined.
export function zodError(err: ZodError | { issues: ZodError["issues"] }) {
  const fields: Record<string,string[]> = {};
  err.issues.forEach(e => { const k=e.path.join("."); fields[k]=[...(fields[k]??[]),e.message]; });
  return NextResponse.json({ success:false, error:"Validation failed", code:"VALIDATION_ERROR", fields }, { status: 422 });
}
// For a single ad-hoc field error outside normal Zod parsing (e.g. a DB-side
// validation like "college not found"). Prefer this over hand-building a
// fake ZodError-shaped object for zodError() — this is the same fix from a
// different angle, kept here too since it reads clearer at call sites than
// constructing { issues: [{ path, message, code }] } inline every time.
export function fieldError(field: string, message: string) {
  return NextResponse.json(
    { success:false, error:"Validation failed", code:"VALIDATION_ERROR", fields: { [field]: [message] } },
    { status: 422 },
  );
}
