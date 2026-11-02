import { getStore } from "@netlify/blobs";
import type { AutomationLog, Profile, Run } from "./types.ts";

const runs = () => getStore({ name: "runs", consistency: "strong" });
const profiles = () => getStore({ name: "profiles", consistency: "strong" });
const automation = () => getStore({ name: "automation", consistency: "strong" });

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function getRun(id: string): Promise<Run | null> {
  return (await runs().get(id, { type: "json" })) as Run | null;
}

export async function saveRun(run: Run): Promise<void> {
  await runs().setJSON(run.id, run);
}

export async function listRuns(): Promise<Run[]> {
  const { blobs } = await runs().list();
  const all = await Promise.all(blobs.map((b) => getRun(b.key)));
  return all.filter((r): r is Run => !!r);
}

export async function getProfile(id: string): Promise<Profile | null> {
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

export async function listAutomationLogs(): Promise<AutomationLog[]> {
  const { blobs } = await automation().list();
  const all = await Promise.all(
    blobs.map((b) => automation().get(b.key, { type: "json" }) as Promise<AutomationLog | null>)
  );
  return all
    .filter((l): l is AutomationLog => !!l)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
