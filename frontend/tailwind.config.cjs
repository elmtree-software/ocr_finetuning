module.exports = {
  content: ["./ocr_finetuning.html", "./src/ocr-finetuning/**/*.{vue,ts}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        base: "var(--color-base)", // Keeping for backward compatibility if needed
        surface: "var(--color-surface)", // Keeping for backward compatibility
        accent: "var(--color-accent)",
        accentGreen: "var(--color-accent-green)",
        checkbox: "var(--color-checkbox)",
        "assistant-text": "var(--color-assistant-text)", // Keeping for backward compatibility

        // New Semantic Colors
        "workspace": "var(--bg-workspace)",
        "heading": "var(--text-heading)",
        "normal": "var(--text-normal)",

        "btn-std-bg": "var(--btn-std-bg)",
        "btn-std-text": "var(--btn-std-text)",
        "btn-std-border": "var(--btn-std-border)",
        "btn-std-hover-bg": "var(--btn-std-hover-bg)",
        "btn-std-hover-text": "var(--btn-std-hover-text)",

        "btn-spec-bg": "var(--btn-spec-bg)",
        "btn-spec-text": "var(--btn-spec-text)",
        "btn-spec-border": "var(--btn-spec-border)",
        "btn-spec-hover-bg": "var(--btn-spec-hover-bg)",
        "btn-spec-hover-text": "var(--btn-spec-hover-text)",

        // Dark Mode Palette (Legacy keys mapped to vars)
        dark: {
          bg: "var(--color-base)", // Reusing base/bg variable
          surface: "var(--color-surface)",
          "assistant-text": "var(--color-assistant-text)",
          border: "var(--color-border)",
        }
      },
      boxShadow: {
        'glow-accent': '0 0 20px -4px var(--shadow-glow-accent)',
        'dark-glow-accent': '0 0 24px -4px var(--shadow-dark-glow-accent)',
        'btn-std-glow': '0 0 var(--btn-std-glow-radius) var(--btn-std-glow-intensity) var(--btn-std-glow-color)',
        'btn-spec-glow': '0 0 var(--btn-spec-glow-radius) var(--btn-spec-glow-intensity) var(--btn-spec-glow-color)',
        'surface': 'var(--shadow-surface)',
        'elevated': 'var(--shadow-elevated)',
        'inner-glow': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.05)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    }
  },
  plugins: []
};
