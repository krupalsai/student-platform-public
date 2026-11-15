import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // #1d72b8: 5.1:1 on white, so text-primary links and bg-primary + white text pass WCAG AA (the old #2481cc was 4.1:1).
        primary: { DEFAULT: "#1d72b8", foreground: "#ffffff" },
        success: "#22c55e",
        warning: "#f59e0b",
        destructive: "#ef4444",
      },
      borderRadius: { xl: "0.75rem", "2xl": "1rem" },
    },
  },
  plugins: [],
};
export default config;
