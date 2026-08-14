import { Suspense } from "react";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/app/providers";
import { TimerProvider } from "@/components/app/timer";
import { AppShell } from "@/components/app/shell";
import { THEME_INIT_SCRIPT } from "@/styles/tokens";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Tally", template: "%s · Tally" },
  description: "Time tracking, profitability, and invoicing for JH Media Group",
  icons: { icon: "/tally-mark.svg", shortcut: "/tally-mark.svg", apple: "/tally-mark.svg" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set by middleware, and the same value the Content-Security-Policy header
  // carries. Without it the theme script is refused in production, which is the
  // flash of the wrong theme it exists to prevent.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <head>
        {/*
          Render-blocking on purpose: prevents a flash of the wrong theme.

          `suppressHydrationWarning` is for the nonce, and it is the browser's
          behaviour rather than ours that needs suppressing. Once a script has
          been parsed, the HTML spec has the browser move the nonce into an
          internal slot and blank the content attribute, so `getAttribute("nonce")`
          reads "" on the client while the server sent a real value. React
          compares the two and reports a hydration mismatch on every page load.
          The nonce itself is working: the script ran, and in production it is
          what lets it run at all.

          Scoped to this one element, and safe here only because
          `THEME_INIT_SCRIPT` is a compile-time constant. If it ever becomes
          dynamic, this suppression starts hiding a real mismatch.
        */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>
        {/* One boundary for the whole app. Filter state lives in the URL, so
            nearly every page reads useSearchParams; without this the build
            fails on the first page it prerenders. Tally is signed-in software
            with no public pages, so client rendering costs us nothing. */}
        <Suspense fallback={null}>
          <Providers>
            <TimerProvider>
              <AppShell>{children}</AppShell>
            </TimerProvider>
          </Providers>
        </Suspense>
      </body>
    </html>
  );
}
