import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { PrismaClient } from "@prisma/client";

// Initialize Prisma
const prisma = new PrismaClient();

const app = express();
const port = process.env.PORT || 4000;
const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const WATCHMODE_KEY = process.env.WATCHMODE_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const WATCHMODE_BASE = "https://api.watchmode.com/v1";

const PROVIDER_MAPPING: Record<string, number> = {
  "Netflix": 203,
  "Prime Video": 26,
  "Disney+": 372,
  "Hulu": 157,
  "HBO Max": 387,
  "Apple TV+": 371,
  "Paramount+": 444,
  "Peacock": 389,
  "YouTube TV": 343,
  "Discovery+": 445
};

type WatchmodeListTitle = {
  tmdb_id: number;
  type: "movie" | "tv";
  title: string;
  poster_path?: string | null;
};

type WatchmodeSource = {
  name: string;
  type: string;
  web_url: string;
  format: string;
  price?: number | null;
};

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());
app.use(clerkMiddleware());

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

async function ensureUser(userId: string, email?: string) {
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      email: email ?? `${userId}@clerk.user`,
    },
  });
}

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
  if (!TMDB_TOKEN) throw new Error("TMDB_ACCESS_TOKEN not set");
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  });
  if (!res.ok) throw new Error(`TMDB error: ${res.status}`);
  return res.json();
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "unified-streaming-hub-api" });
});

// ─── TMDB Search & Discovery ──────────────────────────────────────────────────

// GET /api/search?q=...&page=1  — multi search (movies + tv)
app.get("/api/search", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = String(req.query.page || "1");
    if (!q) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }
    const data = await tmdbFetch("/search/multi", { query: q, page, include_adult: "false" });
    // Filter to only movies and tv shows
    data.results = data.results.filter(
      (r: { media_type: string }) => r.media_type === "movie" || r.media_type === "tv"
    );
    res.json(data);
  } catch (error) {
    console.error("TMDB search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
});
app.get("/api/titles/recommended", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    
    // 1. Get user's active providers
    const userProviders = await prisma.provider.findMany({
      where: { userId: userId!, isActive: true }
    });

    if (userProviders.length === 0) {
      return res.json({ results: [] });
    }

    // 2. Map names to Watchmode IDs
    const sourceIds = userProviders
      .map(p => PROVIDER_MAPPING[p.provider])
      .filter(id => id !== undefined)
      .join(",");

    if (!sourceIds) return res.json({ results: [] });

    // 3. Fetch from Watchmode List endpoint
    const response = await fetch(
      `${WATCHMODE_BASE}/list-titles/?apiKey=${WATCHMODE_KEY}&source_ids=${sourceIds}&types=movie,tv&sort=popularity_desc&limit=20`
    );
    const data = await response.json();

    // 4. Map to a clean format (Watchmode results differ from TMDB)
    const results = data.titles.map((t: WatchmodeListTitle) => ({
      id: t.tmdb_id,
      media_type: t.type === "movie" ? "movie" : "tv",
      title: t.title,
      poster_path: t.poster_path, // Note: Watchmode provides full URLs often
      vote_average: 0, // Watchmode list doesn't include rating
      isRecommended: true
    }));

    res.json({ results });
  } catch (error) {
    console.error("Recommendations error:", error);
    res.status(500).json({ error: "Failed to fetch recommendations" });
  }
});

// GET /api/titles/personalized — recommendations based on watchlist
app.get("/api/titles/personalized", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    
    // 1. Get recent watchlist items (last 3)
    const watchlist = await prisma.watchlistItem.findMany({
      where: { userId: userId! },
      orderBy: { addedAt: "desc" },
      take: 3
    });

    if (watchlist.length === 0) {
      return res.json({ results: [], reason: "No watchlist items" });
    }

    // 2. Fetch similar titles from TMDB for each watchlist item
    const allRecommendations = await Promise.all(
      watchlist.map(async (item) => {
        try {
          const type = item.tmdbType === "Series" ? "tv" : "movie";
          const data = await tmdbFetch(`/${type}/${item.tmdbId}/similar`);
          return (data.results || []).map((r: any) => ({
            ...r,
            media_type: r.media_type || (item.tmdbType === "Series" ? "tv" : "movie"),
            basedOn: item.title
          }));
        } catch (e) {
          return [];
        }
      })
    );

    // 3. Flatten, deduplicate, and filter out items already in watchlist
    const watchlistIds = new Set(watchlist.map(i => i.tmdbId));
    const flatResults = allRecommendations.flat();
    
    const uniqueResults = new Map();
    flatResults.forEach(item => {
      if (!watchlistIds.has(item.id) && !uniqueResults.has(item.id)) {
        uniqueResults.set(item.id, item);
      }
    });

    // 4. Return top 15 results
    const results = Array.from(uniqueResults.values())
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 15);

    res.json({ 
      results,
      basedOn: watchlist[0].title // Primary reference for the UI
    });
  } catch (error) {
    console.error("Personalized recommendations error:", error);
    res.status(500).json({ error: "Failed to fetch personalized recommendations" });
  }
});

