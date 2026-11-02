/** Sends through Resend. Without a key it logs and reports "skipped" so the automation still completes. */
export async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, detail: "RESEND_API_KEY not set, email skipped" };
  const recipient = process.env.NOTIFY_EMAIL || to; // Resend test sender only delivers to the account owner
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || "Lab Matcher <onboarding@resend.dev>",
      to: [recipient],
      subject,
      html,
    }),
  });
  if (!res.ok) return { ok: false, detail: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { ok: true, detail: `sent to ${recipient}` };
}
