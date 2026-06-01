import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Star,
  Plus,
  Pencil,
  Trash2,
  ExternalLink,
  Check,
  X,
  ListPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, apiFetchRaw, describeError } from "@/lib/api-fetch";

type Favorite = {
  id: number;
  url: string;
  label: string | null;
  created_at: string;
  updated_at: string;
};

async function mutateJson<T = unknown>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const res = await apiFetchRaw(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error)) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function FavoritesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [bulkText, setBulkText] = useState("");

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editLabel, setEditLabel] = useState("");

  const {
    data: favorites,
    isLoading,
    isError,
  } = useQuery<Favorite[]>({
    queryKey: ["favorites"],
    queryFn: () => apiFetch<Favorite[]>("/api/favorites"),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["favorites"] });

  const addOne = useMutation({
    mutationFn: () =>
      mutateJson<Favorite>("/api/favorites", "POST", {
        url: url.trim(),
        label: label.trim() || null,
      }),
    onSuccess: () => {
      setUrl("");
      setLabel("");
      invalidate();
      toast({ title: "Favorite added" });
    },
    onError: (e) =>
      toast({
        title: "Couldn't add favorite",
        description: describeError(e),
        variant: "destructive",
      }),
  });

  const addBulk = useMutation({
    mutationFn: () =>
      mutateJson<{ addedCount: number; skipped: string[]; duplicates?: string[] }>(
        "/api/favorites/bulk",
        "POST",
        { urls: bulkText },
      ),
    onSuccess: (res) => {
      setBulkText("");
      invalidate();
      const parts: string[] = [];
      if (res.skipped?.length) parts.push(`${res.skipped.length} skipped (invalid)`);
      if (res.duplicates?.length) parts.push(`${res.duplicates.length} already saved`);
      const description = parts.length ? `${parts.join(", ")}.` : undefined;
      toast({
        title: `Added ${res.addedCount} favorite${res.addedCount === 1 ? "" : "s"}`,
        description,
      });
    },
    onError: (e) =>
      toast({
        title: "Couldn't add favorites",
        description: describeError(e),
        variant: "destructive",
      }),
  });

  const saveEdit = useMutation({
    mutationFn: (id: number) =>
      mutateJson<Favorite>(`/api/favorites/${id}`, "PATCH", {
        url: editUrl.trim(),
        label: editLabel.trim() || null,
      }),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
      toast({ title: "Favorite updated" });
    },
    onError: (e) =>
      toast({
        title: "Couldn't update favorite",
        description: describeError(e),
        variant: "destructive",
      }),
  });

  const removeOne = useMutation({
    mutationFn: (id: number) => mutateJson(`/api/favorites/${id}`, "DELETE"),
    onSuccess: () => {
      invalidate();
      toast({ title: "Favorite removed" });
    },
    onError: (e) =>
      toast({
        title: "Couldn't remove favorite",
        description: describeError(e),
        variant: "destructive",
      }),
  });

  function startEdit(f: Favorite) {
    setEditingId(f.id);
    setEditUrl(f.url);
    setEditLabel(f.label ?? "");
  }

  const list = favorites ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-950/40">
          <Star className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Favorites</h1>
          <p className="text-sm text-muted-foreground">
            Save links you use often. Add them one at a time or in bulk, then
            edit or remove any of them.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Add a single favorite */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="h-4 w-4" /> Add a favorite
            </CardTitle>
            <CardDescription>Add a single URL with an optional name.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim()) addOne.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="fav-url">URL</Label>
                <Input
                  id="fav-url"
                  placeholder="https://example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fav-label">Name (optional)</Label>
                <Input
                  id="fav-label"
                  placeholder="My dashboard"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                disabled={!url.trim() || addOne.isPending}
                className="w-full"
              >
                <Plus className="mr-1.5 h-4 w-4" />
                {addOne.isPending ? "Adding…" : "Add favorite"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Bulk add */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListPlus className="h-4 w-4" /> Add multiple
            </CardTitle>
            <CardDescription>
              Paste several URLs — one per line (or comma-separated).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Textarea
                rows={5}
                placeholder={"https://example.com\nhttps://news.example.com\nexample.org"}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!bulkText.trim() || addBulk.isPending}
                className="w-full"
                onClick={() => addBulk.mutate()}
              >
                <ListPlus className="mr-1.5 h-4 w-4" />
                {addBulk.isPending ? "Adding…" : "Add all"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Saved favorites{" "}
            {list.length > 0 && (
              <span className="text-muted-foreground">({list.length})</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              Couldn't load your favorites.
            </p>
          ) : list.length === 0 ? (
            <div className="py-10 text-center">
              <Star className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                No favorites yet. Add one above to get started.
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {list.map((f) => (
                <li key={f.id} className="py-3">
                  {editingId === f.id ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        value={editLabel}
                        placeholder="Name (optional)"
                        className="sm:w-48"
                        onChange={(e) => setEditLabel(e.target.value)}
                      />
                      <Input
                        value={editUrl}
                        placeholder="https://example.com"
                        className="flex-1"
                        onChange={(e) => setEditUrl(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={!editUrl.trim() || saveEdit.isPending}
                          onClick={() => saveEdit.mutate(f.id)}
                        >
                          <Check className="mr-1 h-4 w-4" /> Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {f.label || hostnameOf(f.url)}
                        </div>
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 truncate text-sm text-blue-600 hover:underline dark:text-blue-400"
                        >
                          <span className="truncate">{f.url}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Edit favorite"
                          onClick={() => startEdit(f)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Delete favorite"
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Remove favorite?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently remove{" "}
                                <span className="font-medium">
                                  {f.label || hostnameOf(f.url)}
                                </span>{" "}
                                from your favorites.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => removeOne.mutate(f.id)}
                              >
                                Remove
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