// GET /api/titles/trending  — trending this week
app.get("/api/titles/trending", async (_req, res: Response) => {
  try {
    const data = await tmdbFetch("/trending/all/week");
    res.json(data);
  } catch (error) {
    console.error("TMDB trending error:", error);
    res.status(500).json({ error: "Failed to fetch trending" });
  }
});

// GET /api/titles/:type/:id  — title details (type: movie | tv)
app.get("/api/titles/:type/:id", async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    if (type !== "movie" && type !== "tv") {
      res.status(400).json({ error: "type must be 'movie' or 'tv'" });
      return;
    }
    const [details, credits, videos] = await Promise.all([
      tmdbFetch(`/${type}/${id}`, { append_to_response: "genres" }),
      tmdbFetch(`/${type}/${id}/credits`),
      tmdbFetch(`/${type}/${id}/videos`),
    ]);
    res.json({
      ...details,
      credits: {
        cast: credits.cast?.slice(0, 10) ?? [],
        crew: credits.crew?.filter((c: { job: string }) => ["Director", "Creator"].includes(c.job)) ?? [],
      },
      trailer: videos.results?.find(
        (v: { site: string; type: string }) => v.site === "YouTube" && v.type === "Trailer"
      ) ?? null,
    });
  } catch (error) {
    console.error("TMDB title detail error:", error);
    res.status(500).json({ error: "Failed to fetch title details" });
  }
});

// GET /api/titles/:type/:id/availability  — where to watch
app.get("/api/titles/:type/:id/availability", async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    let region = (req.query.region as string) || "US";

    // If authenticated, try to use user's preferred region
    const auth = getAuth(req);
    if (auth.userId) {
      const user = await prisma.user.findUnique({ where: { id: auth.userId } });
      if (user?.region) region = user.region;
    }

    if (!WATCHMODE_KEY) {
      res.status(500).json({ error: "Watchmode API key not configured" });
      return;
    }

    // Watchmode uses tmdb-{id} format for direct lookup
    // type: movie or tv
    const watchmodeId = `${type === "movie" ? "movie" : "tv"}-${id}`;
    
    const response = await fetch(
      `${WATCHMODE_BASE}/title/${watchmodeId}/sources/?apiKey=${WATCHMODE_KEY}&regions=${region}`
    );

    if (!response.ok) {
      // If title not found in Watchmode, return empty results instead of crashing
      if (response.status === 404) return res.json([]);
      throw new Error(`Watchmode error: ${response.status}`);
    }

    const sources = await response.json();
    
    // Clean up results: only show "sub" (subscription) or "free" sources
    const uniqueSources = new Map();
    
    // Sort sources: prioritize "sub" over "free", and specifically check for "Prime Video"
    const sortedSources = (sources as WatchmodeSource[]).sort((a, b) => {
      if (a.name === "Prime Video") return -1;
      if (b.name === "Prime Video") return 1;
      return 0;
    });

    sortedSources.forEach((s) => {
      // Filter out generic Amazon store links if they are "buy/rent" 
      // but keep them if they are the only source
      if (["sub", "free"].includes(s.type)) {
        if (!uniqueSources.has(s.name)) {
          uniqueSources.set(s.name, {
            name: s.name,
            type: s.type,
            url: s.web_url,
            format: s.format,
            price: s.price
          });
        }
      }
    });

    res.json(Array.from(uniqueSources.values()));
  } catch (error) {
    console.error("Watchmode availability error:", error);
    res.status(500).json({ error: "Failed to fetch availability" });
  }
});
app.get("/api/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    await ensureUser(userId!);
    const user = await prisma.user.findUnique({
      where: { id: userId! },
      include: { providers: true }
    });
    res.json(user);
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

app.patch("/api/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { region } = req.body;
    await ensureUser(userId!);
    const user = await prisma.user.update({
      where: { id: userId! },
      data: { region }
    });
    res.json(user);
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ error: "Failed to update region" });
  }
});

