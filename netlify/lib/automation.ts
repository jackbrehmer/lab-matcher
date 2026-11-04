import { sendEmail } from "./email.ts";
import { newCUWorksForTopic, worksSince } from "./openalex.ts";
import { acquireLock, getRun, listProfiles, listRunsFor, newId, saveAutomationLog, saveProfile, saveRun } from "./store.ts";
import type { AutomationLog, Match, Paper, Profile, Run } from "./types.ts";

/**
 * Weekly automation. Separate from the agents and uses no LLM:
 *  1. Load every student and their latest completed run
 *  2. Pull new papers from each matched lab since the last check (OpenAlex)
 *  3. Pull new CU papers in the student's interest areas from labs not yet matched
 *  4. Dedupe against papers the student has already been shown
 *  5. Find "sent" outreach with no reply after N days
 *  6. Email each student a digest + reminders, then record what was sent
 *
 * Only one automation runs at a time (a lock), so overlapping runs can't send the same digest twice.
 * Logs never contain student names or email addresses.
 */
export const REMINDER_DAYS = 7;

export async function runAutomation(opts: {
  trigger: "schedule" | "manual";
  lookbackDays?: number;
  profileId?: string;
}): Promise<AutomationLog | null> {
  const release = await acquireLock("automation");
  if (!release) return null;
  try {
    return await runLocked(opts);
  } finally {
    await release();
  }
}

async function latestDoneRun(p: Profile): Promise<Run | null> {
  if (p.latestRunId) {
    const r = await getRun(p.id, p.latestRunId);
    if (r?.status === "done") return r;
  }
  return (await listRunsFor(p.id, 10)).find((r) => r.status === "done") ?? null;
}

async function runLocked(opts: { trigger: "schedule" | "manual"; lookbackDays?: number; profileId?: string }): Promise<AutomationLog> {
  const lookbackDays = Math.min(Math.max(opts.lookbackDays ?? 7, 1), 60);
  // Reminders go out at most once every REMINDER_DAYS, no matter how the automation is triggered.
  const reminderDays = REMINDER_DAYS;
  const log: AutomationLog = { id: newId(), trigger: opts.trigger, profileId: opts.profileId, startedAt: new Date().toISOString(), steps: [] };
  const step = (name: string, detail: string, ok = true) => log.steps.push({ name, detail, ok });

  // 1. load
  const profiles = (await listProfiles()).filter((p) => !opts.profileId || p.id === opts.profileId);
  const latestRun = new Map<string, Run>();
  await Promise.all(
    profiles.map(async (p) => {
      const r = await latestDoneRun(p);
      if (r) latestRun.set(p.id, r);
    })
  );
  const active = profiles.filter((p) => latestRun.has(p.id));
  step("Load students", `${profiles.length} profiles, ${active.length} with completed matches`);

  const now = Date.now();
  let totalNewLab = 0, totalNewTopic = 0, totalReminders = 0, emailsSent = 0, emailsFailed = 0;

  for (const p of active) {
    const run = latestRun.get(p.id)!;
    const matches = run.matches ?? [];
    const since = p.lastAutomationAt
      ? p.lastAutomationAt.slice(0, 10)
      : new Date(now - lookbackDays * 864e5).toISOString().slice(0, 10);
    const seen = new Set(p.seenWorkIds ?? matches.map((m) => m.citedPaper.id));

    // 2. new papers from matched labs
    const labUpdates = (
      await Promise.all(
        matches.map(async (m) => ({
          match: m,
          papers: (await worksSince(m.authorId, since).catch(() => [] as Paper[])).filter((w) => !seen.has(w.id)),
        }))
      )
    ).filter((u) => u.papers.length);

    // 3. new CU labs in interest areas
    const matchedIds = new Set(matches.map((m) => m.authorId));
    const topics = p.interests.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    const newLabs: { paper: Paper; authors: string }[] = [];
    const topicResults = await Promise.all(topics.map((t) => newCUWorksForTopic(t, since).catch(() => [])));
    for (const w of topicResults.flat()) {
      const fresh = w.cuAuthors.filter((a) => !matchedIds.has(a.id));
      if (fresh.length && !seen.has(w.paper.id)) newLabs.push({ paper: w.paper, authors: fresh.map((a) => a.name).join(", ") });
    }

    // 4. dedupe
    const uniqueNewLabs = [...new Map(newLabs.map((n) => [n.paper.id, n])).values()].slice(0, 5);
    for (const u of labUpdates) u.papers.forEach((w) => seen.add(w.id));
    uniqueNewLabs.forEach((n) => seen.add(n.paper.id));

    // 5. follow-up reminders
    const due = matches.filter(
      (m) =>
        m.status === "sent" &&
        m.sentAt &&
        now - Date.parse(m.sentAt) >= reminderDays * 864e5 &&
        (!m.lastReminderAt || now - Date.parse(m.lastReminderAt) >= reminderDays * 864e5)
    );

    totalNewLab += labUpdates.reduce((n, u) => n + u.papers.length, 0);
    totalNewTopic += uniqueNewLabs.length;
    totalReminders += due.length;

    // 6. email + record
    if (labUpdates.length || uniqueNewLabs.length || due.length) {
      const res = await sendEmail(p.email, `Lab Matcher weekly: ${labUpdates.length + uniqueNewLabs.length} updates, ${due.length} follow-ups`, digestHtml(p, labUpdates, uniqueNewLabs, due));
      if (res.ok) emailsSent++;
      else {
        emailsFailed++;
        console.error(`Digest email failed for profile ${p.id}: ${res.detail}`);
      }
      const stamp = new Date().toISOString();
      due.forEach((m) => (m.lastReminderAt = stamp));
      if (due.length) await saveRun(run);
    }
    p.seenWorkIds = [...seen].slice(-500);
    p.lastAutomationAt = new Date().toISOString();
    await saveProfile(p);
  }

  step("New papers from matched labs", `${totalNewLab} found`);
  step("New CU labs in interest areas", `${totalNewTopic} found after dedupe`);
  step("Follow-up reminders due", `${totalReminders} (no reply after ${reminderDays} days)`);
  step("Digests emailed", `${emailsSent} sent`);
  if (emailsFailed) step("Email errors", `${emailsFailed} digest${emailsFailed === 1 ? "" : "s"} could not be sent (see function logs)`, false);
  log.finishedAt = new Date().toISOString();
  await saveAutomationLog(log);
  return log;
}

