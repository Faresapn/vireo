module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        void: "#08080b",
        panel: "#101014",
        edge: "#1c1c22",
        ink: "#e7e7ea",
        mute: "#8a8a93",
        indigo: {
          DEFAULT: "#6366f1",
          soft: "#818cf8",
          deep: "#4338ca",
        },
        ok: "#34d399",
        warn: "#fbbf24",
        bad: "#f87171",
      },
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
