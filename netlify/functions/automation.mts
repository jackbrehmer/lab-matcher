import type { Config } from "@netlify/functions";
import { runAutomation } from "../lib/automation.ts";
import { listAutomationLogs } from "../lib/store.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// GET: automation history. POST: run it now (for the demo). Same code path as the weekly schedule.
export default async (req: Request) => {
  if (req.method === "GET") return json((await listAutomationLogs()).slice(0, 10));
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const log = await runAutomation({
      trigger: "manual",
      profileId: body.profileId || undefined,
      lookbackDays: Number(body.lookbackDays) || 30,
      reminderDays: body.reminderDays !== undefined ? Number(body.reminderDays) : 0,
    });
    return json(log);
  }
  return json({ error: "method not allowed" }, 405);
};

export const config: Config = { path: "/api/automation" };
