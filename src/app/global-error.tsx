"use client";

import { Geist, Geist_Mono } from "next/font/google";
import { RotateCw } from "lucide-react";
import { PactLogo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { ThemeSync } from "@/components/ui/use-theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

/**
 * Last-resort boundary for failures in the root layout itself. It replaces the layout, so it
 * brings its own document, fonts, styles and theme. Kept free of the app shell on purpose:
 * whatever broke the layout must not be able to break this page too.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html
      lang="en"
      data-theme="light"
      data-ag-theme-mode="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <title>Something went wrong · PACT</title>
      </head>
      <body className="flex min-h-full flex-col">
        {/* No pre-paint script here: React does not execute scripts it renders on the client,
            which is how this page usually appears. ThemeSync applies the theme before paint. */}
        <ThemeSync />
        <main className="container-page flex flex-1 flex-col items-center justify-center py-16 text-center">
          <PactLogo size="lg" />
          <h1 className="mt-10 text-2xl leading-8 font-semibold tracking-[-0.02em] text-fg">PACT could not start this page</h1>
          <p className="mt-3 max-w-md text-[15px] leading-6 text-muted">
            The application hit an unexpected error before it could render. No payment step runs from a page render, so
            nothing was authorized or captured by this error.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
            <Button onClick={retry}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
            {/* A full document navigation, not a client transition: the router state may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="inline-flex h-10 items-center rounded-control border border-hairline-strong bg-surface px-4 text-sm font-medium text-fg transition-colors duration-150 ease-out focus-ring hover:bg-subtle pointer-coarse:min-h-11"
            >
              Back to home
            </a>
          </div>
          {error.digest ? (
            <p className="mt-8 text-xs text-muted">
              Reference <span className="font-mono text-fg">{error.digest}</span>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
