import { getStore } from "@netlify/blobs";
import type { AutomationLog, Profile, Run } from "./types.ts";

const runs = () => getStore({ name: "runs", consistency: "strong" });
const profiles = () => getStore({ name: "profiles", consistency: "strong" });
const automation = () => getStore({ name: "automation", consistency: "strong" });
const locks = () => getStore({ name: "locks", consistency: "strong" });

/** Time-ordered, unguessable id (timestamp prefix keeps keys sortable). */
export const newId = () => Date.now().toString(36).padStart(9, "0") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

// Runs are stored under their owner's id, so a run can only be read through its owner.
const runKey = (profileId: string, runId: string) => `${profileId}/${runId}`;
const validId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);

export async function getRun(profileId: string, runId: string): Promise<Run | null> {
  if (!validId(profileId) || !validId(runId)) return null;
  return (await runs().get(runKey(profileId, runId), { type: "json" })) as Run | null;
}

export async function saveRun(run: Run): Promise<void> {
  await runs().setJSON(runKey(run.profileId, run.id), run);
}

/** The newest `limit` runs for one user. Only reads the blobs it returns. */
export async function listRunsFor(profileId: string, limit = 10): Promise<Run[]> {
  if (!validId(profileId)) return [];
  const { blobs } = await runs().list({ prefix: `${profileId}/` });
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  const all = await Promise.all(keys.map((k) => runs().get(k, { type: "json" }) as Promise<Run | null>));
  return all.filter((r): r is Run => !!r);
}

export async function getProfile(id: string): Promise<Profile | null> {
  if (!validId(id)) return null;
  return (await profiles().get(id, { type: "json" })) as Profile | null;
}

export async function saveProfile(p: Profile): Promise<void> {
  await profiles().setJSON(p.id, p);
}

export async function listProfiles(): Promise<Profile[]> {
  const { blobs } = await profiles().list();
  const all = await Promise.all(blobs.map((b) => getProfile(b.key)));
  return all.filter((p): p is Profile => !!p);
}

export async function saveAutomationLog(log: AutomationLog): Promise<void> {
  await automation().setJSON(log.id, log);
}

export async function listAutomationLogs(limit = 10): Promise<AutomationLog[]> {
  const { blobs } = await automation().list();
  const keys = blobs.map((b) => b.key).sort().reverse();
  const out: AutomationLog[] = [];
  // Keys are time-ordered, so read newest first and stop once we have enough.
  for (let i = 0; i < keys.length && out.length < limit; i += 10) {
    const batch = await Promise.all(keys.slice(i, i + 10).map((k) => automation().get(k, { type: "json" }) as Promise<AutomationLog | null>));
    out.push(...batch.filter((l): l is AutomationLog => !!l));
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

/**
 * Takes a named lock so overlapping jobs can't run at once. Locks older than `staleMs`
 * (a crashed run) can be taken over. Returns a release function, or null if the lock is held.
 */
export async function acquireLock(name: string, staleMs = 20 * 60 * 1000): Promise<(() => Promise<void>) | null> {
  const store = locks();
  const token = crypto.randomUUID();
  const value = { token, at: Date.now() };
  let res = await store.setJSON(name, value, { onlyIfNew: true });
  if (!res.modified) {
    const cur = await store.getWithMetadata(name, { type: "json" });
    if (cur && Date.now() - Number((cur.data as any)?.at ?? 0) > staleMs) {
      res = await store.setJSON(name, value, { onlyIfMatch: cur.etag! });
    } else if (!cur) {
      res = await store.setJSON(name, value, { onlyIfNew: true });
    }
  }
  if (!res.modified) return null;
  return async () => {
    const cur = (await store.get(name, { type: "json" })) as any;
    if (cur?.token === token) await store.delete(name);
  };
}
