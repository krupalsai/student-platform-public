import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/privacy-policy", "/refund-policy", "/shipping-policy", "/contact", "/terms", "/accessibility"],
        disallow: ["/admin", "/api", "/dashboard", "/profile", "/register", "/viewer", "/pay", "/lawyer"],
      },
    ],
    sitemap: "https://studentplatform.dev/sitemap.xml",
  };
}
