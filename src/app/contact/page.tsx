import type { Metadata } from "next";
import LegalLayout from "@/components/legal-layout";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Contact Us | Student Platform",
  description: "Contact Student Platform for questions about registration, payments or refunds.",
};

export default function ContactPage() {
  return (
    <LegalLayout>
      <BackButton />
      <h1 className="text-3xl font-bold mb-2">Contact Us</h1>
      <p className="text-sm text-gray-500 mb-10">We usually reply within one working day.</p>

      <div className="space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Business details</h2>
          <p>
            <strong>Business name:</strong> Student Platform<br />
            <strong>Operated by:</strong> Kusanapelli Sai Krupal<br />
            <strong>Location:</strong> Telangana, India
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Get in touch</h2>
          <p>
            Contact us through the Student App support chat.<br />
            Hours: Monday–Saturday, 10:00 AM – 6:00 PM IST
          </p>
          <p className="mt-3">
            Registered students can also use <strong>Support</strong> inside the Student App,
            which answers most questions instantly and passes the rest to our team.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Payments and refunds</h2>
          <p>
            For a payment or refund query, include your name, registered phone number and the
            payment reference. See our{" "}
            <a href="/refund-policy" className="text-primary underline underline-offset-2">Refund & Cancellation Policy</a>.
          </p>
        </section>
      </div>
    </LegalLayout>
  );
}
