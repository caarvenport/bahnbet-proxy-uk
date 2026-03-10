/**
 * Fetches real-time train delay data from Darwin via Huxley2 REST proxy.
 *
 * Huxley2 (huxley2.azurewebsites.net) is a free, public JSON wrapper around
 * National Rail's Darwin LDBWS API. It returns departure boards in clean JSON
 * with no API key required.
 *
 * We poll ~15 major UK stations every 90s, filter to long-distance operators
 * (TOCs), and deduplicate by serviceID.
 */

const HUXLEY_BASE =
  process.env.HUXLEY_URL || "https://huxley2.azurewebsites.net";

// -- Long-distance TOC codes ------------------------------------------------

const LD_TOCS = new Set([
  "VT", // Avanti West Coast (London-Birmingham-Manchester-Glasgow)
  "GR", // LNER (London-Edinburgh/Leeds)
  "GW", // GWR (London-Bristol-Plymouth-Penzance)
  "XC", // CrossCountry (Birmingham-Edinburgh/Plymouth/Bournemouth)
  "TP", // TransPennine Express (Manchester-Leeds-Edinburgh)
  "EM", // East Midlands Railway (London-Sheffield-Nottingham)
  "HT", // Hull Trains (London-Hull)
  "GC", // Grand Central (London-Sunderland/Bradford)
  "LE", // Greater Anglia (London-Norwich)
  "ES", // Eurostar (London-Paris/Brussels)
  "LD", // Lumo (London-Edinburgh low-cost)
]);

// -- Major stations to poll -------------------------------------------------

const STATIONS = [
  "KGX", // London King's Cross
  "EUS", // London Euston
  "PAD", // London Paddington
  "WAT", // London Waterloo
  "BHM", // Birmingham New Street
  "MAN", // Manchester Piccadilly
  "LDS", // Leeds
  "EDB", // Edinburgh Waverley
  "GLC", // Glasgow Central
  "BRI", // Bristol Temple Meads
  "NCL", // Newcastle
  "YRK", // York
  "SHF", // Sheffield
  "PLY", // Plymouth
  "NRW", // Norwich
];

// -- Types ------------------------------------------------------------------

export interface TripUpdate {
  tripId: string;
  routeId: string;
  lineName: string;
  startDate: string; // YYYYMMDD
  startTime: string; // HH:MM (scheduled departure)
  runId: string; // "VT-1A23-20260310-1430"
  cancelled: boolean;
  departureDelaySec: number | null;
  arrivalDelaySec: number | null;
  currentDelaySec: number | null;
  trainNumber: string | null;
}

export interface FeedSnapshot {
  meta: {
    updatedAt: string;
    feedTimestamp: string;
    tripCount: number;
    totalEntities: number;
    stationsPolled: number;
    staticLoadedAt: string | null;
  };
  trips: Record<string, TripUpdate>;
}

// -- State ------------------------------------------------------------------

let latest: { json: string; data: FeedSnapshot } | null = null;

export function getSnapshot() {
  return latest;
}

// -- Huxley2 response types ------------------------------------------------

interface HuxleyService {
  serviceIdUrlSafe?: string;
  serviceID?: string;
  rsid?: string;
  std?: string;
  etd?: string;
  sta?: string;
  eta?: string;
  operator?: string;
  operatorCode?: string;
  platform?: string;
  trainid?: string;
  isCancelled?: boolean;
  destination?: Array<{ locationName?: string; crs?: string }>;
  origin?: Array<{ locationName?: string; crs?: string }>;
}

interface HuxleyResponse {
  trainServices?: HuxleyService[] | null;
  busServices?: unknown[] | null;
  generatedAt?: string;
  locationName?: string;
  crs?: string;
}

// -- Fetch & filter ---------------------------------------------------------

