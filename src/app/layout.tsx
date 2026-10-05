import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { MAIN_CONTENT_ID } from "@/components/shell/nav";
import { themeInitScript } from "@/components/ui/theme";
import { Toaster } from "@/components/ui/toaster";
import { ThemeSync } from "@/components/ui/use-theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

const DEFAULT_APP_URL = "https://pact-agent-commerce.vercel.app";

/** A malformed NEXT_PUBLIC_APP_URL must not take the whole site down at build time. */
function resolveMetadataBase(): URL {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured && URL.canParse(configured)) return new URL(configured);
  return new URL(DEFAULT_APP_URL);
}

const TITLE = "PACT — Programmable Agent Commerce Trust";
const DESCRIPTION =
  "AI agents can negotiate. PACT makes sure they only get paid when the deal is done: a machine-readable contract, a PayPal authorization, and capture only after the delivery is verified.";

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: { default: TITLE, template: "%s · PACT" },
  description: DESCRIPTION,
  applicationName: "PACT",
  keywords: ["agent commerce", "AI agents", "PayPal", "conditional capture", "fulfillment-gated payment", "outcome-based payment"],
  openGraph: {
    type: "website",
    siteName: "PACT",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f1a" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      // The pre-paint script may switch these to "dark" before hydration; that mismatch is intended.
      data-theme="light"
      data-ag-theme-mode="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-full flex-col">
        <a
          href={`#${MAIN_CONTENT_ID}`}
          className="sr-only rounded-control border border-hairline-strong bg-surface px-4 py-2.5 text-sm font-medium text-fg shadow-pop focus-ring focus:not-sr-only focus:fixed focus:top-2.5 focus:left-3 focus:z-[60]"
        >
          Skip to content
        </a>
        <ThemeSync />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
