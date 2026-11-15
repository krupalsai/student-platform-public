"use client";

import Link from "next/link";
import { LifeBuoy } from "lucide-react";

export default function StudentSupportLink() {
  return (
    <Link
      href="/support"
      className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
    >
      <LifeBuoy size={16} />
      Contact Support
    </Link>
  );
}
