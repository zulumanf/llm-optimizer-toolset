import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { AssistantGate } from "@/components/assistant/assistant-gate";
import { AppShell } from "@/components/layout/app-shell";
import "./globals.css";

// Internal tool: every view reads live data, nothing is statically prerendered
export const dynamic = "force-dynamic";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "AI Visibility OS",
  description: "Internal AI-visibility operations platform for client engagements",
};

/** Runs before paint so the correct theme is on <html> from the first frame —
 * no flash of the wrong theme, and no dependency for three lines of logic.
 * Must stay in sync with components/layout/theme-toggle.tsx. */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <AppShell sidebar={<Sidebar />} assistant={<AssistantGate />}>
          {children}
        </AppShell>
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
