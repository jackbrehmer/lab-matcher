import { timingSafeEqual } from "node:crypto";
import { fitAnalyst, labScout, outreachWriter } from "./agents.ts";
import { getProfile, getRun, saveProfile, saveRun } from "./store.ts";
import type { Run, TraceEvent } from "./types.ts";

const sameToken = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Errors written by our own code that are safe and useful to show the student. */
class UserFacingError extends Error {}

/** Runs Scout -> Fit Analyst -> Writer, persisting after every event so the UI can poll progress. */
export async function runPipeline(profileId: string, runId: string, token: string): Promise<void> {
  const run = await getRun(profileId, runId);
  if (!run || run.status !== "queued" || !run.startToken || !sameToken(run.startToken, token)) {
    console.warn(`Refused to start run ${runId}: not queued or bad token`);
    return;
  }
  delete run.startToken; // single use
  await saveRun(run);

  const profile = await getProfile(run.profileId);
  if (!profile) {
    run.status = "error";
    run.error = "Your profile could not be loaded. Please start a new search.";
    await saveRun(run);
    return;
  }

  let saving: Promise<void> = Promise.resolve();
  const persist = () => {
    saving = saving.then(() => saveRun(run)).catch(() => {});
    return saving;
  };
  const emit = async (e: Omit<TraceEvent, "t">) => {
    run.trace.push({ ...e, t: Date.now() });
    await persist();
  };
  const stage = async (status: Run["status"], text: string) => {
    run.status = status;
    await emit({ agent: "system", kind: "status", text });
  };

  try {
    await stage("scout", "Lab Scout started");
    run.candidates = await labScout(profile, emit);
    await emit({ agent: "scout", kind: "decision", text: `Shortlisted ${run.candidates.length}: ${run.candidates.map((c) => c.name).join(", ")}` });
    if (run.candidates.length === 0) throw new UserFacingError("We couldn't find CU Boulder professors for those interests. Try broader interests.");

    await stage("fit", "Fit Analyst started");
    const { matches, rejected } = await fitAnalyst(profile, run.candidates, emit);
    run.matches = matches;
    run.rejected = rejected;
    await emit({
      agent: "fit",
      kind: "decision",
      text: `${matches.length} matches scored 6+ (${matches.map((m) => `${m.name} ${m.score}/10`).join(", ")}); ${rejected.length} rejected`,
    });

    await stage("writer", "Outreach Writer started");
    run.matches = await outreachWriter(profile, matches, emit);
    const flagged = run.matches.filter((m) => !m.email?.verified).length;
    await emit({ agent: "writer", kind: "decision", text: `${run.matches.length} drafts written, ${flagged} flagged by guardrails for review` });

    run.status = "done";
    run.finishedAt = new Date().toISOString();
    await emit({ agent: "system", kind: "status", text: "Done. Review each draft before sending." });
    profile.latestRunId = run.id;
    await saveProfile(profile);
  } catch (e: any) {
    // Full details go to the function logs only; the stored run gets a generic message.
    console.error(`Run ${run.id} failed:`, e);
    run.status = "error";
    run.error = e instanceof UserFacingError ? e.message : "Something went wrong while searching. Please try again in a few minutes.";
    run.finishedAt = new Date().toISOString();
    await emit({ agent: "system", kind: "error", text: run.error });
  }
  await saving;
}
