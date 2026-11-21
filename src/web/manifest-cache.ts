import { loadRemote, type Manifest } from "../storage/manifest.js";

/** Finished manifests for the playback page, kept 60 s. */
const manifestCache = new Map<string, { at: number; m: Manifest | undefined }>();
export async function getManifest(id: string): Promise<Manifest | undefined> {
  const hit = manifestCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.m;
  const m = await loadRemote(id);
  // Only finished meetings are cached: the link is posted just before the "done" status is saved.
  if (m?.status === "done") manifestCache.set(id, { at: Date.now(), m });
  return m;
}

/** Drops a cached manifest after it changed (a new PIN). */
export function forgetManifest(id: string): void {
  manifestCache.delete(id);
}
