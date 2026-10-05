/**
 * Theme contract shared by the pre-paint script (root layout), the React hook and CSS.
 *
 *  - `data-theme="light|dark"` on <html> selects the token set in globals.css.
 *  - `data-ag-theme-mode` mirrors it: AG Grid, AG Charts and AG Studio read that attribute.
 *  - The explicit choice is stored in localStorage; with no stored choice the OS setting wins.
 */
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = "pact-theme";
export const THEME_ATTRIBUTE = "data-theme";
export const AG_THEME_ATTRIBUTE = "data-ag-theme-mode";
/** Dispatched on `window` whenever the applied theme changes. */
export const THEME_CHANGE_EVENT = "pact:theme-change";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/**
 * Runs synchronously in <head>, before first paint, so a stored or OS-level dark preference
 * never flashes light. Must stay dependency-free ES5: it is inlined as a string.
 */
export const themeInitScript = `(function(){var d=document.documentElement,s=null;try{s=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}var t=s==="light"||s==="dark"?s:(window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");d.setAttribute(${JSON.stringify(
  THEME_ATTRIBUTE,
)},t);d.setAttribute(${JSON.stringify(AG_THEME_ATTRIBUTE)},t)})()`;
