import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Student Registration & Service Help",
  description:
    "Learn how Student Platform registration works for student services, document support, and college-related administrative assistance.",
  keywords: [
    "student registration",
    "student service registration",
    "college student registration",
    "student platform registration",
  ],
  alternates: { canonical: "/student-help/registration" },
};

export default function RegistrationHelpPage() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <article className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
        <Link href="/student-help" className="text-sm font-semibold underline">
          ← Student Help
        </Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-5xl">
          Student registration & service help
        </h1>
        <p className="mt-5 text-lg leading-8 text-gray-600">
          Student Platform gives students a structured registration flow for
          available student services, with the service requirements shown
          before submission or payment where applicable.
        </p>

        <ol className="mt-10 space-y-5">
          <li><strong>1. Choose the relevant service.</strong> Review what the service covers.</li>
          <li><strong>2. Enter student details.</strong> Provide accurate college and contact information.</li>
          <li><strong>3. Submit required documents.</strong> Upload only the documents requested for that service.</li>
          <li><strong>4. Review before payment.</strong> Where a fee applies, review the displayed service and fee information before proceeding.</li>
          <li><strong>5. Track the process.</strong> Use the available Student Platform status and communication channels for updates.</li>
        </ol>

        <Link
          href="/register"
          className="mt-10 inline-flex rounded-xl bg-gray-900 px-5 py-3 font-semibold text-white"
        >
          Start Registration
        </Link>
      </article>
    </main>
  );
}
