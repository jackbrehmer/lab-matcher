import { fitAnalyst, labScout, outreachWriter } from "./agents.ts";
import { getProfile, getRun, saveRun } from "./store.ts";
import type { Run, TraceEvent } from "./types.ts";

/** Runs Scout -> Fit Analyst -> Writer, persisting the trace after every event so the UI can poll it live. */
export async function runPipeline(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const profile = await getProfile(run.profileId);
  if (!profile) throw new Error(`Profile ${run.profileId} not found`);

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
    if (run.candidates.length === 0) throw new Error("Lab Scout found no CU candidates. Try broader interests.");

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
  } catch (e: any) {
    run.status = "error";
    run.error = String(e.message ?? e);
    run.finishedAt = new Date().toISOString();
    await emit({ agent: "system", kind: "error", text: run.error });
  }
  await saving;
}
