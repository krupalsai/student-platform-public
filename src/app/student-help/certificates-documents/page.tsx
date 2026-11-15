import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Student Certificates & Documents Help",
  description:
    "Guidance for students looking for college certificates, document submission, bonafide-related processes, and administrative student services.",
  keywords: [
    "student certificates",
    "college certificates",
    "bonafide certificate",
    "student documents",
    "document submission",
    "college document help",
  ],
  alternates: { canonical: "/student-help/certificates-documents" },
};

export default function CertificatesDocumentsPage() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <article className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
        <Link href="/student-help" className="text-sm font-semibold underline">
          ← Student Help
        </Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-5xl">
          Student certificates & document help
        </h1>
        <p className="mt-5 text-lg leading-8 text-gray-600">
          For students searching for college certificates, document submission,
          bonafide-related requirements, or other administrative support,
          Student Platform provides a structured starting point.
        </p>

        <section className="mt-10 space-y-8">
          <div>
            <h2 className="text-xl font-semibold">Typical requirements</h2>
            <ul className="mt-3 list-disc space-y-2 pl-6 text-gray-700">
              <li>Identity and student details</li>
              <li>College and course information</li>
              <li>Documents requested for the specific service</li>
              <li>Correct contact details for updates</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-gray-200 p-6">
            <h2 className="text-xl font-semibold">Before submitting documents</h2>
            <p className="mt-2 leading-7 text-gray-600">
              Check the exact requirement for your service. Do not upload
              unnecessary sensitive documents. If an official authority has
              prescribed a particular format, deadline, or submission method,
              follow that requirement.
            </p>
          </div>

          <Link
            href="/register"
            className="inline-flex rounded-xl bg-gray-900 px-5 py-3 font-semibold text-white"
          >
            Open Student Registration
          </Link>
        </section>
      </article>
    </main>
  );
}
