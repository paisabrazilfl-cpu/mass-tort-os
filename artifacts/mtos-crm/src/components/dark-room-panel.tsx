import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { getAccessToken } from "@/lib/auth-store";

type DarkRoomLink = {
  id: number;
  user_id: number;
  label: string;
  url: string;
  sort_order: number;
};

const API = `${import.meta.env.BASE_URL}api/admin/dark-room`.replace(/\/+/g, "/");

function authHeaders(): HeadersInit {
  const t = getAccessToken();
  return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

/**
 * Stylised octagon glyph evoking a biohazard / security-corp emblem.
 * Hand-drawn SVG, no third-party trademark used.
 */
function UmbrellaGlyph({ size = 28 }: { size?: number }) {
  const r = size / 2;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id="dr-bg" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#1a1a1a" />
          <stop offset="100%" stopColor="#000" />
        </radialGradient>
      </defs>
      {/* outer octagon */}
      <polygon
        points="30,5 70,5 95,30 95,70 70,95 30,95 5,70 5,30"
        fill="url(#dr-bg)"
        stroke="#dc2626"
        strokeWidth="3"
      />
      {/* 8 red wedges around centre */}
      {Array.from({ length: 8 }).map((_, i) => {
        const a0 = (i * Math.PI) / 4 - Math.PI / 8;
        const a1 = (i * Math.PI) / 4 + Math.PI / 8;
        const cx = 50, cy = 50, R = 38;
        const x0 = cx + R * Math.cos(a0);
        const y0 = cy + R * Math.sin(a0);
        const x1 = cx + R * Math.cos(a1);
        const y1 = cy + R * Math.sin(a1);
        return (
          <path
            key={i}
            d={`M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`}
            fill={i % 2 === 0 ? "#dc2626" : "#fafafa"}
            opacity="0.92"
          />
        );
      })}
      {/* central core */}
      <circle cx="50" cy="50" r="9" fill="#0a0a0a" stroke="#dc2626" strokeWidth="2" />
      <circle cx="50" cy="50" r="3" fill="#dc2626" />
      {/* faint vignette */}
      <circle cx={r} cy={r} r={r - 2} fill="none" stroke="#000" strokeOpacity="0.4" strokeWidth="1" />
    </svg>
  );
}

export function DarkRoomPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<DarkRoomLink[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    try {
      const r = await fetch(API, { headers: authHeaders() });
      if (!r.ok) return;
      const j = (await r.json()) as { data?: { rows?: DarkRoomLink[] } };
      setLinks(j.data?.rows ?? []);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    if (!open) return;
    if (links !== null) return;
    void load();
  }, [isAdmin, open, links, load]);

  if (!isAdmin) return null;

  const submit = async () => {
    const label = newLabel.trim();
    let url = newUrl.trim();
    if (!label || !url) {
      toast({ title: "Both fields required", variant: "destructive" });
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    setBusy(true);
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ label, url }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        toast({ title: "Couldn't save", description: e?.message || `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      const row = (await r.json()) as DarkRoomLink;
      setLinks((prev) => [...(prev ?? []), row]);
      setNewLabel("");
      setNewUrl("");
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Remove this portal?")) return;
    const prev = links ?? [];
    setLinks(prev.filter((l) => l.id !== id));
    const r = await fetch(`${API}/${id}`, { method: "DELETE", headers: authHeaders() });
    if (!r.ok && r.status !== 204) {
      setLinks(prev);
      toast({ title: "Couldn't remove", variant: "destructive" });
    }
  };

  return (
    <div className="border-t border-red-900/40 bg-black/95 text-zinc-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-red-500 hover:bg-red-950/40"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <UmbrellaGlyph size={14} />
          BOS-OMEGA · DARK ROOM
        </span>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
      </button>

      {open && (
        <div className="border-t border-red-900/30 px-3 py-2">
          {links === null ? (
            <div className="flex items-center gap-2 py-2 text-[10px] text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" /> loading...
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-2">
              {links.map((l) => (
                <div key={l.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => window.open(l.url, "_blank", "noopener,noreferrer")}
                    title={l.url}
                    className="flex h-14 w-14 flex-col items-center justify-center rounded-sm border border-red-900/50 bg-zinc-950 transition hover:border-red-500 hover:shadow-[0_0_8px_rgba(220,38,38,0.5)]"
                  >
                    <UmbrellaGlyph size={28} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(l.id)}
                    aria-label="Remove"
                    className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-white group-hover:flex"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                  <div
                    className="mt-0.5 max-w-[60px] truncate text-center text-[9px] uppercase tracking-wider text-zinc-400"
                    title={l.label}
                  >
                    {l.label}
                  </div>
                </div>
              ))}

              {adding ? (
                <div className="flex items-end gap-1">
                  <div className="flex flex-col gap-1">
                    <Input
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="Label"
                      maxLength={80}
                      className="h-7 w-24 border-red-900/60 bg-zinc-950 text-[10px]"
                    />
                    <Input
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      placeholder="https://…"
                      className="h-7 w-44 border-red-900/60 bg-zinc-950 text-[10px]"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submit();
                        if (e.key === "Escape") setAdding(false);
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void submit()}
                    className="h-7 bg-red-600 px-2 text-[10px] hover:bg-red-700"
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setAdding(false);
                      setNewLabel("");
                      setNewUrl("");
                    }}
                    className="h-7 px-2 text-[10px] text-zinc-400 hover:text-zinc-200"
                  >
                    ✕
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  aria-label="Add portal"
                  className="flex h-14 w-14 flex-col items-center justify-center rounded-sm border border-dashed border-red-900/60 bg-zinc-950/60 text-zinc-500 transition hover:border-red-500 hover:text-red-500"
                >
                  <Plus className="h-5 w-5" />
                  <span className="mt-0.5 text-[8px] uppercase tracking-wider">Add</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
