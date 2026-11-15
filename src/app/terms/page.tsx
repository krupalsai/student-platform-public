import type { Metadata } from "next";
import LegalLayout from "@/components/legal-layout";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Terms & Conditions | Student Platform",
  description: "Terms and Conditions governing the use of Student Platform services.",
};

export default function TermsPage() {
  return (
    <LegalLayout>
      <BackButton />
      <h1 className="text-3xl font-bold mb-2">Terms & Conditions</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: October 2026</p>

      <div className="space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">1. Acceptance of Terms</h2>
          <p>
            By accessing or using Student Platform, you agree to be bound by these Terms
            and Conditions. If you do not agree, please do not use the platform.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">2. About the Service</h2>
          <p>
            Student Platform is operated as a professional student services business,
            providing student guidance, academic support services, and administrative
            support to students through a secure digital platform. Students register,
            submit required information, upload documents, and receive updates on the
            status of their request through the platform.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">3. User Responsibilities</h2>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>Provide accurate and truthful information during registration.</li>
            <li>Keep your account credentials secure.</li>
            <li>Not misuse the platform or attempt to manipulate any records.</li>
            <li>Upload only genuine and valid documents.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">4. Fees & Payments</h2>
          <p>
            The fee depends on the service required. The exact amount is shown in the
            Student App before you pay, and nothing is charged before that point. No hidden charges apply. Payments are processed securely by
            RBI-authorised payment gateway partners (Razorpay or Cashfree). Once paid, fees are non-refundable as per our Refund
            Policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">5. Intellectual Property</h2>
          <p>
            All content, design, and software on Student Platform is the property of
            Kusanapelli Sai Krupal. Unauthorized reproduction or distribution is prohibited.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">6. Copyright / DMCA Notices</h2>
          <p>
            If you believe content on Student Platform (including a photo or file shared
            in a Batch Discussion) infringes your copyright, send a written notice to our
            designated agent with: (1) your signature, (2) identification of the
            copyrighted work, (3) the location of the material on the platform, (4) your
            contact information, and (5) a statement of good-faith belief that the use is
            unauthorized. Notices can be sent to:
          </p>
          <p className="mt-2">
            <strong>Designated Agent:</strong> Kusanapelli Sai Krupal
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">7. Limitation of Liability</h2>
          <p>
            Student Platform is not liable for any indirect, incidental, or consequential
            damages arising from use of the platform. We do not guarantee uninterrupted
            availability of the service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">8. Governing Law</h2>
          <p>
            These Terms are governed by the laws of India. Any disputes shall be subject
            to the jurisdiction of courts in Karimnagar, Telangana.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">9. Contact Us</h2>
          <p>
            For any queries regarding these Terms, please contact us through
            the Student App support chat.
          </p>
          <p className="mt-2">
            <strong>Managed by:</strong> Kusanapelli Sai Krupal
          </p>
        </section>
      </div>
    </LegalLayout>
  );
}
