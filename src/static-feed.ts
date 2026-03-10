/**
 * No GTFS static feed for UK — data comes from Darwin LDBWS via Huxley2.
 * This module exports a no-op getStopName for interface compatibility.
 */

export function getStopName(_stopId: string): string | undefined {
  return undefined;
}
