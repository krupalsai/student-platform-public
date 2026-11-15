import { redirect } from "next/navigation";

/**
 * The hand-typed "Case News" editor was removed: it never held a single row,
 * and the court's own website already says what happened. Court News reads it
 * automatically. This stays only so an old bookmark or link still lands
 * somewhere useful.
 */
export default function AdminCaseNewsMoved() {
  redirect("/admin/court-news");
}
