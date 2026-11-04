import { getUser, type User } from "@netlify/identity";
import { getStore } from "@netlify/blobs";

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export type Authed = { user: User & { email: string }; isAdmin: boolean };

/**
 * Returns the signed-in Netlify Identity user, or a Response to send back.
 * Requires a confirmed email so the app never emails an address the user doesn't control.
 * For state-changing requests, also requires a same-origin request (CSRF protection for the auth cookie).
 */
export async function requireUser(req: Request): Promise<Authed | Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (!origin || origin !== new URL(req.url).origin) return json({ error: "Bad origin" }, 403);
  }
  const user = await getUser();
  if (!user || !user.email) return json({ error: "Please sign in." }, 401);
  // Identity only issues sessions to users who confirmed their email (autoconfirm is off),
  // so user.email is an address the user has proven they own.
  const roles = [...(user.roles ?? []), ...(((user.appMetadata as any)?.roles as string[] | undefined) ?? [])];
  return { user: user as Authed["user"], isAdmin: roles.includes("admin") };
}

const usage = () => getStore({ name: "usage", consistency: "strong" });

/**
 * Atomically counts one use of `kind` for this user in the current UTC day.
 * Returns false (and does not count) when the daily limit is already reached.
 */
export async function takeQuota(userId: string, kind: string, limit: number): Promise<boolean> {
  const key = `${userId}/${kind}/${new Date().toISOString().slice(0, 10)}`;
  const store = usage();
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const count = Number((cur?.data as any)?.count ?? 0);
    if (count >= limit) return false;
    const res = cur
      ? await store.setJSON(key, { count: count + 1 }, { onlyIfMatch: cur.etag! })
      : await store.setJSON(key, { count: 1 }, { onlyIfNew: true });
    if (res.modified) return true;
  }
  return false;
}

export const LIMITS = {
  runsPerDay: 3,
  resumeUploadsPerDay: 10,
  manualAutomationPerDay: 2,
};
