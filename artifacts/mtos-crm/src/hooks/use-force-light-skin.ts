import { useEffect } from "react";

/**
 * Force the light skin on the document while the calling component is
 * mounted. Used by public/auth pages (login, register, verify-email) so
 * the brand entry surfaces are always clean white regardless of the
 * authenticated user's saved theme. On unmount we DON'T restore — the
 * ThemeProvider's effect will re-apply the user's saved theme as soon as
 * its state changes, but to avoid a flicker on navigation we re-apply
 * the saved theme on cleanup directly.
 */
export function useForceLightSkin(): void {
  useEffect(() => {
    const root = document.documentElement;
    const prevClasses = root.className;
    root.classList.remove("dark", "theme-dark-blue", "theme-dark-red", "theme-light");
    root.classList.add("theme-light");
    return () => {
      root.className = prevClasses;
    };
  }, []);
}
