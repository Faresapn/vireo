module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Warm near-black, layered surfaces (Vercel/Linear-grade neutrals, not pure #000)
        void: "#0a0a0b",
        base: "#0e0e10",
        panel: "#141416",
        raise: "#1a1a1d",
        edge: "#26262b",
        edgeSoft: "#1d1d21",
        ink: "#f5f5f6",
        sub: "#b4b4bb",
        mute: "#77777f",
        faint: "#55555c",
        // Single restrained signature accent — warm amber/gold (cinematic, not AI-purple),
        // used sparingly for active state + brand only.
        accent: {
          DEFAULT: "#e8b14c",
          soft: "#f0c874",
          deep: "#b8842f",
        },
        ok: "#4ade80",
        warn: "#fbbf24",
        bad: "#fb7185",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "ui-sans-serif", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px 0 rgba(0,0,0,0.4), 0 8px 24px -12px rgba(0,0,0,0.6)",
        pop: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 12px 40px -12px rgba(0,0,0,0.7)",
        glow: "0 0 0 1px rgba(232,177,76,0.25), 0 0 32px -8px rgba(232,177,76,0.25)",
      },
      letterSpacing: {
        tightest: "-0.03em",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.4s cubic-bezier(0.16,1,0.3,1)",
        shimmer: "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
};
