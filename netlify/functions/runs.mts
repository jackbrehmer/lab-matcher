import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import { getProfile, getRun, listRuns, newId, saveProfile, saveRun } from "../lib/store.ts";
import type { Profile, Run } from "../lib/types.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      const run = await getRun(id);
      return run ? json(run) : json({ error: "not found" }, 404);
    }
    const runs = (await listRuns())
      .filter((r) => r.status === "done")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((r) => ({ id: r.id, profile: r.profile, createdAt: r.createdAt, matches: r.matches?.length ?? 0 }));
    return json(runs);
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const required = ["name", "email", "major", "year", "interests", "resume"] as const;
    if (!body || required.some((k) => !String(body[k] ?? "").trim())) {
      return json({ error: `Missing fields. Required: ${required.join(", ")}` }, 400);
    }
    const profileId = createHash("sha1").update(String(body.email).toLowerCase().trim()).digest("hex").slice(0, 12);
    const existing = await getProfile(profileId);
    const profile: Profile = {
      ...(existing ?? {}),
      id: profileId,
      name: body.name,
      email: body.email,
      major: body.major,
      year: body.year,
      interests: body.interests,
      resume: body.resume,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await saveProfile(profile);

    const run: Run = {
      id: newId(),
      profileId,
      profile: { name: profile.name, major: profile.major, year: profile.year, interests: profile.interests },
      status: "queued",
      trace: [{ t: Date.now(), agent: "system", kind: "status", text: "Run queued" }],
      createdAt: new Date().toISOString(),
    };
    await saveRun(run);

    const bg = await fetch(new URL("/.netlify/functions/run-agents-background", req.url), {
      method: "POST",
      body: JSON.stringify({ runId: run.id }),
    });
    if (bg.status !== 202 && !bg.ok) return json({ error: `Could not start agents (${bg.status})` }, 500);
    return json({ runId: run.id, profileId });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config: Config = { path: "/api/runs" };
