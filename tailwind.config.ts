import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        neon: "#1FF80B",
        "neon-dim": "#15b008",
        ink: "#0a0e0a",
        "ink-2": "#0f150f",
        "ink-3": "#161d16",
        "line": "#1f2a1f",
        "txt": "#d8e8d8",
        "txt-dim": "#7d927d",
      },
      fontFamily: {
        mono: ["var(--font-mono)", "monospace"],
        sans: ["var(--font-sans)", "system-ui"],
      },
    },
  },
  plugins: [],
};
export default config;
