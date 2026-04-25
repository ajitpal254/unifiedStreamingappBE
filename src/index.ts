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
    const region = (req.query.region as string) || "US";

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
    // Remove duplicates (Watchmode sometimes lists SD/HD/4K separately)
    const uniqueSources = new Map();
    sources.forEach((s: any) => {
      if (["sub", "free"].includes(s.type)) {
        if (!uniqueSources.has(s.name) || s.type === "sub") {
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
    res.json({ userId });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ error: "Failed to sync user" });
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
    const { title, type, image, provider, tmdbId } = req.body;

    if (!title || !type || !provider) {
      res.status(400).json({ error: "title, type, and provider are required" });
      return;
    }

    await ensureUser(userId!);

    const newItem = await prisma.watchlistItem.create({
      data: {
        userId: userId!,
        title,
        type,
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

    const results = await Promise.all(
      providers.map((p) =>
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

app.listen(port, () => {
  console.log(`🚀 API server running on http://localhost:${port}`);
});
