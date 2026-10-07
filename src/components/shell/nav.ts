export interface NavItem {
  href: string;
  label: string;
}

/** Primary navigation, in the order a new visitor should meet the product. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/workspace", label: "Workspace" },
  { href: "/operations", label: "Operations" },
  { href: "/policies", label: "Policies" },
  { href: "/how-it-works", label: "How it works" },
];

export const GITHUB_URL = "https://github.com/dorakingx/pact-agent-commerce";
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

/** `id` of the page's <main>; the skip link in the root layout targets it. */
export const MAIN_CONTENT_ID = "main-content";

/** A nav item is active on its own page and on anything nested below it. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
