import type { Metadata } from "next";
import LegalLayout from "@/components/legal-layout";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Privacy Policy | Student Platform",
  description: "Privacy Policy for Student Platform.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalLayout>
      <BackButton />
      <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: October 2026</p>

      <div className="space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">1. Introduction</h2>
          <p>
            Student Platform is operated as a professional student services business,
            providing student guidance, academic support services, and administrative
            support to students through a secure digital platform. The fee depends on the service required; the exact amount is shown in the Student App before payment.
            No hidden charges apply.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">2. Information We Collect</h2>
          <p>When you register on Student Platform, we may collect:</p>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>Full name, father's name, date of birth</li>
            <li>College name, branch, year, roll number</li>
            <li>Phone number and contact details</li>
            <li>Payment transaction references</li>
            <li>Uploaded documents (e.g. ID proof, fee receipts)</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">3. How We Use Your Information</h2>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>To process your registration and service fee payment</li>
            <li>To verify your identity and submitted documents</li>
            <li>To send you status updates and notifications</li>
            <li>To process and deliver the academic or administrative service you requested</li>
            <li>To comply with legal and regulatory requirements</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">4. Data Storage & Security</h2>
          <p>
            Your data is stored securely using Supabase (PostgreSQL) with encryption at
            rest and in transit. Uploaded files are stored on Cloudinary with access
            controls. We do not sell or share your personal data with third parties
            except as required by law.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">5. Payment Information</h2>
          <p>
            Payments are processed by RBI-authorised payment gateway partners (Razorpay or Cashfree). We do not store your UPI credentials,
            card numbers, or banking details. Only transaction reference numbers and
            amounts are recorded for verification purposes.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">6. Your Rights</h2>
          <p>
            You may contact us to request access to, correction of, or deletion of your
            personal data. We will respond within a reasonable time.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">7. Contact Us</h2>
          <p>
            For any privacy-related queries, please contact us through the
            Student App support chat.
          </p>
          <p className="mt-2">
            <strong>Managed by:</strong> Kusanapelli Sai Krupal
          </p>
        </section>
      </div>
    </LegalLayout>
  );
}
