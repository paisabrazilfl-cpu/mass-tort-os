import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

interface NewsArticle {
  title: string;
  link: string;
  source: string;
  published: string;
  description: string;
  category: string;
}

const MASS_TORT_FEEDS = [
  { url: "https://news.google.com/rss/search?q=mass+tort+lawsuit+settlement&hl=en-US&gl=US&ceid=US:en", source: "Google News", category: "mass_tort" },
  { url: "https://news.google.com/rss/search?q=class+action+lawsuit+pharmaceutical&hl=en-US&gl=US&ceid=US:en", source: "Google News", category: "pharma" },
  { url: "https://news.google.com/rss/search?q=MDL+multidistrict+litigation&hl=en-US&gl=US&ceid=US:en", source: "Google News", category: "mdl" },
  { url: "https://news.google.com/rss/search?q=product+liability+lawsuit+recall&hl=en-US&gl=US&ceid=US:en", source: "Google News", category: "product_liability" },
  { url: "https://news.google.com/rss/search?q=toxic+tort+environmental+contamination+lawsuit&hl=en-US&gl=US&ceid=US:en", source: "Google News", category: "toxic_tort" },
];

const FINANCE_FEEDS = [
  { url: "https://finance.yahoo.com/news/rssindex", source: "Yahoo Finance", category: "market" },
  { url: "https://news.google.com/rss/search?q=pharmaceutical+stock+market+FDA+approval&hl=en-US&gl=US&ceid=US:en", source: "Google Finance", category: "pharma_finance" },
  { url: "https://news.google.com/rss/search?q=lawsuit+settlement+stock+impact&hl=en-US&gl=US&ceid=US:en", source: "Google Finance", category: "legal_finance" },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", source: "MarketWatch", category: "market" },
  { url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", source: "CNBC", category: "market" },
];

function decodeEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function parseXmlItem(xml: string): { title: string; link: string; pubDate: string; description: string }[] {
  const items: { title: string; link: string; pubDate: string; description: string }[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const rawTitle = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() || "";
    const title = decodeEntities(rawTitle);
    const link = block.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() || "";
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || "";
    const rawDesc = block.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() || "";
    const desc = decodeEntities(rawDesc.replace(/<[^>]+>/g, "")).trim();
    if (title) items.push({ title, link, pubDate, description: desc.slice(0, 300) });
  }
  return items;
}

async function fetchFeed(feedUrl: string, source: string, category: string): Promise<NewsArticle[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "MTOS-CRM/1.0 NewsAggregator" },
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseXmlItem(xml);
    return items.slice(0, 15).map(item => ({
      title: item.title,
      link: item.link,
      source,
      published: item.pubDate || new Date().toISOString(),
      description: item.description,
      category,
    }));
  } catch (err) {
    logger.warn({ err, feedUrl }, "Failed to fetch news feed");
    return [];
  }
}

let massCache: { articles: NewsArticle[]; fetched: number } = { articles: [], fetched: 0 };
let financeCache: { articles: NewsArticle[]; fetched: number } = { articles: [], fetched: 0 };
const CACHE_TTL = 10 * 60 * 1000;

router.get("/mass-tort", async (_req, res) => {
  if (massCache.articles.length > 0 && Date.now() - massCache.fetched < CACHE_TTL) {
    res.json(massCache.articles);
    return;
  }

  const results = await Promise.allSettled(
    MASS_TORT_FEEDS.map(f => fetchFeed(f.url, f.source, f.category))
  );

  const articles: NewsArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") articles.push(...r.value);
  }

  articles.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
  const deduped = articles.filter((a, i, arr) => arr.findIndex(x => x.title === a.title) === i);

  massCache = { articles: deduped, fetched: Date.now() };
  res.json(deduped);
});

router.get("/financial", async (_req, res) => {
  if (financeCache.articles.length > 0 && Date.now() - financeCache.fetched < CACHE_TTL) {
    res.json(financeCache.articles);
    return;
  }

  const results = await Promise.allSettled(
    FINANCE_FEEDS.map(f => fetchFeed(f.url, f.source, f.category))
  );

  const articles: NewsArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") articles.push(...r.value);
  }

  articles.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
  const deduped = articles.filter((a, i, arr) => arr.findIndex(x => x.title === a.title) === i);

  financeCache = { articles: deduped, fetched: Date.now() };
  res.json(deduped);
});

export default router;
