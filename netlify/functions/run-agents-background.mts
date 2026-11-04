import { runPipeline } from "../lib/pipeline.ts";

// Background function (name ends in -background): Netlify returns 202 immediately
// and lets this run for up to 15 minutes, long enough for all three agents.
// It only starts a run that is still queued and only with that run's one-time start token,
// so it can't be used to re-run (and reset) an existing run.
export default async (req: Request) => {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== "string") return;
  await runPipeline(String(body.profileId), String(body.runId), body.token);
};
