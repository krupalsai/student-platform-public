import type { Metadata } from "next";
import LegalLayout from "@/components/legal-layout";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Shipping & Delivery Policy | Student Platform",
  description: "How Student Platform delivers its services. No physical goods are shipped.",
};

export default function ShippingPolicyPage() {
  return (
    <LegalLayout>
      <BackButton />
      <h1 className="text-3xl font-bold mb-2">Shipping & Delivery Policy</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: October 2026</p>

      <div className="space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">1. No physical shipping</h2>
          <p>
            Student Platform provides a service, not physical goods. Nothing is shipped to
            your address, and no shipping or delivery charges apply.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">2. How the service is delivered</h2>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>
              <strong>Payment confirmation:</strong> shown in the Student App immediately
              after a successful payment, usually within a few minutes.
            </li>
            <li>
              <strong>Service request:</strong> your request is activated as soon as the
              payment is confirmed, and its progress is shown in the Student App.
            </li>
            <li>
              <strong>Updates:</strong> status updates, announcements and next steps are
              delivered inside the Student App, with notifications by app push and WhatsApp.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">3. Contact</h2>
          <p>
            If you have paid and do not see confirmation in the Student App, contact us through the
            Student App support chat with your name, phone number and payment reference.
          </p>
        </section>
      </div>
    </LegalLayout>
  );
}
