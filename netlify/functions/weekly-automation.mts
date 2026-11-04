import type { Config } from "@netlify/functions";
import { runAutomation } from "../lib/automation.ts";

// Scheduled trigger: Mondays at 8:00am Mountain time.
// Netlify schedules are in UTC and 8am Mountain is 15:00 UTC in winter (MST) but 14:00 UTC in
// summer (MDT), so this fires at both and only runs at the one that is actually 8am in Denver.
export default async () => {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  if (hour !== 8) return;
  await runAutomation({ trigger: "schedule" });
};

export const config: Config = { schedule: "0 14,15 * * 1" };
