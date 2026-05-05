import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeId = "dark-blue" | "dark-red" | "light";

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "mtos:theme";

function applyTheme(t: ThemeId) {
  const root = document.documentElement;
  root.classList.remove("dark", "theme-dark-blue", "theme-dark-red", "theme-light");
  if (t === "light") {
    root.classList.add("theme-light");
  } else if (t === "dark-red") {
    root.classList.add("dark", "theme-dark-red");
  } else {
    root.classList.add("dark", "theme-dark-blue");
  }
}

function readInitialTheme(): ThemeId {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
  if (saved === "light" || saved === "dark-blue" || saved === "dark-red") return saved;
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => readInitialTheme());

  useEffect(() => {
    applyTheme(theme);
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch {}
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

export const THEME_OPTIONS: { id: ThemeId; label: string; swatch: string }[] = [
  { id: "light", label: "Light", swatch: "linear-gradient(135deg,#f1f5f9,#0ea5e9)" },
  { id: "dark-blue", label: "Dark Blue", swatch: "linear-gradient(135deg,#0b1220,#0ea5e9)" },
  { id: "dark-red", label: "Dark Red", swatch: "linear-gradient(135deg,#0b0f17,#ef4444)" },
];
