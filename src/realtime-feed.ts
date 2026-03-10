/**
 * Fetches real-time train delay data from Darwin LDBWS (Live Departure Boards).
 *
 * Darwin is National Rail's official real-time API. It provides departure/arrival
 * boards per station via a SOAP/XML endpoint. We poll ~15 major UK stations every
 * 90s, filter to long-distance operators (TOCs), and deduplicate by serviceID.
 *
 * The SOAP envelope is simple enough to build by hand -- no XML library needed.
 * Responses are parsed with regex extraction (the XML structure is predictable).
 *
 * Requires DARWIN_API_KEY env var (register at realtime.nationalrail.co.uk).
 */

const API_KEY = process.env.DARWIN_API_KEY || "";
const DARWIN_URL =
  "https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb12.asmx";

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

// -- Darwin service record from XML -----------------------------------------

interface DarwinService {
  serviceID: string;
  rsid: string; // Retail Service ID (e.g. "VT123400")
  std: string; // Scheduled time of departure "HH:MM"
  etd: string; // "On time", "HH:MM", "Cancelled", "Delayed"
  sta: string; // Scheduled time of arrival (at this station)
  eta: string; // Estimated time of arrival
  operator: string; // e.g. "Avanti West Coast"
  operatorCode: string; // e.g. "VT"
  platform: string;
  destinations: string[]; // destination station names
  origins: string[]; // origin station names
  trainid: string; // headcode / train identity (e.g. "1A23")
  isCancelled: boolean;
}

// -- Fetch & filter ---------------------------------------------------------

