import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/czlient";

// Initialize Prisma
const prisma = new PrismaClient();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "unified-streaming-hub-api" });
});

app.get("/api/watchlist", async (req, res) => {
  try {
    const watchlist = await prisma.watchlistItem.findMany({
      orderBy: { addedAt: "desc" }
    });

    if (watchlist.length === 0) {
      return res.json([
        { id: "1", title: "Dune: Part Two", type: "Movie", progress: 0, image: "https://images.unsplash.com/photo-1534447677768-be436bb09401?q=80&w=800&auto=format&fit=crop", provider: "max", addedAt: new Date().toISOString() },
        { id: "2", title: "Shogun", type: "Series", progress: 45, image: "https://images.unsplash.com/photo-1578589318433-39b511d5633f?q=80&w=800&auto=format&fit=crop", provider: "hulu", addedAt: new Date().toISOString() },
      ]);
    }

    res.json(watchlist);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

app.post("/api/watchlist", async (req, res) => {
  try {
    const { title, type, image, provider } = req.body;

    // In a real app, userId would come from Clerk tokens
    const mockUserId = "user_123";

    // Create a mock user if it doesn't exist just to satisfy foreign key constraints for this demo
    await prisma.user.upsert({
      where: { id: mockUserId },
      update: {},
      create: { id: mockUserId, email: "demo@example.com" }
    });

    const newItem = await prisma.watchlistItem.create({
      data: {
        userId: mockUserId,
        title,
        type,
        image,
        provider,
        progress: 0,
      }
    });

    res.status(201).json(newItem);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to add to watchlist" });
  }
});

app.delete("/api/watchlist/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.watchlistItem.delete({
      where: { id }
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to remove from watchlist" });
  }
});

app.listen(port, () => {
  console.log(`🚀 API server is running on http://localhost:${port}`);
});
