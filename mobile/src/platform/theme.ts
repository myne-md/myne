import { useEffect, useState } from "react";
import type { ThemeName } from "./PlatformContext";

/**
 * Theme application — the canonical mechanism (tokens.css): a `data-theme`
 * attribute on <html>. Light is the bare-:root default (no attribute = follow
 * the OS via prefers-color-scheme); "dark"/"amoled" are explicit overrides.
 *
 * UI-only: this only flips the attribute so the design gallery can preview every
 * screen in each theme. No persistence to native prefs (that's logic, deferred).
 */

export const THEMES: ThemeName[] = ["light", "dark", "amoled"];

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function useTheme(initial: ThemeName = "light") {
  const [theme, setTheme] = useState<ThemeName>(initial);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return { theme, setTheme };
}
