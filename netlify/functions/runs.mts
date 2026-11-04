import type { Config } from "@netlify/functions";
import { json, LIMITS, requireUser, takeQuota } from "../lib/auth.ts";
import { getProfile, getRun, listRunsFor, newId, saveProfile, saveRun } from "../lib/store.ts";
import type { Profile, PublicRun, Run } from "../lib/types.ts";

const MAX_LEN = { name: 100, major: 120, year: 20, interests: 600, resume: 20000 } as const;
const ACTIVE = new Set<Run["status"]>(["queued", "scout", "fit", "writer"]);
const STALE_MS = 20 * 60 * 1000; // background functions stop after 15 minutes

export const toPublicRun = (r: Run): PublicRun => ({
  id: r.id,
  profile: r.profile,
  status: r.status,
  matches: r.matches,
  error: r.error,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
});

export default async (req: Request) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const url = new URL(req.url);

  if (req.method === "GET") {
    // Saved profile, used to prefill the search form.
    if (url.searchParams.has("profile")) {
      const p = await getProfile(user.id);
      return json(p ? { name: p.name, major: p.major, year: p.year, interests: p.interests, hasResume: !!p.resume } : null);
    }
    const id = url.searchParams.get("id");
    if (id) {
      const run = await getRun(user.id, id);
      return run ? json(toPublicRun(run)) : json({ error: "not found" }, 404);
    }
    const runs = (await listRunsFor(user.id, 10))
      .map((r) => ({ id: r.id, profile: r.profile, status: r.status, createdAt: r.createdAt, matches: r.matches?.length ?? 0 }));
    return json(runs);
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const fields = ["name", "major", "year", "interests"] as const;
    if (!body || fields.some((k) => !String(body[k] ?? "").trim())) {
      return json({ error: `Missing fields. Required: ${fields.join(", ")}, resume` }, 400);
    }
    for (const [k, max] of Object.entries(MAX_LEN)) {
      if (String(body[k] ?? "").length > max) return json({ error: `${k} is too long (max ${max} characters)` }, 400);
    }

    const existing = await getProfile(user.id);
    const resume = String(body.resume ?? "").trim() || existing?.resume || "";
    if (!resume) return json({ error: "Please upload your resume." }, 400);

    // One run at a time per student.
    const [latest] = await listRunsFor(user.id, 1);
    if (latest && ACTIVE.has(latest.status) && Date.now() - Date.parse(latest.createdAt) < STALE_MS) {
      return json({ error: "You already have a search running. Wait for it to finish.", runId: latest.id }, 409);
    }
    if (!(await takeQuota(user.id, "runs", LIMITS.runsPerDay))) {
      return json({ error: `Daily limit reached (${LIMITS.runsPerDay} searches per day). Try again tomorrow.` }, 429);
    }

    // The profile is keyed by the signed-in account, and the email comes from the account
    // (confirmed by Identity), never from the form.
    const profile: Profile = {
      ...(existing ?? {}),
      id: user.id,
      name: String(body.name).trim(),
      email: user.email,
      major: String(body.major).trim(),
      year: String(body.year).trim(),
      interests: String(body.interests).trim(),
      resume,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await saveProfile(profile);

    const startToken = crypto.randomUUID();
    const run: Run = {
      id: newId(),
      profileId: user.id,
      profile: { name: profile.name, major: profile.major, year: profile.year, interests: profile.interests },
      status: "queued",
      trace: [{ t: Date.now(), agent: "system", kind: "status", text: "Run queued" }],
      startToken,
      createdAt: new Date().toISOString(),
    };
    await saveRun(run);

    const bg = await fetch(new URL("/.netlify/functions/run-agents-background", req.url), {
      method: "POST",
      body: JSON.stringify({ profileId: user.id, runId: run.id, token: startToken }),
    });
    if (bg.status !== 202 && !bg.ok) {
      console.error(`run-agents-background returned ${bg.status}`);
      run.status = "error";
      run.error = "Could not start the search. Please try again.";
      delete run.startToken;
      await saveRun(run);
      return json({ error: run.error }, 500);
    }
    return json({ runId: run.id });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config: Config = { path: "/api/runs" };
