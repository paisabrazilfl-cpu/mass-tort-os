import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeId = "aurora-light" | "midnight-blue" | "sunset-pop" | "rose-noir";

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "mtos:theme:v4";
const LEGACY_KEYS = ["mtos:theme", "mtos:theme:v2", "mtos:theme:v3"];

function normalizeTheme(value: string | null): ThemeId | null {
  if (!value) return null;
  if (value === "aurora-light" || value === "midnight-blue" || value === "sunset-pop" || value === "rose-noir") {
    return value;
  }
  if (value === "light") return "aurora-light";
  if (value === "dark-blue") return "midnight-blue";
  if (value === "dark-red") return "rose-noir";
  return null;
}

function applyTheme(t: ThemeId) {
  const root = document.documentElement;
  root.classList.remove(
    "dark",
    "theme-aurora-light",
    "theme-midnight-blue",
    "theme-sunset-pop",
    "theme-rose-noir",
  );

  if (t === "midnight-blue") {
    root.classList.add("dark", "theme-midnight-blue");
    return;
  }

  if (t === "rose-noir") {
    root.classList.add("dark", "theme-rose-noir");
    return;
  }

  if (t === "sunset-pop") {
    root.classList.add("theme-sunset-pop");
    return;
  }

  root.classList.add("theme-aurora-light");
}

function readInitialTheme(): ThemeId {
  if (typeof window === "undefined") return "aurora-light";
  const saved = normalizeTheme(window.localStorage.getItem(STORAGE_KEY));
  if (saved) return saved;

  for (const k of LEGACY_KEYS) {
    const legacy = normalizeTheme(window.localStorage.getItem(k));
    try { window.localStorage.removeItem(k); } catch {}
    if (legacy) return legacy;
  }

  return "aurora-light";
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
  { id: "aurora-light", label: "Aurora Light", swatch: "linear-gradient(135deg,#ffffff 0%,#dbeafe 35%,#f5d0fe 100%)" },
  { id: "midnight-blue", label: "Midnight Blue", swatch: "linear-gradient(135deg,#07111f 0%,#2563eb 45%,#8b5cf6 100%)" },
  { id: "sunset-pop", label: "Sunset Pop", swatch: "linear-gradient(135deg,#fff7ed 0%,#fdba74 45%,#f472b6 100%)" },
  { id: "rose-noir", label: "Rose Noir", swatch: "linear-gradient(135deg,#140b13 0%,#be185d 45%,#fb7185 100%)" },
];
