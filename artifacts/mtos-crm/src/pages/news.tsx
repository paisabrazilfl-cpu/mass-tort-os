import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Newspaper, ExternalLink, RefreshCw, Search, Clock } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface Article {
  title: string;
  link: string;
  source: string;
  published: string;
  description: string;
  category: string;
}

const categoryLabels: Record<string, { label: string; color: string }> = {
  mass_tort: { label: "Mass Tort", color: "bg-red-100 text-red-700" },
  pharma: { label: "Pharmaceutical", color: "bg-purple-100 text-purple-700" },
  mdl: { label: "MDL", color: "bg-blue-100 text-blue-700" },
  product_liability: { label: "Product Liability", color: "bg-orange-100 text-orange-700" },
  toxic_tort: { label: "Toxic Tort", color: "bg-green-100 text-green-700" },
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function stripHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

export default function News() {
  const { toast } = useToast();
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");

  const fetchNews = async () => {
    setLoading(true);
    try {
      const res = await apiFetchRaw("/api/news/mass-tort");
      if (!res.ok) throw new Error("Failed");
      setArticles(await res.json());
    } catch {
      toast({ title: "Failed to load news", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchNews(); }, []);

  const filtered = articles.filter(a => {
    if (filterCategory !== "all" && a.category !== filterCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!a.title.toLowerCase().includes(q) && !stripHtml(a.description).toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mass Tort News</h1>
          <p className="text-muted-foreground">Real-time news from tier-one legal and mass tort sources.</p>
        </div>
        <Button variant="outline" onClick={fetchNews} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-3 flex-wrap items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search articles..." className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Badge variant={filterCategory === "all" ? "default" : "outline"} className="cursor-pointer" onClick={() => setFilterCategory("all")}>All</Badge>
              {Object.entries(categoryLabels).map(([key, cfg]) => (
                <Badge key={key} variant="outline" className={`cursor-pointer ${filterCategory === key ? cfg.color : ""}`} onClick={() => setFilterCategory(key)}>{cfg.label}</Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-24" /></CardContent></Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Newspaper className="h-12 w-12 mx-auto mb-3" />
            <div>No articles found. Try adjusting your filters.</div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((article, i) => {
            const cat = categoryLabels[article.category];
            return (
              <Card key={i} className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => window.open(article.link, "_blank")}>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        {cat && <Badge variant="outline" className={`text-xs ${cat.color}`}>{cat.label}</Badge>}
                        <span className="text-xs text-muted-foreground font-medium">{article.source}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {timeAgo(article.published)}
                        </span>
                      </div>
                      <h3 className="font-semibold text-base leading-snug line-clamp-2">{article.title}</h3>
                      {(() => {
                        const desc = stripHtml(article.description);
                        return desc ? (
                          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{desc}</p>
                        ) : null;
                      })()}
                    </div>
                    <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="text-center text-sm text-muted-foreground">
          Showing {filtered.length} articles from {new Set(filtered.map(a => a.source)).size} sources
        </div>
      )}
    </div>
  );
}
