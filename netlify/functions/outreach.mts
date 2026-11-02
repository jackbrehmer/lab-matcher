import type { Config } from "@netlify/functions";
import { getRun, saveRun } from "../lib/store.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Student marks a draft as sent / replied. "sent" starts the follow-up reminder clock used by the automation. */
export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const { runId, authorId, status, subject, body } = await req.json();
  const run = await getRun(runId);
  const match = run?.matches?.find((m) => m.authorId === authorId);
  if (!run || !match) return json({ error: "not found" }, 404);
  if (!["draft", "sent", "replied"].includes(status)) return json({ error: "bad status" }, 400);
  match.status = status;
  if (status === "sent") match.sentAt = new Date().toISOString();
  if (match.email && typeof body === "string") {
    match.email.subject = subject ?? match.email.subject;
    match.email.body = body;
  }
  await saveRun(run);
  return json(match);
};

export const config: Config = { path: "/api/outreach" };
