import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://studentplatform.dev";
  const now = new Date();

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/student-help`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/student-help/epass-scholarship`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/student-help/certificates-documents`, lastModified: now, changeFrequency: "weekly", priority: 0.85 },
    { url: `${base}/student-help/registration`, lastModified: now, changeFrequency: "weekly", priority: 0.85 },
    { url: `${base}/privacy-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
    { url: `${base}/refund-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
    { url: `${base}/shipping-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
    { url: `${base}/contact`, lastModified: now, changeFrequency: "yearly", priority: 0.6 },
    { url: `${base}/accessibility`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
  ];
}
