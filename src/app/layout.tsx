import { Suspense } from "react";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/app/providers";
import { TimerProvider } from "@/components/app/timer";
import { AppShell } from "@/components/app/shell";
import { THEME_INIT_SCRIPT } from "@/styles/tokens";
import { ANONYMOUS_PAGE_HEADER, shouldLoadBugWidget } from "@/lib/anonymous-pages";
import { env } from "@/server/env";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Tally", template: "%s · Tally" },
  description: "Time tracking, profitability, and invoicing for JH Media Group",
  /*
    No `icons` here on purpose. `src/app/icon.svg` is Next's file convention and
    it emits the link tag by itself, with a content hash on the URL so a changed
    icon actually reaches a browser that cached the old one.

    This used to also declare `icons: { icon: "/tally-mark.svg", ... }`, which
    won: the metadata override beat the file convention, so `icon.svg` sat in
    the tree serving nothing and editing it changed no tab anywhere. Two
    mechanisms where one silently wins is worse than either alone.

    `/tally-mark.svg` is still in `public/` and still the in-app mark that
    `logo.tsx` renders in the collapsed sidebar. It is a separate asset from the
    favicon and is deliberately left alone.
  */
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set by middleware, and the same value the Content-Security-Policy header
  // carries. Without it the theme script is refused in production, which is the
  // flash of the wrong theme it exists to prevent.
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;

  /*
    The bug-reporting widget, and the two places it must not be.

    It is a third-party script from `app.toado.dev`, and the production CSP is
    `script-src 'self' 'nonce-...' 'strict-dynamic'`. Carrying the nonce means
    `strict-dynamic` extends that trust to whatever the loader pulls in next, so
    the widget can run arbitrary code in this origin and, through the
    `connect-src` entry for the same host, send back what it reads. That is a
    reasonable trade for bug reports from people testing the app. It is not a
    reasonable trade on the sign-in and set-password pages, where the thing
    being typed is a credential, so it is kept off them.

    The middleware sets the header because a root layout cannot see the
    pathname, and it strips any copy the client sent first.
  */
  const onAnonymousPage = requestHeaders.get(ANONYMOUS_PAGE_HEADER) === "1";
  const showBugWidget = shouldLoadBugWidget({ enabled: env.toadoWidget, anonymousPage: onAnonymousPage });

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
        {showBugWidget && (
          <script
            nonce={nonce}
            suppressHydrationWarning
            src="https://app.toado.dev/widget/v1/loader.js"
            data-toado-key="wgt_live_5cJDYjs5jzwD42SRs7BQqhBBwS6XwVXe"
            async
          />
        )}
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
