import { runPipeline } from "../lib/pipeline.ts";

// Background function (name ends in -background): Netlify returns 202 immediately
// and lets this run for up to 15 minutes, long enough for all three agents.
export default async (req: Request) => {
  const { runId } = await req.json();
  await runPipeline(runId);
};
