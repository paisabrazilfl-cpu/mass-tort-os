/**
 * AdminGate — frontend half of the admin-PIN ("sudo mode") gate.
 *
 * Wraps an admin-area page. Decides which of three things to render:
 *   1. The page itself — caller is a super_admin AND has an unlock token.
 *   2. A PIN-entry / forced-change screen — super_admin, locked. On first
 *      use a status probe routes them straight into the forced-change flow
 *      so a brand-new super_admin (PIN still on stock 1234) is asked to
 *      pick a real PIN rather than told "enter your PIN."
 *   3. A "super admin only" notice — anyone else.
 *
 * Backend enforcement lives in lib/admin-pin.ts → requireAdminUnlock, so
 * this gate is UX, not security: the API rejects un-unlocked requests
 * regardless of what the UI shows.
 */
import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { ShieldCheck, ShieldOff, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { apiFetchRaw } from "@/lib/api-fetch";
import { getAdminUnlockToken, subscribeAdminUnlock } from "@/lib/admin-unlock-store";

type Mode = "enter" | "change";

export function AdminGate({ children }: { children: ReactNode }) {
  const { user, unlockAdmin, changeAdminPin } = useAuth();
  const [token, setToken] = useState<string | null>(getAdminUnlockToken());
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [onStock, setOnStock] = useState(false);
  const [mode, setMode] = useState<Mode>("enter");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-render when the unlock token flips (set after unlock / cleared on expiry).
  useEffect(() => {
    const unsub = subscribeAdminUnlock(() => setToken(getAdminUnlockToken()));
    return unsub;
  }, []);

  // For super_admins without an unlock token, probe stock-PIN state so we
  // can open directly into the forced-change flow when needed.
  useEffect(() => {
    if (user?.role !== "super_admin" || token) {
      setStatusLoaded(true);
      return;
    }
    setStatusLoaded(false);
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetchRaw("/api/auth/admin-pin/status");
        if (cancelled) return;
        if (!res.ok) {
          setStatusLoaded(true);
          return;
        }
        const d = (await res.json()) as { on_stock_pin?: boolean };
        const stock = Boolean(d.on_stock_pin);
        setOnStock(stock);
        if (stock) setMode("change");
        setStatusLoaded(true);
      } catch {
        if (!cancelled) setStatusLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, token]);

  // Not signed in — let the auth-redirect kick in.
  if (!user) return null;

  // Wrong role — show a calm "ask a super admin" panel.
  if (user.role !== "super_admin") {
    return (
      <div className="mx-auto max-w-md py-12">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-600">
              <ShieldOff className="h-6 w-6" aria-hidden="true" />
            </div>
            <CardTitle>Super-admin area</CardTitle>
            <CardDescription>
              This area is reserved for super administrators. Ask a super admin in your firm to
              perform this action.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // Super admin + unlocked — render the page.
  if (token) return <>{children}</>;

  // Super admin + locked + still probing → spinner so we don't flash the wrong mode.
  if (!statusLoaded) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  const onEnterSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{4,8}$/.test(pin)) {
      setError("PIN must be 4–8 digits.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await unlockAdmin(pin);
      if (r.kind === "ok") return; // token store flips → children render
      if (r.kind === "must_change") {
        setOnStock(true);
        setMode("change");
        setPin("");
        return;
      }
      setError(r.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onChangeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{4,8}$/.test(newPin)) {
      setError("New PIN must be 4–8 digits.");
      return;
    }
    if (newPin !== confirmPin) {
      setError("The two PIN entries don't match.");
      return;
    }
    if (newPin === "1234") {
      setError("Pick a PIN other than 1234.");
      return;
    }
    // For the stock case the current PIN is implicitly 1234; otherwise the
    // user typed their existing PIN above.
    const current = onStock ? "1234" : pin;
    if (!/^\d{4,8}$/.test(current)) {
      setError("Enter your current PIN.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await changeAdminPin(current, newPin);
      if (r.kind === "ok") return; // unlock token stored → children render
      setError(r.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-10">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <CardTitle>
            {mode === "change" ? "Set your admin PIN" : "Unlock admin functions"}
          </CardTitle>
          <CardDescription>
            {mode === "change"
              ? onStock
                ? "You're still using the stock PIN (1234). Pick a new one to unlock admin functions."
                : "Pick a new admin PIN. The next unlock will use it."
              : "Enter your admin PIN to unlock super-admin actions for this session (60 minutes)."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          {mode === "enter" ? (
            <form onSubmit={onEnterSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="admin-pin">Admin PIN</Label>
                <Input
                  id="admin-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  disabled={submitting}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting || pin.length < 4}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {submitting ? "Unlocking…" : "Unlock"}
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
                  onClick={() => {
                    setMode("change");
                    setError(null);
                    setPin("");
                  }}
                  disabled={submitting}
                >
                  Change my PIN instead
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={onChangeSubmit} className="space-y-4" noValidate>
              {!onStock && (
                <div className="space-y-2">
                  <Label htmlFor="cur-pin">Current PIN</Label>
                  <Input
                    id="cur-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={8}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    disabled={submitting}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="new-pin">New PIN</Label>
                <Input
                  id="new-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">4–8 digits. Anything except 1234.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-pin">Confirm new PIN</Label>
                <Input
                  id="confirm-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
                  disabled={submitting}
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={submitting || newPin.length < 4 || confirmPin.length < 4}
              >
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {submitting ? "Setting…" : "Set PIN and unlock"}
              </Button>
              {!onStock && (
                <div className="text-center">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
                    onClick={() => {
                      setMode("enter");
                      setError(null);
                      setNewPin("");
                      setConfirmPin("");
                    }}
                    disabled={submitting}
                  >
                    Back to entering my current PIN
                  </button>
                </div>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