export async function fetchAndFilter(): Promise<void> {
  if (!API_KEY) {
    console.warn("[rt] DARWIN_API_KEY not set -- skipping RT fetch");
    return;
  }

  const t0 = Date.now();
  console.log(`[rt] Polling ${STATIONS.length} stations via Darwin LDBWS...`);

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
  const allServices: DarwinService[] = [];
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
  const ldServices = allServices.filter((s) => LD_TOCS.has(s.operatorCode));

  // Deduplicate by serviceID (same train appears at multiple stations)
  const deduped = new Map<string, DarwinService>();
  for (const svc of ldServices) {
    if (!svc.serviceID) continue;
    // Keep the first occurrence (origin station is typically polled first)
    if (!deduped.has(svc.serviceID)) {
      deduped.set(svc.serviceID, svc);
    }
  }

  // Build trip updates
  const trips: Record<string, TripUpdate> = {};
  for (const [serviceID, svc] of deduped) {
    const delaySec = parseDelay(svc.std, svc.etd);
    const cancelled = svc.isCancelled || svc.etd === "Cancelled";

    // Train identity: prefer rsid, fall back to trainid (headcode)
    const trainNum = svc.rsid || svc.trainid || "";
    const dest =
      svc.destinations.length > 0 ? svc.destinations[0] : "Unknown";

    // lineName: "VT 1A23 to Manchester Piccadilly" or "LNER to Edinburgh"
    const headcode = svc.trainid || "";
    const lineName = headcode
      ? `${svc.operatorCode} ${headcode}`
      : `${svc.operatorCode} to ${dest}`;

    // runId: "VT-1A23-20260310-1430"
    const depHHMM = svc.std.replace(":", "");
    const runId =
      svc.operatorCode && todayStr
        ? `${svc.operatorCode}-${headcode || serviceID.slice(0, 8)}-${todayStr}-${depHHMM}`
        : "";

    // tripId: use serviceID (Darwin's unique identifier for this service today)
    const tripId = `darwin-${serviceID}`;

    trips[tripId] = {
      tripId,
      routeId: svc.operatorCode,
      lineName,
      startDate: todayStr,
      startTime: svc.std,
      runId,
      cancelled,
      departureDelaySec: delaySec,
      arrivalDelaySec: null, // departure boards don't give arrival delay at final dest
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

// -- Darwin LDBWS SOAP call -------------------------------------------------

async function fetchDepartureBoard(crs: string): Promise<DarwinService[]> {
  const soapBody = buildSoapEnvelope(crs);

  const res = await fetch(DARWIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction:
        "http://thalesgroup.com/RTTI/2012-01-13/ldb/GetDepartureBoardByCRS",
    },
    body: soapBody,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Darwin ${crs} failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const xml = await res.text();
  return parseServicesFromXml(xml);
}

function buildSoapEnvelope(crs: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:typ="http://thalesgroup.com/RTTI/2013-11-28/Token/types"
               xmlns:ldb="http://thalesgroup.com/RTTI/2017-10-01/ldb/">
  <soap:Header>
    <typ:AccessToken>
      <typ:TokenValue>${escapeXml(API_KEY)}</typ:TokenValue>
    </typ:AccessToken>
  </soap:Header>
  <soap:Body>
    <ldb:GetDepartureBoardRequest>
      <ldb:numRows>50</ldb:numRows>
      <ldb:crs>${escapeXml(crs)}</ldb:crs>
      <ldb:timeWindow>120</ldb:timeWindow>
    </ldb:GetDepartureBoardRequest>
  </soap:Body>
</soap:Envelope>`;
}

// -- XML parsing (regex-based, no dependencies) -----------------------------

function parseServicesFromXml(xml: string): DarwinService[] {
  const services: DarwinService[] = [];

  // Extract each <lt7:service>...</lt7:service> block
  // Darwin uses various namespace prefixes (lt7, lt5, lt4, lt, etc.)
  // Match any namespace prefix for the service element
  const serviceRegex =
    /<(?:[a-z0-9]+:)?service>([\s\S]*?)<\/(?:[a-z0-9]+:)?service>/gi;
  let match: RegExpExecArray | null;

  while ((match = serviceRegex.exec(xml)) !== null) {
    const block = match[1];
    const svc = parseServiceBlock(block);
    if (svc) {
      services.push(svc);
    }
  }

  return services;
}

function parseServiceBlock(block: string): DarwinService | null {
  const serviceID = extractTag(block, "serviceID");
  if (!serviceID) return null;

  const std = extractTag(block, "std") || "";
  const etd = extractTag(block, "etd") || "";
  const sta = extractTag(block, "sta") || "";
  const eta = extractTag(block, "eta") || "";
  const operator = extractTag(block, "operator") || "";
  const operatorCode = extractTag(block, "operatorCode") || "";
  const platform = extractTag(block, "platform") || "";
  const rsid = extractTag(block, "rsid") || "";
  const trainid = extractTag(block, "trainid") || "";
  const isCancelled =
    extractTag(block, "isCancelled")?.toLowerCase() === "true" ||
    extractTag(block, "cancelReason") !== null;

  // Extract destination names
  const destinations = extractLocationNames(block, "destination");
  // Extract origin names
  const origins = extractLocationNames(block, "origin");

  return {
    serviceID,
    rsid,
    std,
    etd,
    sta,
    eta,
    operator,
    operatorCode,
    platform,
    destinations,
    origins,
    trainid,
    isCancelled,
  };
}

/**
 * Extract a tag value, handling any namespace prefix.
 * e.g. <lt4:std>14:30</lt4:std> or <std>14:30</std>
 */
function extractTag(xml: string, tagName: string): string | null {
  const regex = new RegExp(
    `<(?:[a-z0-9]+:)?${tagName}>([\\s\\S]*?)<\\/(?:[a-z0-9]+:)?${tagName}>`,
    "i",
  );
  const m = regex.exec(xml);
  return m ? m[1].trim() : null;
}

/**
 * Extract location names from <destination> or <origin> blocks.
 * These contain <location> elements with <locationName> children.
 */
function extractLocationNames(
  xml: string,
  containerTag: string,
): string[] {
  const names: string[] = [];
  // Find the container block (e.g. <lt5:destination>...</lt5:destination>)
  const containerRegex = new RegExp(
    `<(?:[a-z0-9]+:)?${containerTag}>([\\s\\S]*?)<\\/(?:[a-z0-9]+:)?${containerTag}>`,
    "i",
  );
  const containerMatch = containerRegex.exec(xml);
  if (!containerMatch) return names;

  const inner = containerMatch[1];
  // Extract each locationName
  const nameRegex =
    /<(?:[a-z0-9]+:)?locationName>([^<]+)<\/(?:[a-z0-9]+:)?locationName>/gi;
  let m: RegExpExecArray | null;
  while ((m = nameRegex.exec(inner)) !== null) {
    names.push(m[1].trim());
  }
  return names;
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

  // etd is "HH:MM" -- compute difference from std
  const schedMin = parseTimeToMinutes(std);
  const estMin = parseTimeToMinutes(etd);
  if (schedMin === null || estMin === null) return null;

  let diffMin = estMin - schedMin;

  // Handle midnight crossing: if estimated is much earlier than scheduled,
  // it's likely the next day (e.g. scheduled 23:50, estimated 00:05 = +15 min)
  if (diffMin < -720) {
    diffMin += 1440;
  }
  // If diff is hugely negative (e.g. -5), it might be rounding or early arrival
  // but Darwin doesn't report early departures this way, so clamp to 0
  if (diffMin < 0) {
    diffMin = 0;
  }

  return diffMin * 60; // convert to seconds
}

function parseTimeToMinutes(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// -- Helpers ----------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
