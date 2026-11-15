"use client";
import { useRouter } from "next/navigation";

export default function BackButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 14, color: "#6b7280", fontWeight: 500,
        marginBottom: 24, background: "none", border: "none",
        cursor: "pointer", padding: 0,
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      Back
    </button>
  );
}
