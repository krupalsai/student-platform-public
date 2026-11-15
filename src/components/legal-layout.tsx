import Link from "next/link";
import type { ReactNode } from "react";
import SiteFooter from "@/components/site-footer";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-gray-900 focus:shadow-lg">Skip to main content</a>
      <header className="border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-6 py-5">
          <Link href="/" className="font-bold text-lg text-primary">Student Platform</Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="max-w-3xl mx-auto px-6 py-12 focus:outline-none">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