export async function fetchAndFilter(): Promise<void> {
  const t0 = Date.now();
  console.log(`[rt] Polling ${STATIONS.length} stations via Huxley2...`);

  // Build today's date string in UK timezone
  const now = new Date();
  const ukDate = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = ukDate.formatToParts(now);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  const todayStr = `${year}${month}${day}`;

  // Poll all stations concurrently (with concurrency limit)
  const allServices: HuxleyService[] = [];
  const CONCURRENCY = 5;
  let stationsPolled = 0;

  for (let i = 0; i < STATIONS.length; i += CONCURRENCY) {
    const batch = STATIONS.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((crs) => fetchDepartureBoard(crs)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        allServices.push(...result.value);
        stationsPolled++;
      } else {
        console.warn(`[rt] Station fetch failed: ${result.reason}`);
      }
    }
  }

  console.log(
    `[rt] Fetched ${allServices.length} raw services from ${stationsPolled} stations in ${Date.now() - t0}ms`,
  );

  // Filter to long-distance TOCs
  const ldServices = allServices.filter((s) =>
    LD_TOCS.has(s.operatorCode ?? ""),
  );

  // Deduplicate by serviceID (same train appears at multiple stations)
  const deduped = new Map<string, HuxleyService>();
  for (const svc of ldServices) {
    const id = svc.serviceIdUrlSafe ?? svc.serviceID ?? "";
    if (!id) continue;
    if (!deduped.has(id)) {
      deduped.set(id, svc);
    }
  }

  // Build trip updates
  const trips: Record<string, TripUpdate> = {};
  for (const [serviceID, svc] of deduped) {
    const std = svc.std ?? "";
    const etd = svc.etd ?? "";
    const delaySec = parseDelay(std, etd);
    const cancelled = svc.isCancelled === true || etd === "Cancelled";

    const operatorCode = svc.operatorCode ?? "";
    const trainNum = svc.rsid ?? svc.trainid ?? "";
    const headcode = svc.trainid ?? "";
    const dest = svc.destination?.[0]?.locationName ?? "Unknown";

    const lineName = headcode
      ? `${operatorCode} ${headcode}`
      : `${operatorCode} to ${dest}`;

    const depHHMM = std.replace(":", "");
    const runId =
      operatorCode && todayStr
        ? `${operatorCode}-${headcode || serviceID.slice(0, 8)}-${todayStr}-${depHHMM}`
        : "";

    const tripId = `darwin-${serviceID}`;

    trips[tripId] = {
      tripId,
      routeId: operatorCode,
      lineName,
      startDate: todayStr,
      startTime: std,
      runId,
      cancelled,
      departureDelaySec: delaySec,
      arrivalDelaySec: null,
      currentDelaySec: delaySec,
      trainNumber: trainNum || null,
    };
  }

  const tripCount = Object.keys(trips).length;

  const data: FeedSnapshot = {
    meta: {
      updatedAt: new Date().toISOString(),
      feedTimestamp: new Date().toISOString(),
      tripCount,
      totalEntities: allServices.length,
      stationsPolled,
      staticLoadedAt: null,
    },
    trips,
  };

  latest = { json: JSON.stringify(data), data };

  console.log(
    `[rt] ${tripCount} LD trains (${ldServices.length} LD services, ${allServices.length} total) in ${Date.now() - t0}ms`,
  );
}

// -- Huxley2 REST call ------------------------------------------------------

async function fetchDepartureBoard(crs: string): Promise<HuxleyService[]> {
  const url = `${HUXLEY_BASE}/departures/${crs}/50?expand=true`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Huxley ${crs} failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data: HuxleyResponse = await res.json();
  return data.trainServices ?? [];
}

// -- Delay parsing ----------------------------------------------------------

/**
 * Compute delay in seconds from scheduled departure (std) and estimated (etd).
 *
 * etd values:
 *   "On time"  -> 0 delay
 *   "HH:MM"    -> diff from std
 *   "Cancelled" -> null (handled separately via cancelled flag)
 *   "Delayed"  -> null (unknown delay)
 *   ""         -> null
 */
function parseDelay(std: string, etd: string): number | null {
  if (!std || !etd) return null;

  const etdLower = etd.toLowerCase().trim();

  if (etdLower === "on time") return 0;
  if (etdLower === "cancelled" || etdLower === "delayed" || etdLower === "") {
    return null;
  }

  const schedMin = parseTimeToMinutes(std);
  const estMin = parseTimeToMinutes(etd);
  if (schedMin === null || estMin === null) return null;

  let diffMin = estMin - schedMin;
  if (diffMin < -720) diffMin += 1440;
  if (diffMin < 0) diffMin = 0;

  return diffMin * 60;
}

function parseTimeToMinutes(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
