"use client";

import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import {
  AG_THEME_ATTRIBUTE,
  THEME_ATTRIBUTE,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  isTheme,
  type Theme,
} from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies): fall back to the OS setting.
    return null;
  }
}

function resolveTheme(): Theme {
  return storedTheme() ?? (window.matchMedia(DARK_QUERY).matches ? "dark" : "light");
}

function appliedTheme(): Theme {
  return document.documentElement.getAttribute(THEME_ATTRIBUTE) === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (root.getAttribute(THEME_ATTRIBUTE) === theme && root.getAttribute(AG_THEME_ATTRIBUTE) === theme) return;
  root.setAttribute(THEME_ATTRIBUTE, theme);
  root.setAttribute(AG_THEME_ATTRIBUTE, theme);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  // Follow the OS live, but only while the user has not made an explicit choice.
  const onSystemChange = () => {
    if (storedTheme() === null) applyTheme(resolveTheme());
  };
  // Another tab changed the preference.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) applyTheme(resolveTheme());
  };
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", onSystemChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", onSystemChange);
  };
}

/** The server cannot know the visitor's theme; the pre-paint script corrects the DOM before hydration. */
function getServerSnapshot(): Theme {
  return "light";
}

export interface UseTheme {
  /** The theme currently applied to <html>. `"light"` during server render and hydration. */
  theme: Theme;
  /** Apply and persist an explicit choice. */
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

/** Read and change the colour theme. Safe to call from any number of components. */
export function useTheme(): UseTheme {
  const theme = useSyncExternalStore(subscribe, appliedTheme, getServerSnapshot);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not persisted, but still applied for this page view.
    }
    applyTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(appliedTheme() === "dark" ? "light" : "dark");
  }, [setTheme]);

  return { theme, setTheme, toggleTheme };
}

/**
 * Re-applies the theme attributes after mount. In production this is a no-op. In development,
 * React Strict Mode remounts the tree and resets <html> to the attributes present in JSX, which
 * would silently drop the value written by the pre-paint script.
 */
export function ThemeSync(): null {
  useLayoutEffect(() => {
    applyTheme(resolveTheme());
  }, []);
  return null;
}
