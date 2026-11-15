import type { Metadata } from "next";
import LegalLayout from "@/components/legal-layout";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Refund & Cancellation Policy | Student Platform",
  description: "Refund and cancellation policy for Student Platform.",
};

export default function RefundPolicyPage() {
  return (
    <LegalLayout>
      <BackButton />
      <h1 className="text-3xl font-bold mb-2">Refund & Cancellation Policy</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: October 2026</p>

      <div className="space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">1. No Refund Policy</h2>
          <p>
            The fee depends on the service required. The exact amount is shown in the
            Student App before you pay. No hidden charges apply.
            As per our company policy, once a fee has been paid, it is
            non-refundable, except in the following limited circumstances:
          </p>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>You were charged more than once for the same request (duplicate payment)</li>
            <li>A technical error on our platform caused the payment to be collected without the corresponding service being initiated</li>
          </ul>
          <p className="mt-2">
            In these cases, please contact us as described below within 7 days of the
            payment, and we will review and process an eligible refund. Once a refund
            is approved, the amount will be credited to the original payment method
            within 7–10 working days. The actual credit timeline may also depend on
            the customer&#39;s bank or payment service provider.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">2. Cancellation</h2>
          <p>
            You can cancel a registration at any time before paying — nothing is charged
            until you complete payment. A payment that was started but not completed is
            not charged; if money was debited for an incomplete payment, it is either
            confirmed against your registration or reversed by your bank or payment
            provider, usually within 5–7 working days. Once the fee is paid, the service
            begins immediately once your payment is confirmed, so
            a paid registration cannot be cancelled for a refund except in the cases
            listed above.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">3. How to Contact Us</h2>
          <p>
            Please reach out to us through the Student App support chat{" "}
            with your name, roll number, and payment transaction reference. Our team will
            review your query and respond as soon as reasonably possible.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">4. Contact Details</h2>
          <p>
            <strong>Managed by:</strong> Kusanapelli Sai Krupal
          </p>
        </section>
      </div>
    </LegalLayout>
  );
}
