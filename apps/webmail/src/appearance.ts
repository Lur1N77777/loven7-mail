export type AppTheme = "light" | "dark";

const STORAGE_KEY = "loven7.uiTheme";
const THEME_COLORS: Record<AppTheme, string> = {
  light: "#f6f5f3",
  dark: "#121110",
};

function normalizeTheme(value: unknown): AppTheme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function readInitialTheme(): AppTheme {
  try {
    const stored = normalizeTheme(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Fall through to the operating-system preference.
  }
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyRuntimeTheme(theme: AppTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.body?.style.setProperty("color-scheme", theme);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

export function writeTheme(theme: AppTheme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures in private mode.
  }
}
