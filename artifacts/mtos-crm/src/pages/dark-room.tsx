import { useCallback, useEffect, useState } from "react";
import { Plus, X, Loader2, ExternalLink } from "lucide-react";
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
  return t
    ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

function OctagonGlyph({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id="dr-bg-pg" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#1a1a1a" />
          <stop offset="100%" stopColor="#000" />
        </radialGradient>
      </defs>
      <polygon
        points="30,5 70,5 95,30 95,70 70,95 30,95 5,70 5,30"
        fill="url(#dr-bg-pg)"
        stroke="#dc2626"
        strokeWidth="3"
      />
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
      <circle cx="50" cy="50" r="9" fill="#0a0a0a" stroke="#dc2626" strokeWidth="2" />
      <circle cx="50" cy="50" r="3" fill="#dc2626" />
    </svg>
  );
}

export default function DarkRoomPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [links, setLinks] = useState<DarkRoomLink[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const isAdmin = user?.role === "admin" || user?.role === "super_admin";

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
    void load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
        Admin only.
      </div>
    );
  }

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
        toast({
          title: "Couldn't save",
          description: (e as { message?: string })?.message || `HTTP ${r.status}`,
          variant: "destructive",
        });
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
    <div className="space-y-6">
      <div className="flex items-center gap-3 border-b border-red-900/40 pb-4">
        <OctagonGlyph size={36} />
        <div>
          <h1 className="text-xl font-bold uppercase tracking-[0.2em] text-red-500">
            BOS-OMEGA · DARK ROOM
          </h1>
          <p className="text-xs text-muted-foreground">
            Private admin URL launcher. Tiles are stored per user — only you can see yours.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-red-900/40 bg-black/95 p-4 text-zinc-200">
        {links === null ? (
          <div className="flex items-center gap-2 py-4 text-xs text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> loading portals…
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {links.map((l) => (
              <div key={l.id} className="group relative">
                <button
                  type="button"
                  onClick={() => window.open(l.url, "_blank", "noopener,noreferrer")}
                  title={l.url}
                  className="flex h-24 w-full flex-col items-center justify-center gap-1 rounded-sm border border-red-900/50 bg-zinc-950 px-2 transition hover:border-red-500 hover:shadow-[0_0_10px_rgba(220,38,38,0.5)]"
                >
                  <OctagonGlyph size={36} />
                  <span className="flex w-full items-center justify-center gap-1 truncate text-[10px] uppercase tracking-wider text-zinc-300">
                    <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{l.label}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => remove(l.id)}
                  aria-label="Remove"
                  className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white group-hover:flex"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}

            {adding ? (
              <div className="col-span-2 flex flex-col gap-2 rounded-sm border border-dashed border-red-900/60 bg-zinc-950/60 p-3 sm:col-span-3">
                <Input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Label (e.g. RENDER)"
                  maxLength={80}
                  className="h-8 border-red-900/60 bg-zinc-950 text-xs"
                />
                <Input
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://…"
                  className="h-8 border-red-900/60 bg-zinc-950 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                    if (e.key === "Escape") setAdding(false);
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void submit()}
                    className="h-7 flex-1 bg-red-600 text-xs hover:bg-red-700"
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
                    className="h-7 px-3 text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                aria-label="Add portal"
                className="flex h-24 w-full flex-col items-center justify-center gap-1 rounded-sm border border-dashed border-red-900/60 bg-zinc-950/60 text-zinc-500 transition hover:border-red-500 hover:text-red-500"
              >
                <Plus className="h-6 w-6" />
                <span className="text-[10px] uppercase tracking-wider">Add portal</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
