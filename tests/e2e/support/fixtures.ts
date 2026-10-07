/**
 * The `test` every UI spec uses: Playwright's own, plus console hygiene on every page a test
 * opens. An uncaught exception or a `console.error` fails the test that caused it, with the page
 * it happened on — the one exception being the licence and watermark notices AG Grid, AG Charts
 * and AG Studio print when they run without a licence key (this repository ships without one).
 */
import { test as base, expect, type BrowserContext, type ConsoleMessage, type Page } from "@playwright/test";

/** What the AG libraries print about a missing or trial licence. Nothing else is tolerated. */
const AG_LICENCE_NOTICES: readonly RegExp[] = [
  // The banner's frame and title rows: "*****…*****" and "***** License Key Not Found *****".
  /^\*{20,}.*\*{20,}$/,
  // Its body rows: "* If you want to hide the watermark please email … for a trial license key. *".
  /^\* .*(licen[cs]e|watermark|trial).*\*$/i,
];

export interface ConsoleHygiene {
  /** Tolerate console errors matching `pattern` for the rest of this test (an expected 404, say). */
  allow(pattern: RegExp): void;
  /** Watch every page of a context the test created itself (a second browser, a phone). */
  watch(context: BrowserContext): void;
  /** Everything reported so far. */
  readonly problems: readonly string[];
}

function describe(page: Page): string {
  const url = page.url();
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return url;
  }
}

export const test = base.extend<{ consoleHygiene: ConsoleHygiene }>({
  consoleHygiene: [
    async ({ context }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      const watched = new WeakSet<Page>();

      const watchPage = (page: Page): void => {
        if (watched.has(page)) return;
        watched.add(page);
        page.on("pageerror", (error) => problems.push(`uncaught on ${describe(page)}: ${error.message}`));
        page.on("console", (message: ConsoleMessage) => {
          if (message.type() !== "error") return;
          const text = message.text();
          if (AG_LICENCE_NOTICES.some((pattern) => pattern.test(text))) return;
          if (allowed.some((pattern) => pattern.test(text))) return;
          problems.push(`console.error on ${describe(page)}: ${text}`);
        });
      };
      const watchContext = (target: BrowserContext): void => {
        target.on("page", watchPage);
        for (const page of target.pages()) watchPage(page);
      };

      watchContext(context);
      await use({ allow: (pattern) => allowed.push(pattern), watch: watchContext, problems });
      expect(problems, "page errors and console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
