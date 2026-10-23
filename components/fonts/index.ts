/**
 * Self-hosted web fonts: one definition, imported everywhere.
 *
 * These were `next/font/google`, which downloads font files from Google at
 * BUILD time. On GitHub's runners Google answered with a font URL the Next.js
 * loader cannot parse (`/\.(woff|woff2|eot|ttf|otf)$/.exec(url)[1]` on null),
 * failing every CI build. The same build passed locally. Self-hosting makes the
 * build deterministic and network-free. The files are the exact latin-subset
 * variable fonts Google serves (fetched 2026-10-23), licensed under the SIL
 * Open Font License 1.1 (OFL-*.txt in this directory).
 */
import localFont from "next/font/local";

/** Body text (`--font-sans`). */
export const inter = localFont({
  src: "./inter-latin-var.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-sans",
});

/** Code and tabular detail (`--font-mono`). */
export const jetbrainsMono = localFont({
  src: "./jetbrains-mono-latin-var.woff2",
  weight: "100 800",
  style: "normal",
  display: "swap",
  variable: "--font-mono",
});

/** Editorial serif for marketing, audit and report pages (400/500, roman and italic). */
export const newsreader = localFont({
  src: [
    { path: "./newsreader-latin-var.woff2", weight: "400 500", style: "normal" },
    { path: "./newsreader-italic-latin-var.woff2", weight: "400 500", style: "italic" },
  ],
  display: "swap",
});
