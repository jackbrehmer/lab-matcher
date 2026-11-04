import type { Config } from "@netlify/functions";
import { json, LIMITS, requireUser, takeQuota } from "../lib/auth.ts";
import { runAutomation } from "../lib/automation.ts";
import { listAutomationLogs } from "../lib/store.ts";

/**
 * GET: automation history. Students see only runs they started for themselves; admins see everything.
 * POST: run it now. Students can only run it for their own profile (a few times a day);
 * admins can run it for everyone. Same code path and 7-day reminder rule as the weekly schedule.
 */
export default async (req: Request) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const { user, isAdmin } = auth;

  if (req.method === "GET") {
    const logs = await listAutomationLogs(isAdmin ? 10 : 50);
    return json((isAdmin ? logs : logs.filter((l) => l.profileId === user.id)).slice(0, 10));
  }

  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as any;
    const everyone = isAdmin && body.scope === "all";
    if (!everyone && !(await takeQuota(user.id, "automation", LIMITS.manualAutomationPerDay))) {
      return json({ error: `You can run this ${LIMITS.manualAutomationPerDay} times a day. Try again tomorrow.` }, 429);
    }
    const log = await runAutomation({
      trigger: "manual",
      profileId: everyone ? undefined : user.id,
      lookbackDays: Number(body.lookbackDays) || 30,
    });
    if (!log) return json({ error: "The automation is already running. Try again in a few minutes." }, 409);
    return json(log);
  }
  return json({ error: "method not allowed" }, 405);
};

export const config: Config = { path: "/api/automation" };
