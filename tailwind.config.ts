import type { Config } from "tailwindcss";

// The palette is a copy of Ritu Desk's design tokens (desk origin/main @ 8bee594, copied with
// the UI kit in PR 4; 06a §1.2, §16). This repo owns the copy. THE PALETTE IS OVERRIDDEN, NOT
// EXTENDED: only these tokens compile, and `npm run check:classes` fails on any other colour
// or size class. Left out: the desk's product-named and appointment/SLA tokens.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#FFFFFF",
      black: "#000000",
      canvas: "#F5F3EE", // warm paper
      surface: { DEFAULT: "#FFFFFF", raise: "#EFECE4", sunk: "#EFECE4" },
      hairline: { DEFAULT: "#E7E2D6", firm: "#CFC9BB" }, // warm border
      ink: { DEFAULT: "#0B0B0C", soft: "#3A3A40" },
      muted: "#6B6B70",
      faint: { DEFAULT: "#76767C", line: "#9A9A9E" },
      brand: {
        DEFAULT: "#3949E6", // royal indigo-blue (logo / CTAs)
        hover: "#2A37C2",
        tint: "#EEF0FE", // lavender card / chip bg
        peri: "#6675FF", // periwinkle — italic-serif accent
      },
      sidebar: {
        DEFAULT: "#0A0A0B", // near-black command rail
        raise: "#161619",
        border: "#26262B",
        text: "#ECECEE",
        muted: "#9A9AA2",
      },
      // Semantic washes: fills with ink text, never body text on white.
      ok: { DEFAULT: "#16A34A", wash: "#E6F5EB", ink: "#14532D" },
      warn: { DEFAULT: "#D97706", wash: "#FBF0DC", ink: "#7C3E00" },
      bad: { DEFAULT: "#DC2626", wash: "#FBE5E5", ink: "#7F1D1D" },
      done: { DEFAULT: "#475569", wash: "#E8ECF1" },
    },
    extend: {
      fontFamily: {
        // The system stack: no build-time font download (the desk loads web fonts).
        sans: ["system-ui", "-apple-system", "Segoe UI", "Noto Sans Gujarati", "Noto Sans Devanagari", "sans-serif"],
        serif: ["Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        indic: ["Noto Sans Gujarati", "Noto Sans Devanagari", "system-ui", "sans-serif"],
      },
      fontSize: {
        // Bigger, confident scale (the old one was too small).
        display: ["46px", { lineHeight: "1.04", letterSpacing: "-0.025em", fontWeight: "800" }],
        h1: ["30px", { lineHeight: "1.12", letterSpacing: "-0.02em", fontWeight: "800" }],
        h2: ["22px", { lineHeight: "1.25", letterSpacing: "-0.015em", fontWeight: "700" }],
        h3: ["18px", { lineHeight: "1.4", letterSpacing: "-0.01em", fontWeight: "600" }],
        body: ["16px", { lineHeight: "1.6" }],
        small: ["14px", { lineHeight: "1.5" }],
        // Was used on 36 labels and never defined, so they inherited body size.
        micro: ["12px", { lineHeight: "1.45" }],
        label: ["11.5px", { lineHeight: "1", letterSpacing: "0.14em" }], // mono uppercase
      },
      boxShadow: {
        card: "0 1px 2px rgba(11,11,12,0.04), 0 6px 20px rgba(11,11,12,0.06)",
        brutal: "4px 4px 0 0 #0B0B0C",
        "brutal-sm": "2px 2px 0 0 #0B0B0C",
        "brutal-blue": "4px 4px 0 0 #3949E6",
        rail: "0 0 0 1px rgba(255,255,255,0.04)",
        sheet: "-8px 0 32px rgba(11,11,12,0.12)",
      },
      borderRadius: { xl2: "14px" },
      minHeight: { tap: "44px", "tap-lg": "48px" },
      minWidth: { tap: "44px", "tap-lg": "48px" },
      spacing: { tap: "44px", "tap-lg": "48px", rail: "72px", tabs: "64px" },
      transitionDuration: { 120: "120ms", 180: "180ms", 240: "240ms" },
      zIndex: { rail: "30", top: "20", sheet: "40", toast: "50" },
      keyframes: {
        pulseOnce: { "0%": { backgroundColor: "#EEF0FE" }, "100%": { backgroundColor: "transparent" } },
        slideIn: { "0%": { transform: "translateX(16px)", opacity: "0" }, "100%": { transform: "translateX(0)", opacity: "1" } },
        sheetIn: { "0%": { transform: "translateX(100%)" }, "100%": { transform: "translateX(0)" } },
        sheetUp: { "0%": { transform: "translateY(100%)" }, "100%": { transform: "translateY(0)" } },
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
      },
      animation: {
        "pulse-once": "pulseOnce 1.8s ease-out 1",
        "slide-in": "slideIn 0.18s ease-out",
        "sheet-in": "sheetIn 0.24s ease-out",
        "sheet-up": "sheetUp 0.24s ease-out",
        "fade-in": "fadeIn 0.12s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
