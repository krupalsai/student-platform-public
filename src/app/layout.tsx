import type { Metadata } from "next";
import localFont from "next/font/local";
import ClientErrorReporter from "@/components/ClientErrorReporter";
import PwaBootstrapMount from "@/components/pwa/PwaBootstrapMount";
import StudentAppOnlyGate from "@/components/pwa/StudentAppOnlyGate";
import LinkedInClickTracker from "@/components/LinkedInClickTracker";
import NativeCallBridge from "@/components/NativeCallBridge";
import NativePushRegistrar from "@/components/NativePushRegistrar";
import NotificationGate from "@/components/student/NotificationGate";
import "./globals.css";

/**
 * Self-hosted: the font file lives in this repository (src/app/fonts, SIL Open
 * Font License — OFL.txt is next to it) and is served from this app's own domain.
 *
 * Visitors' browsers never contact Google — the live
 * `@import url('https://fonts.googleapis.com/...')` this replaced sent every
 * visitor's IP address to Google on every page load, which is exactly what
 * Munich's 2022 ruling on live Google Fonts was about — and neither does the
 * BUILD. `next/font/google` downloaded the font from Google while building, and
 * one malformed answer from Google failed a whole deployment ("An error occurred
 * in `next/font` ... Cannot read properties of null (reading '1')": a preview
 * build failed while the production build of the same commit passed, 2026-10-17).
 * A deploy must never depend on someone else's server being well-behaved.
 *
 * Inter variable font, Latin subset (v5.3.0, @fontsource-variable/inter): the one
 * file covers every weight from 100 to 900.
 */
const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "Student Platform",
    template: "%s | Student Platform",
  },
  description:
    "Student Platform provides professional student guidance, academic support services, and administrative support through a secure digital platform. Registration, document submission, and service fees are shown clearly before payment.",
  keywords: [
    "student services",
    "student guidance",
    "academic support",
    "administrative support",
    "student registration",
    "document submission",
  ],
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "Student Platform",
    description:
      "Professional student guidance, academic support, and administrative assistance through a secure digital platform.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Student Platform",
    url: "https://studentplatform.dev",
    description:
      "Professional student services company providing student guidance, academic support services, and administrative support through a secure digital platform.",
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
    },
  };

  return (
    <html lang="en" className={inter.variable}>
      <head>
        {/* Zoom must stay possible (WCAG 1.4.4): never add maximum-scale / user-scalable=no. iOS auto-zoom on small inputs is handled in globals.css. */}
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="theme-color" content="#111827" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Student App" />
        <link rel="manifest" href="/manifest.webmanifest" />
        {/* iOS Add to Home Screen icon — true 180x180 PNG (see /api/app-icon). */}
        <link rel="apple-touch-icon" href="/api/app-icon?size=180" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      </head>
      <body className="min-h-screen">
        <ClientErrorReporter />
        <PwaBootstrapMount />
        <StudentAppOnlyGate />
        <LinkedInClickTracker />
        <NativeCallBridge />
        <NativePushRegistrar />
        <NotificationGate />
        {children}
      </body>
    </html>
  );
}
