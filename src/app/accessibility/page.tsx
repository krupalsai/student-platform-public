import type { Metadata } from "next";
import LegalLayout from "@/components/legal-layout";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Accessibility Statement",
  description:
    "How Student Platform works for people with disabilities, what we have checked, what is not fully accessible yet, and how to reach us if something is hard to use.",
};

export default function AccessibilityPage() {
  return (
    <LegalLayout>
      <BackButton />
      <h1 className="text-3xl font-bold mb-2">Accessibility Statement</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: 14 October 2026</p>

      <div className="space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Our commitment</h2>
          <p>
            Student Platform is for students, and students include people with disabilities. We want
            our website and the Student App to work for everyone: people who use a screen reader, a
            keyboard or a switch device, screen magnification or large text, and people with low
            vision, colour blindness, hearing loss or limited hand movement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Standard and status</h2>
          <p>
            We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.1, Level AA, published
            by the W3C. Our status is <strong>partially conformant</strong>: the parts we have
            checked meet the guidelines, and some parts do not yet (see &ldquo;Known limitations&rdquo;
            below). We have not had an independent accessibility audit.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">What we do</h2>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>
              <strong>Zoom and text size:</strong> you can pinch-zoom and use larger system text.
              Zooming is never switched off.
            </li>
            <li>
              <strong>Screen readers:</strong> pages use headings, landmarks (header, main
              content, navigation, footer), labelled buttons and form fields, and a language
              setting. The home page and the policy pages start with a &ldquo;Skip to main
              content&rdquo; link.
            </li>
            <li>
              <strong>Keyboard:</strong> the website pages can be used with a keyboard alone, and
              the control you are on is outlined.
            </li>
            <li>
              <strong>Colour contrast:</strong> text on the website and on the main Student App
              screens meets the AA ratios (4.5:1 for normal text, 3:1 for large text). Links inside
              text are underlined, so they do not rely on colour alone.
            </li>
            <li>
              <strong>Motion:</strong> animations on the home page switch off if your device is set
              to reduce motion.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">How we check</h2>
          <p>
            On 14 October 2026 we ran automated accessibility checks (axe-core, WCAG 2.1 A and AA
            rules) on every public page and on the main Student App screens, and fixed what they
            found. Automated tools find only part of the problems, so we also rely on you telling
            us. People who use screen readers have not yet tested the Student App from start to
            finish.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Known limitations</h2>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>
              <strong>Official documents:</strong> court orders and similar documents are PDFs
              published by the court or issued by colleges. We link to them as published, and a
              screen reader may not be able to read them. Contact us and we will help you get what
              they say.
            </li>
            <li>
              <strong>Payments:</strong> you pay on a secure page run by our payment partner. We do
              not control its accessibility.
            </li>
            <li>
              <strong>Uploaded photos:</strong> photos you or other students upload (for example a
              College ID or a picture in Batch Discussion) are shown as they are, without a written
              description.
            </li>
            <li>
              <strong>Less-tested parts:</strong> some Student App screens were checked with sample
              data and in their usual state, so error messages, pop-ups and the live Batch Discussion
              chat may still have problems. Group calls have no live captions.
            </li>
            <li>
              <strong>Other services:</strong> WhatsApp messages and the High Court&apos;s website
              and live stream are run by other organisations.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Tell us if something is hard to use</h2>
          <p>
            If any part of the website or the Student App is hard to use, or you cannot get the
            information or service you need, please tell us. We usually reply within one working day
            and will help you complete the step another way, for example by phone or WhatsApp during
            working hours.
          </p>
          <p className="mt-3">
            Contact us through the Student App support chat.
            <br />
            Hours: Monday–Saturday, 10:00 AM – 6:00 PM IST
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Technical details</h2>
          <p>
            Student Platform is built with standard web technologies (HTML, CSS and JavaScript) and
            needs JavaScript turned on. It is designed for recent versions of Chrome and Safari on
            Android and iOS, and for desktop browsers, and it can be installed as an app from the
            browser.
          </p>
        </section>
      </div>
    </LegalLayout>
  );
}