/** Escapes text for HTML element content and attribute values. */
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const safeUrl = (u?: string) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

function digestHtml(p: Profile, labs: { match: Match; papers: Paper[] }[], newLabs: { paper: Paper; authors: string }[], due: Match[]) {
  const li = (s: string) => `<li style="margin-bottom:8px">${s}</li>`;
  const link = (pp: Paper) => {
    const href = safeUrl(pp.url);
    const title = esc(pp.title);
    return `${href ? `<a href="${esc(href)}">${title}</a>` : title} (${esc(pp.year ?? "")})`;
  };
  const first = p.name.trim().split(/\s+/)[0] || "there";
  return `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 12px">Hi ${esc(first)}, here is your week</h2>
${due.length ? `<h3>Follow up</h3><p>No reply yet. A short, polite follow-up ${REMINDER_DAYS}+ days later is normal.</p><ul>${due.map((m) => li(`<b>${esc(m.name)}</b>, sent ${esc(m.sentAt?.slice(0, 10))}`)).join("")}</ul>` : ""}
${labs.length ? `<h3>New from your matched labs</h3><ul>${labs.flatMap((u) => u.papers.map((pp) => li(`<b>${esc(u.match.name)}</b>: ${link(pp)}`))).join("")}</ul><p>Fresh papers are a good reason to (re)reach out.</p>` : ""}
${newLabs.length ? `<h3>New CU research in your areas</h3><ul>${newLabs.map((n) => li(`${link(n.paper)}<br><span style="color:#666">${esc(n.authors)}</span>`)).join("")}</ul>` : ""}
<p style="color:#888;font-size:12px">Lab Matcher, CU AI Club capstone</p></div>`;
}
