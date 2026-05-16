import { useEffect, useState } from "react";
import { Star, Plus, X, ExternalLink } from "lucide-react";

// Sidebar bookmark drawer. Pure client-side — list lives in localStorage
// under "mtos.favorites" so it survives reloads without a backend round
// trip. Each entry stores the raw URL + an optional human label. Clicks
// open in a new tab with rel="noopener noreferrer" so a hostile target
// can't reach `window.opener`.

interface Favorite {
  id: string;
  url: string;
  label: string;
}

const STORAGE_KEY = "mtos.favorites";

function load(): Favorite[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is Favorite =>
        f && typeof f.id === "string" && typeof f.url === "string" && typeof f.label === "string",
    );
  } catch {
    return [];
  }
}

function save(items: Favorite[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* quota / private-mode → silently ignore, list keeps working in memory */
  }
}

// Only http(s) URLs are accepted; everything else (javascript:, data:, …)
// is silently rejected so a hostile clipboard paste can't get rendered
// into an `<a href>`.
function isSafeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Strip the scheme + leading "www." so the visible label stays readable
// at the sidebar's narrow width. Fallback to "(link)" if nothing remains.
function autoLabel(safeUrl: string): string {
  try {
    const u = new URL(safeUrl);
    return (u.host.replace(/^www\./, "") + u.pathname).replace(/\/$/, "") || "(link)";
  } catch {
    return "(link)";
  }
}

export function FavoritesPanel() {
  const [items, setItems] = useState<Favorite[]>(() => load());
  const [adding, setAdding] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    save(items);
  }, [items]);

  function commit(): void {
    const safe = isSafeUrl(draftUrl);
    if (!safe) {
      setError("Paste a full http(s) URL");
      return;
    }
    const label = draftLabel.trim() || autoLabel(safe);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setItems((prev) => [...prev, { id, url: safe, label }]);
    setDraftUrl("");
    setDraftLabel("");
    setError(null);
    setAdding(false);
  }

  function remove(id: string): void {
    setItems((prev) => prev.filter((f) => f.id !== id));
  }

  return (
    <div className="border-t border-sidebar-border px-3 py-2" data-testid="favorites-panel">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/60">
          <Star className="h-3 w-3" aria-hidden />
          Favorites
        </div>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setError(null);
          }}
          title={adding ? "Cancel" : "Add favorite"}
          aria-label={adding ? "Cancel" : "Add favorite"}
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-sidebar-accent/60 text-sidebar-foreground/70"
          data-testid="favorites-toggle-add"
        >
          {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        </button>
      </div>

      {adding && (
        <div className="space-y-1 mb-2" data-testid="favorites-add-form">
          <input
            type="url"
            inputMode="url"
            placeholder="Paste URL"
            value={draftUrl}
            onChange={(e) => {
              setDraftUrl(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setAdding(false);
            }}
            autoFocus
            className="w-full rounded border border-sidebar-border bg-sidebar-accent/30 px-2 py-1 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
            data-testid="favorites-input-url"
          />
          <input
            type="text"
            placeholder="Label (optional)"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setAdding(false);
            }}
            className="w-full rounded border border-sidebar-border bg-sidebar-accent/30 px-2 py-1 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
            data-testid="favorites-input-label"
          />
          {error && (
            <p className="text-[11px] text-destructive" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={commit}
            className="w-full rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="favorites-commit"
          >
            Save
          </button>
        </div>
      )}

      {items.length === 0 && !adding && (
        <p className="text-[11px] text-sidebar-foreground/50 py-1">
          Paste any URL — saved here only on this device.
        </p>
      )}

      <ul className="space-y-0.5 max-h-48 overflow-y-auto" data-testid="favorites-list">
        {items.map((f) => (
          <li key={f.id} className="group flex items-center gap-1">
            <a
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              title={f.url}
              className="flex-1 min-w-0 flex items-center gap-1.5 rounded px-2 py-1 text-xs text-sidebar-foreground hover:bg-sidebar-accent/60"
              data-testid={`favorites-link-${f.id}`}
            >
              <ExternalLink className="h-3 w-3 flex-shrink-0 text-sidebar-foreground/50" aria-hidden />
              <span className="truncate">{f.label}</span>
            </a>
            <button
              type="button"
              onClick={() => remove(f.id)}
              title="Remove favorite"
              aria-label={`Remove ${f.label}`}
              className="invisible group-hover:visible inline-flex h-6 w-6 items-center justify-center rounded text-sidebar-foreground/50 hover:text-destructive hover:bg-sidebar-accent/60"
              data-testid={`favorites-remove-${f.id}`}
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
