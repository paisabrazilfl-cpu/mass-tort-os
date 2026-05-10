import { useState, useEffect, useId } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink, Trash2, Plus, Library } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "mtos_ads_libraries";

interface AdLink {
  id: string;
  label: string;
  url: string;
  category: string;
}

const CATEGORIES = [
  "Meta Ad Library",
  "Law Firm Search",
  "Ad Intelligence",
  "Other",
] as const;

const DEFAULT_LINKS: AdLink[] = [
  // Meta Ad Library
  {
    id: "d1",
    label: "Depo-Provera (All Active)",
    url: "https://www.facebook.com/ads/library/?q=Depo-Provera&country=US&active_status=all",
    category: "Meta Ad Library",
  },
  {
    id: "d2",
    label: "Meningioma",
    url: "https://www.facebook.com/ads/library/?q=meningioma&country=US&active_status=all",
    category: "Meta Ad Library",
  },
  {
    id: "d3",
    label: "Depo Provera Lawsuit",
    url: "https://www.facebook.com/ads/library/?q=Depo+Provera+lawsuit&country=US&active_status=all",
    category: "Meta Ad Library",
  },
  {
    id: "d4",
    label: "Brain Tumor + Depo",
    url: "https://www.facebook.com/ads/library/?q=brain+tumor+Depo&country=US&active_status=all",
    category: "Meta Ad Library",
  },
  {
    id: "d5",
    label: "Depo-Provera (Inactive / Paused)",
    url: "https://www.facebook.com/ads/library/?q=Depo-Provera&country=US&active_status=inactive",
    category: "Meta Ad Library",
  },
  // Law Firm Search
  {
    id: "lf1",
    label: "Morgan & Morgan",
    url: "https://www.facebook.com/ads/library/?q=Morgan+Morgan&country=US&active_status=all",
    category: "Law Firm Search",
  },
  {
    id: "lf2",
    label: "Sokolove Law",
    url: "https://www.facebook.com/ads/library/?q=Sokolove+Law&country=US&active_status=all",
    category: "Law Firm Search",
  },
  {
    id: "lf3",
    label: "Thomas J. Henry",
    url: "https://www.facebook.com/ads/library/?q=Thomas+J+Henry&country=US&active_status=all",
    category: "Law Firm Search",
  },
  {
    id: "lf4",
    label: "Robins Kaplan",
    url: "https://www.facebook.com/ads/library/?q=Robins+Kaplan&country=US&active_status=all",
    category: "Law Firm Search",
  },
  // Ad Intelligence
  {
    id: "ai1",
    label: "AdLibrary.com (50M+ archived Meta ads)",
    url: "https://adlibrary.com/meta-ad-library",
    category: "Ad Intelligence",
  },
  {
    id: "ai2",
    label: "BigSpy",
    url: "https://bigspy.com/",
    category: "Ad Intelligence",
  },
  {
    id: "ai3",
    label: "AdSpy",
    url: "https://adspy.com/",
    category: "Ad Intelligence",
  },
  {
    id: "ai4",
    label: "PowerAdSpy",
    url: "https://poweradspy.com/",
    category: "Ad Intelligence",
  },
];

const CATEGORY_STYLES: Record<string, string> = {
  "Meta Ad Library": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  "Law Firm Search": "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  "Ad Intelligence": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  "Other": "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

function loadLinks(): AdLink[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AdLink[];
  } catch {
    // ignore
  }
  return DEFAULT_LINKS;
}

function saveLinks(links: AdLink[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
}

export default function AdsLibraries() {
  const { toast } = useToast();
  const formId = useId();

  const [links, setLinks] = useState<AdLink[]>(loadLinks);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newCategory, setNewCategory] = useState<string>("Meta Ad Library");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    saveLinks(links);
  }, [links]);

  function handleAdd() {
    const label = newLabel.trim();
    const url = newUrl.trim();
    if (!label || !url) {
      toast({ title: "Label and URL are required", variant: "destructive" });
      return;
    }
    let normalized = url;
    if (!/^https?:\/\//i.test(normalized)) normalized = "https://" + normalized;
    try {
      new URL(normalized);
    } catch {
      toast({ title: "Invalid URL", variant: "destructive" });
      return;
    }
    const entry: AdLink = {
      id: `u_${Date.now()}`,
      label,
      url: normalized,
      category: newCategory,
    };
    setLinks((prev) => [...prev, entry]);
    setNewLabel("");
    setNewUrl("");
    setAdding(false);
    toast({ title: "Link added" });
  }

  function handleRemove(id: string) {
    setLinks((prev) => prev.filter((l) => l.id !== id));
    toast({ title: "Link removed" });
  }

  const grouped = CATEGORIES.map((cat) => ({
    category: cat,
    items: links.filter((l) => l.category === cat),
  })).filter((g) => g.items.length > 0);

  const otherLinks = links.filter((l) => !CATEGORIES.includes(l.category as typeof CATEGORIES[number]));
  if (otherLinks.length > 0) {
    grouped.push({ category: "Other", items: otherLinks });
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Library className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Ads Libraries</h1>
            <p className="text-sm text-muted-foreground">
              Quick access to ad intelligence tools and competitor research links
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setAdding((v) => !v)} variant={adding ? "outline" : "default"}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add Link
        </Button>
      </div>

      {adding && (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">New Link</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${formId}-label`} className="text-xs">Label</Label>
                <Input
                  id={`${formId}-label`}
                  placeholder="e.g. Camp Lejeune – Active Ads"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-url`} className="text-xs">URL</Label>
                <Input
                  id={`${formId}-url`}
                  placeholder="https://..."
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${formId}-cat`} className="text-xs">Category</Label>
              <Select value={newCategory} onValueChange={setNewCategory}>
                <SelectTrigger id={`${formId}-cat`} className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={handleAdd}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewLabel(""); setNewUrl(""); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-5">
        {grouped.map(({ category, items }) => (
          <div key={category}>
            <div className="flex items-center gap-2 mb-2">
              <span className={cn("px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide", CATEGORY_STYLES[category] ?? CATEGORY_STYLES["Other"])}>
                {category}
              </span>
              <span className="text-xs text-muted-foreground">{items.length} link{items.length !== 1 ? "s" : ""}</span>
            </div>
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y divide-border">
                  {items.map((link, idx) => (
                    <li
                      key={link.id}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 group",
                        idx === 0 && "rounded-t-lg",
                        idx === items.length - 1 && "rounded-b-lg",
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{link.label}</p>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{link.url}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          asChild
                        >
                          <a href={link.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="h-3.5 w-3.5 mr-1" />
                            Open
                          </a>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => handleRemove(link.id)}
                          aria-label="Remove link"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      {links.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Library className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No links yet. Click <strong>Add Link</strong> to get started.</p>
        </div>
      )}
    </div>
  );
}
