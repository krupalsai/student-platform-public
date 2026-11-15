import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ePASS & Scholarship Help for Students",
  description:
    "Student guidance for Telangana ePASS and scholarship-related questions, documents, registration, renewal, and status information.",
  keywords: [
    "Telangana ePASS",
    "ePASS scholarship",
    "Telangana scholarship",
    "scholarship renewal",
    "scholarship status",
    "student scholarship documents",
  ],
  alternates: { canonical: "/student-help/epass-scholarship" },
};

export default function EpassScholarshipPage() {
  const faq = [
    {
      q: "Can Student Platform replace the official ePASS portal?",
      a: "No. Student Platform can provide guidance and student-service support, but official scholarship applications, decisions, and status information remain subject to the relevant government authority and its official portal.",
    },
    {
      q: "What should I check before applying?",
      a: "Check the current official notification for eligibility, application dates, required documents, renewal rules, and any college or department-specific requirements.",
    },
    {
      q: "Can I use Student Platform if I am unsure what to do?",
      a: "Yes. Start with the Student Platform guidance and registration flow to understand the service and the information or documents that may be needed.",
    },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <main className="min-h-screen bg-white text-gray-900">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <article className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
        <Link href="/student-help" className="text-sm font-semibold underline">
          ← Student Help
        </Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-5xl">
          Telangana ePASS & scholarship help
        </h1>
        <p className="mt-5 text-lg leading-8 text-gray-600">
          If you are searching for ePASS, scholarship application, renewal,
          status, or document guidance, this page explains where Student
          Platform can help and what must still be verified through official
          sources.
        </p>

        <section className="mt-10 space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Common student questions</h2>
            <ul className="mt-3 list-disc space-y-2 pl-6 text-gray-700">
              <li>What documents are needed for a scholarship process?</li>
              <li>How do I understand an ePASS application or renewal process?</li>
              <li>Where should I check the current official status?</li>
              <li>What should I do when a college document is required?</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6">
            <h2 className="text-xl font-semibold">Student Platform support</h2>
            <p className="mt-2 leading-7 text-gray-600">
              Student Platform can organize the student-service process,
              registration, document collection, and related support according
              to the service offered. It does not make government eligibility,
              scholarship, or approval decisions.
            </p>
            <Link
              href="/register"
              className="mt-5 inline-flex rounded-xl bg-gray-900 px-5 py-3 font-semibold text-white"
            >
              Start Student Registration
            </Link>
          </div>

          <div>
            <h2 className="text-xl font-semibold">Frequently asked questions</h2>
            <div className="mt-4 space-y-5">
              {faq.map((item) => (
                <div key={item.q}>
                  <h3 className="font-semibold">{item.q}</h3>
                  <p className="mt-1 leading-7 text-gray-600">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </article>
    </main>
  );
}
