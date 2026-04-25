import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { PrismaClient } from "@prisma/client";

// Initialize Prisma
const prisma = new PrismaClient();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());
app.use(clerkMiddleware());

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "unified-streaming-hub-api" });
});

// ─── Ensure user exists in DB (called after Clerk auth) ──────────────────────
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

// ─── Watchlist routes ─────────────────────────────────────────────────────────

// GET /api/me — sync Clerk user to DB (call this after sign-in)
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

// GET /api/watchlist — fetch the signed-in user's watchlist
app.get("/api/watchlist", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    // Ensure user exists in DB (lazy sync on first load)
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

// POST /api/watchlist — add an item
app.post("/api/watchlist", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { title, type, image, provider } = req.body;

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

// DELETE /api/watchlist/:id — remove an item (only owner can delete)
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

// ─── Provider preference routes ───────────────────────────────────────────────

// GET /api/providers — fetch user's active providers
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

// POST /api/providers — save provider selections
app.post("/api/providers", requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { providers }: { providers: string[] } = req.body;

    if (!Array.isArray(providers)) {
      res.status(400).json({ error: "providers must be an array" });
      return;
    }

    await ensureUser(userId!);

    // Upsert each provider
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
