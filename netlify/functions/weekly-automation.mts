import type { Config } from "@netlify/functions";
import { runAutomation } from "../lib/automation.ts";

// Scheduled trigger: Mondays 8:00am Mountain (15:00 UTC).
export default async () => {
  await runAutomation({ trigger: "schedule" });
};

export const config: Config = { schedule: "0 15 * * 1" };
