/**
 * UK (National Rail) Train Delay Proxy
 *
 * Realtime: Polls Darwin LDBWS (Live Departure Boards Web Service) every 90s
 *           at ~15 major UK stations, filters to long-distance TOCs, deduplicates
 *           by serviceID, and computes delay from scheduled vs estimated times.
 *
 * No static GTFS feed -- the UK doesn't publish a standard GTFS. All data comes
 * from Darwin departure boards.
 *
 * Env vars:
 *   DARWIN_API_KEY — Darwin LDBWS access token (register at
 *                    https://realtime.nationalrail.co.uk/OpenLDBWSRegistration)
 *   PORT           — HTTP port (default 3001)
 *
 * Long-distance TOCs polled:
 *   VT (Avanti West Coast), GR (LNER), GW (GWR), XC (CrossCountry),
 *   TP (TransPennine Express), EM (East Midlands), HT (Hull Trains),
 *   GC (Grand Central), LE (Greater Anglia), ES (Eurostar)
 *
 * Designed for Railway free tier: 0.5 vCPU, 512 MB RAM.
 */

import http from "node:http";
import { fetchAndFilter, getSnapshot } from "./realtime-feed.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const RT_INTERVAL = 90_000; // poll Darwin every 90s

// -- Main -------------------------------------------------------------------

async function main() {
  console.log("[proxy-uk] National Rail Darwin Proxy starting...");

  // 1. Start HTTP server immediately so healthcheck passes during data load
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    // GET /feed -- filtered long-distance train data
    if (url.pathname === "/feed" && req.method === "GET") {
      const snap = getSnapshot();
      if (!snap) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":"No data available yet"}');
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30",
      });
      res.end(snap.json);
      return;
    }

    // GET /health -- service status
    if (url.pathname === "/health") {
      const snap = getSnapshot();
      const now = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          country: "UK",
          uptime: Math.floor(process.uptime()),
          lastUpdate: snap?.data.meta.updatedAt ?? null,
          tripCount: snap?.data.meta.tripCount ?? 0,
          stationsPolled: snap?.data.meta.stationsPolled ?? 0,
          ageSeconds: snap
            ? Math.floor(
                (now - new Date(snap.data.meta.updatedAt).getTime()) / 1000,
              )
            : null,
          memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"Not found"}');
  });

  server.listen(PORT, () => {
    console.log(`[proxy-uk] Listening on :${PORT}`);
  });

  // 2. First Darwin fetch
  try {
    await fetchAndFilter();
  } catch (err) {
    console.error(
      "[rt] Initial fetch failed (will retry on schedule):",
      err,
    );
  }

  // 3. Periodic refresh
  setInterval(async () => {
    try {
      await fetchAndFilter();
    } catch (err) {
      console.error("[rt] Fetch error:", (err as Error).message);
    }
  }, RT_INTERVAL);
}

main().catch((err) => {
  console.error("[proxy-uk] Fatal:", err);
  process.exit(1);
});
