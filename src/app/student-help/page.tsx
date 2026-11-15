import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Student Help | Scholarships, ePASS & Certificates",
  description:
    "Student Platform helps students find clear guidance for scholarships, Telangana ePASS, college documents, certificates, registration, and related student services.",
  keywords: [
    "Telangana ePASS",
    "ePASS scholarship",
    "student scholarship",
    "college certificates",
    "student documents",
    "student registration",
    "Telangana student services",
  ],
  alternates: { canonical: "/student-help" },
  openGraph: {
    title: "Student Help | Scholarships, ePASS & Certificates",
    description:
      "Find student guidance for scholarships, ePASS, certificates, documents, and registration.",
    type: "website",
  },
};

const topics = [
  {
    href: "/student-help/epass-scholarship",
    title: "ePASS & Scholarship Help",
    text: "Guidance for students trying to understand ePASS, scholarship applications, renewals, status checks, and related document requirements.",
  },
  {
    href: "/student-help/certificates-documents",
    title: "Certificates & Documents",
    text: "Information for students looking for college certificates, document submission, bonafide-related processes, and other administrative requirements.",
  },
  {
    href: "/student-help/registration",
    title: "Student Registration",
    text: "Learn how Student Platform registration works and what information or documents may be required for a student service.",
  },
];

export default function StudentHelpPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Student Help",
    description:
      "Student guidance for scholarships, ePASS, certificates, documents, and registration.",
    url: "https://studentplatform.dev/student-help",
    isPartOf: { "@type": "WebSite", name: "Student Platform" },
  };

  return (
    <main className="min-h-screen bg-white text-gray-900">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-4xl px-5 py-12 sm:px-8">
        <header className="mb-10">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Student Platform
          </p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">
            Student help for scholarships, ePASS, certificates & documents
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-gray-600">
            Looking for help with a student application or college document?
            Start here for clear information and links to the relevant Student
            Platform service.
          </p>
        </header>

        <section className="grid gap-4 sm:grid-cols-3" aria-label="Student help topics">
          {topics.map((topic) => (
            <Link
              key={topic.href}
              href={topic.href}
              className="rounded-2xl border border-gray-200 p-5 shadow-sm transition hover:border-gray-400"
            >
              <h2 className="text-lg font-semibold">{topic.title}</h2>
              <p className="mt-2 text-sm leading-6 text-gray-600">{topic.text}</p>
              <span className="mt-4 inline-block text-sm font-semibold underline">
                Learn more
              </span>
            </Link>
          ))}
        </section>

        <section className="mt-10 rounded-2xl border border-gray-200 bg-gray-50 p-6">
          <h2 className="text-xl font-semibold">Need the service itself?</h2>
          <p className="mt-2 text-gray-600">
            Use the Student Platform registration flow after reviewing the
            information for your requirement.
          </p>
          <Link
            href="/register"
            className="mt-5 inline-flex rounded-xl bg-gray-900 px-5 py-3 font-semibold text-white"
          >
            Open Student Registration
          </Link>
        </section>

        <p className="mt-8 text-sm leading-6 text-gray-500">
          Student Platform is an independent student-services platform. Always
          verify official scholarship rules, deadlines, eligibility, and
          government requirements with the relevant official authority.
        </p>
      </div>
    </main>
  );
}