// ─── Watchlist ────────────────────────────────────────────────────────────────
app.get("/api/watchlist", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    await ensureUser(userId!);
    const watchlist = await prisma.watchlistItem.findMany({
      where: { userId: userId! },
      orderBy: { addedAt: "desc" },
    });
    res.json(watchlist);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

app.post("/api/watchlist", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { title, type, image, provider, tmdbId, tmdbType } = req.body;

    if (!title || !type || !provider || !tmdbId || !tmdbType) {
      res.status(400).json({ error: "title, type, provider, tmdbId, and tmdbType are required" });
      return;
    }

    if (tmdbType !== "movie" && tmdbType !== "tv") {
      res.status(400).json({ error: "tmdbType must be 'movie' or 'tv'" });
      return;
    }

    const parsedTmdbId = Number(tmdbId);
    if (!Number.isInteger(parsedTmdbId) || parsedTmdbId <= 0) {
      res.status(400).json({ error: "tmdbId must be a positive integer" });
      return;
    }

    await ensureUser(userId!);

    const existingItem = await prisma.watchlistItem.findFirst({
      where: {
        userId: userId!,
        tmdbType,
        tmdbId: parsedTmdbId,
      },
    });

    const newItem = existingItem
      ? await prisma.watchlistItem.update({
          where: { id: existingItem.id },
          data: {
            title,
            type,
            image,
            provider,
          },
        })
      : await prisma.watchlistItem.create({
          data: {
            userId: userId!,
            title,
            type,
            tmdbId: parsedTmdbId,
            tmdbType,
            image,
            provider,
            progress: 0,
          },
        });

    res.status(201).json(newItem);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to add to watchlist" });
  }
});

app.delete("/api/watchlist/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { id } = req.params;

    const item = await prisma.watchlistItem.findUnique({ where: { id } });
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    if (item.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    await prisma.watchlistItem.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to remove from watchlist" });
  }
});

// ─── Providers ────────────────────────────────────────────────────────────────
app.get("/api/providers", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const providers = await prisma.provider.findMany({
      where: { userId: userId!, isActive: true },
    });
    res.json(providers);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to fetch providers" });
  }
});

app.post("/api/providers", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { providers }: { providers: string[] } = req.body;

    if (!Array.isArray(providers)) {
      res.status(400).json({ error: "providers must be an array" });
      return;
    }

    await ensureUser(userId!);

    const uniqueProviders = [...new Set(providers)];

    await prisma.provider.updateMany({
      where: {
        userId: userId!,
        provider: { notIn: uniqueProviders },
        isActive: true,
      },
      data: { isActive: false },
    });

    const results = await Promise.all(
      uniqueProviders.map((p) =>
        prisma.provider.upsert({
          where: { userId_provider: { userId: userId!, provider: p } },
          update: { isActive: true },
          create: { userId: userId!, provider: p, isActive: true },
        })
      )
    );

    res.json(results);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to save providers" });
  }
});

// ─── Tracking ────────────────────────────────────────────────────────────────
app.post("/api/tracking/click", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { title, provider, url, tmdbId, tmdbType } = req.body;

    // Log to console for now, but in a real app this would go to a Tracking table
    console.log(`[CLICK_TRACKING] User ${userId} clicked ${provider} for "${title}" (${tmdbType}:${tmdbId}) -> ${url}`);
    
    // Optional: Save to DB if you have a Tracking model
    // await prisma.clickTrack.create({ data: { userId, title, provider, url, tmdbId, tmdbType } });

    res.json({ success: true });
  } catch (error) {
    console.error("Tracking error:", error);
    res.status(500).json({ error: "Failed to track click" });
  }
});

app.listen(port, () => {
  console.log(`🚀 API server running on http://localhost:${port}`);
});
