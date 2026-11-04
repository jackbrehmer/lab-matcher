import type { Config } from "@netlify/functions";
import { json, requireUser } from "../lib/auth.ts";
import { getRun, saveRun } from "../lib/store.ts";

/** Student edits a draft or marks it sent / replied. "sent" starts the follow-up reminder clock used by the automation. */
export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { runId, authorId, status, subject, body } = (await req.json().catch(() => ({}))) as any;
  // Runs are looked up under the signed-in user's id, so nobody can touch another student's run.
  const run = await getRun(auth.user.id, runId);
  const match = run?.matches?.find((m) => m.authorId === authorId);
  if (!run || !match) return json({ error: "not found" }, 404);
  if (!["draft", "sent", "replied"].includes(status)) return json({ error: "bad status" }, 400);
  if ((typeof subject === "string" && subject.length > 300) || (typeof body === "string" && body.length > 5000)) {
    return json({ error: "Email is too long" }, 400);
  }
  if (status === "sent" && match.status !== "sent") match.sentAt = new Date().toISOString();
  match.status = status;
  if (match.email && typeof body === "string") {
    match.email.subject = typeof subject === "string" ? subject : match.email.subject;
    match.email.body = body;
  }
  await saveRun(run);
  return json(match);
};

export const config: Config = { path: "/api/outreach" };
