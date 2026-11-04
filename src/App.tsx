import { useEffect, useState } from "react";
import {
  AuthError,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  requestPasswordRecovery,
  signup,
  updateUser,
  type User,
} from "@netlify/identity";
import type { AutomationLog, Match, PublicRun as Run } from "../netlify/lib/types";

/** Only render links that are plain https URLs. */
const safeHref = (u?: string) => {
  try {
    return u && new URL(u).protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
};

/** fetch() wrapper that turns non-2xx responses into readable errors. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? "Your session expired. Please sign in again." : data.error || res.statusText);
  return data as T;
}

type View = { kind: "new" } | { kind: "run"; id: string } | { kind: "automation" } | { kind: "history" };

function parseHash(): View {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("run")) return { kind: "run", id: h.get("run")! };
  if (h.has("automation")) return { kind: "automation" };
  if (h.has("history")) return { kind: "history" };
  return { kind: "new" };
}

const go = (hash: string) => (location.hash = hash);

export default function App() {
  const [view, setView] = useState<View>(parseHash);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const on = () => setView(parseHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    (async () => {
      // Handles links from confirmation and password-reset emails.
      try {
        const cb = await handleAuthCallback();
        if (cb?.type === "confirmation") setNotice("Email confirmed. You're signed in.");
        if (cb?.type === "recovery") setRecovering(true);
        if (cb) history.replaceState(null, "", location.pathname);
      } catch (e: any) {
        setNotice(e instanceof AuthError ? e.message : "That link is invalid or expired.");
      }
      setUser(await getUser());
      setReady(true);
    })();
    return onAuthChange((_event, u) => setUser(u));
  }, []);

  const isAdmin = !!user && [...(user.roles ?? []), ...(((user.appMetadata as any)?.roles as string[]) ?? [])].includes("admin");

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#">
          <span className="mark">◆</span> Lab Matcher
        </a>
        {user && (
          <nav>
            <a className={view.kind === "new" ? "on" : ""} href="#">New search</a>
            <a className={view.kind === "history" ? "on" : ""} href="#history">Past runs</a>
            <a className={view.kind === "automation" ? "on" : ""} href="#automation">Automation</a>
            <button className="ghost signout" onClick={() => logout().catch(() => {}).then(() => setUser(null))} title={user.email}>Sign out</button>
          </nav>
        )}
      </header>
      {notice && <div className="flag ok narrow-flag">{notice}</div>}
      {!ready && <main className="narrow"><p className="muted">Loading…</p></main>}
      {ready && recovering && user && <SetPassword onDone={() => { setRecovering(false); setNotice("Password updated."); }} />}
      {ready && !user && <AuthPanel />}
      {ready && user && !recovering && (
        <>
          {view.kind === "new" && <NewSearch email={user.email ?? ""} />}
          {view.kind === "run" && <RunView id={view.id} />}
          {view.kind === "automation" && <Automation isAdmin={isAdmin} />}
          {view.kind === "history" && <History />}
        </>
      )}
      <footer>CU AI Club capstone · Data: OpenAlex · Agents: Claude</footer>
    </div>
  );
}

// ---------------- Sign in ----------------

function AuthPanel() {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      if (mode === "signin") {
        await login(email, password);
      } else if (mode === "signup") {
        const u = await signup(email, password, { full_name: name });
        if (!u.confirmedAt) setMsg("Check your inbox and click the link to confirm your email, then come back and sign in.");
      } else {
        await requestPasswordRecovery(email);
        setMsg("If that email has an account, a password reset link is on its way.");
      }
    } catch (e: any) {
      if (e instanceof AuthError) {
        if (e.status === 401 && mode === "signin") setErr("Invalid email or password. If you just signed up, confirm your email first.");
        else if (e.status === 403) setErr("Sign-ups are currently closed.");
        else if (e.status === 422) setErr(e.message || "Check your email and password (at least 8 characters).");
        else setErr(e.message);
      } else setErr("Couldn't reach the sign-in service. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <section className="hero">
        <h1>Find a CU Boulder lab that fits you.</h1>
        <p>
          Three agents search CU's recent publications, score each lab against your resume, and draft a cold email that cites a real paper.
          Sign in to get started. Your matches and drafts stay private to your account.
        </p>
      </section>
      <form className="card form auth" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === "signin" ? "on" : ""} onClick={() => { setMode("signin"); setErr(""); setMsg(""); }}>Sign in</button>
          <button type="button" className={mode === "signup" ? "on" : ""} onClick={() => { setMode("signup"); setErr(""); setMsg(""); }}>Create account</button>
        </div>
        {mode === "signup" && <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></label>}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
        {mode !== "forgot" && (
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></label>
        )}
        {err && <div className="flag bad">{err}</div>}
        {msg && <div className="flag ok">{msg}</div>}
        <div className="actions">
          {mode === "signin" && <button type="button" className="linkish" onClick={() => { setMode("forgot"); setErr(""); setMsg(""); }}>Forgot password?</button>}
          {mode === "forgot" && <button type="button" className="linkish" onClick={() => setMode("signin")}>Back to sign in</button>}
          <button className="primary" disabled={busy}>
            {busy ? "One moment…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
          </button>
        </div>
      </form>
    </main>
  );
}

function SetPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await updateUser({ password });
      onDone();
    } catch (e: any) {
      setErr(e instanceof AuthError ? e.message : "Couldn't update your password.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="narrow">
      <form className="card form auth" onSubmit={submit}>
        <h2>Choose a new password</h2>
        <label>New password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" /></label>
        {err && <div className="flag bad">{err}</div>}
        <div className="actions"><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save password"}</button></div>
      </form>
    </main>
  );
}

// ---------------- New search ----------------

const SAMPLE = {
  name: "Alex Rivera",
  major: "Finance (Leeds School of Business)",
  year: "Sophomore",
  interests: "machine learning for financial markets, behavioral finance, AI-assisted decision making",
  resume: `EDUCATION
University of Colorado Boulder, B.S. Business Administration, Finance. GPA 3.9

EXPERIENCE
Market Intelligence Intern, wellness hardware startup (Summer 2026)
- Built a Python pipeline (NewsAPI + LLM) that scores sales leads weekly and writes them to Google Sheets
- Researched 200+ institutional buyers and wrote prospect briefs for the sales team

PROJECTS
- Trading terminal for a student quant club: pandas, real-time market data, Streamlit dashboard
- Hackathon: built a payments prototype on an EVM chain (Solidity, TypeScript)

SKILLS
Python (pandas, numpy, scikit-learn), SQL, Excel modeling, financial statement analysis, Git`,
};

function NewSearch({ email }: { email: string }) {
  const [f, setF] = useState({ name: "", major: "", year: "Sophomore", interests: "", resume: "" });
  const [savedResume, setSavedResume] = useState(false);
  useEffect(() => {
    api<{ name: string; major: string; year: string; interests: string; hasResume: boolean } | null>("/api/runs?profile=1")
      .then((p) => {
        if (!p) return;
        setF((prev) => ({ ...prev, name: p.name, major: p.major, year: p.year, interests: p.interests }));
        setSavedResume(p.hasResume);
      })
      .catch(() => {});
  }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const [resumeFile, setResumeFile] = useState("");
  const [parsing, setParsing] = useState(false);

  async function onResumeFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr("");
    setParsing(true);
    setResumeFile(file.name);
    setF((prev) => ({ ...prev, resume: "" }));
    try {
      const body = new FormData();
      body.append("file", file);
      const data = await api<{ text: string }>("/api/resume", { method: "POST", body });
      setF((prev) => ({ ...prev, resume: data.text }));
    } catch (e: any) {
      setErr(e.message);
      setResumeFile("");
    } finally {
      setParsing(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.resume.trim() && !savedResume) {
      setErr("Please upload your resume.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const data = await api<{ runId: string }>("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
      go(`run=${data.runId}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <section className="hero">
        <h1>Find a CU Boulder lab that fits you.</h1>
        <p>
          Three agents search CU's recent publications, score each lab against your resume, and draft a cold email that cites a real paper.
          You review and send every email yourself.
        </p>
      </section>
      <form className="card form" onSubmit={submit}>
        <div className="row">
          <label>Name<input value={f.name} onChange={set("name")} required maxLength={100} /></label>
          <label>Email<input type="email" value={email} disabled title="Weekly digests go to your account email" /></label>
        </div>
        <div className="row">
          <label>Major<input value={f.major} onChange={set("major")} required maxLength={120} /></label>
          <label>Year
            <select value={f.year} onChange={set("year")}>
              {["Freshman", "Sophomore", "Junior", "Senior"].map((y) => <option key={y}>{y}</option>)}
            </select>
          </label>
        </div>
        <label>Research interests<textarea rows={2} value={f.interests} onChange={set("interests")} required maxLength={600} placeholder="comma separated, e.g. reinforcement learning, climate risk, behavioral finance" /></label>
        <label>Resume
          <div className={`upload${f.resume || savedResume ? " ready" : ""}`}>
            <input type="file" accept=".pdf,.docx,.txt,.md,application/pdf,text/plain" onChange={onResumeFile} disabled={parsing} />
            <span className="upload-text">
              {parsing
                ? `Reading ${resumeFile}…`
                : f.resume
                  ? <>✓ {resumeFile || "Sample resume"} loaded · <u>replace</u></>
                  : savedResume
                    ? <>✓ Using your saved resume · <u>upload a new one</u></>
                    : <>Drop your resume here or <u>choose a file</u> (PDF, DOCX, or TXT)</>}
            </span>
          </div>
        </label>
        {err && <div className="flag bad">{err}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={() => { setF({ ...SAMPLE }); setResumeFile("sample-resume.txt"); }}>Load sample student</button>
          <button className="primary" disabled={busy || parsing}>{busy ? "Starting agents…" : "Find my labs →"}</button>
        </div>
      </form>
      <Pipeline status="queued" />
    </main>
  );
}

// ---------------- Run view ----------------

const STAGES: { key: "scout" | "fit" | "writer"; name: string; desc: string }[] = [
  { key: "scout", name: "Lab Scout", desc: "Turns your interests into searches, finds active CU lab heads" },
  { key: "fit", name: "Fit Analyst", desc: "Reads their recent papers, scores fit 0-10, rejects weak matches" },
  { key: "writer", name: "Outreach Writer", desc: "Drafts emails citing a real paper, then guardrails check them" },
];

function Pipeline({ status }: { status: Run["status"] }) {
  const order = ["queued", "scout", "fit", "writer", "done"];
  const idx = order.indexOf(status);
  return (
    <div className="pipeline">
      {STAGES.map((s, i) => {
        const state = status === "error" ? "" : idx > i + 1 ? "done" : idx === i + 1 ? "active" : "";
        return (
          <div key={s.key} className={`stage ${state} a-${s.key}`}>
            <div className="num">{state === "done" ? "✓" : i + 1}</div>
            <div>
              <b>{s.name}</b>
              <span>{s.desc}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    let timer: any;
    const poll = async () => {
      try {
        const r = await api<Run>(`/api/runs?id=${encodeURIComponent(id)}`).catch((e) => {
          throw new Error(e.message === "not found" ? "Run not found" : e.message);
        });
        if (stop) return;
        setRun(r);
        if (r.status !== "done" && r.status !== "error") timer = setTimeout(poll, 1500);
      } catch (e: any) {
        setErr(e.message);
      }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);

  if (err) return <main className="narrow"><div className="flag bad">{err}</div></main>;
  if (!run) return <main className="narrow"><p className="muted">Loading…</p></main>;

  const running = run.status !== "done" && run.status !== "error";
  const elapsed = Math.max(0, Math.round(((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.createdAt)) / 1000));

  return (
    <main className="narrow">
      <div className="runhead">
        <div>
          <h2>{run.profile.name}</h2>
          <p className="muted">{run.profile.year} · {run.profile.major} · {run.profile.interests}</p>
        </div>
        <div className={`pill ${run.status}`}>{running ? `Running · ${elapsed}s` : run.status === "done" ? `Done in ${elapsed}s` : "Error"}</div>
      </div>
      <Pipeline status={run.status} />

      <section className="results">
        {run.status === "error" && <div className="flag bad">{run.error}</div>}
        {run.matches?.map((m, i) => <MatchCard key={m.authorId} m={m} rank={i + 1} runId={run.id} studentName={run.profile.name} />)}
        {run.status === "done" && !run.matches?.length && <div className="card">No matching labs this time. Try broader interests.</div>}
        {running && !run.matches && <div className="card muted">Finding professors that match your interests. Matches appear here in a minute or two.</div>}
        {running && !!run.matches && <div className="card muted">Writing your outreach emails…</div>}
      </section>
    </main>
  );
}

function MatchCard({ m, rank, runId, studentName }: { m: Match; rank: number; runId: string; studentName: string }) {
  const [subject, setSubject] = useState(m.email?.subject ?? "");
  const [body, setBody] = useState(m.email?.body ?? "");
  const [status, setStatus] = useState(m.status);
  const [copied, setCopied] = useState(false);

  // Cards mount while the Fit Analyst is still scoring, before the Writer has produced a draft.
  // Load the draft into the editable fields once it arrives on a later poll.
  useEffect(() => {
    if (!m.email) return;
    setSubject(m.email.subject);
    setBody(m.email.body);
  }, [m.email?.subject, m.email?.body]);
  useEffect(() => setStatus(m.status), [m.status]);

  const [saveErr, setSaveErr] = useState("");
  async function mark(s: Match["status"]) {
    const prev = status;
    setStatus(s);
    setSaveErr("");
    try {
      await api("/api/outreach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, authorId: m.authorId, status: s, subject, body }),
      });
    } catch (e: any) {
      setStatus(prev);
      setSaveErr(e.message);
    }
  }
  const labHref = safeHref(m.labUrl);
  const paperHref = safeHref(m.citedPaper.url);

  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const findEmail = `https://www.google.com/search?q=${encodeURIComponent(`${m.name} University of Colorado Boulder email`)}`;

  return (
    <article className="card match">
      <div className="mhead">
        <div>
          <span className="rank">#{rank}</span>
          <h3>{m.name}</h3>
          <p className="muted">{m.department || "CU Boulder"} {labHref && <> · <a href={labHref} target="_blank" rel="noopener noreferrer">lab page ↗</a></>}</p>
        </div>
      </div>
      <p>{m.reasoning}</p>
      <p className="cite">Cites: {paperHref ? <a href={paperHref} target="_blank" rel="noopener noreferrer">{m.citedPaper.title}</a> : m.citedPaper.title} ({m.citedPaper.year})</p>

      {m.email && (
        <div className="email">
          {!m.email.verified && <div className="flag warn">Needs review: {m.email.flags.join("; ")}</div>}
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="actions">
            <a className="ghost btn" href={findEmail} target="_blank" rel="noopener noreferrer">Find their email ↗</a>
            <button className="ghost" onClick={() => { navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
            <a className="ghost btn" href={gmail} target="_blank" rel="noopener noreferrer">Open in Gmail ↗</a>
            {status === "draft" && <button className="primary" onClick={() => mark("sent")}>I sent it</button>}
            {status === "sent" && <button className="primary" onClick={() => mark("replied")}>They replied</button>}
            {status === "replied" && <span className="pill done">Replied</span>}
          </div>
          {saveErr && <div className="flag bad">{saveErr}</div>}
          {status === "sent" && <p className="muted small">Weekly automation will remind {studentName.split(" ")[0]} to follow up if there is no reply in 7 days.</p>}
        </div>
      )}
    </article>
  );
}

// ---------------- History ----------------

function History() {
  const [runs, setRuns] = useState<{ id: string; profile: Run["profile"]; status: Run["status"]; createdAt: string; matches: number }[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api<typeof runs>("/api/runs").then(setRuns).catch((e) => { setErr(e.message); setRuns([]); }); }, []);
  return (
    <main className="narrow">
      <h2>Your past runs</h2>
      {err && <div className="flag bad">{err}</div>}
      {!runs && <p className="muted">Loading…</p>}
      {runs?.length === 0 && !err && <p className="muted">No runs yet.</p>}
      {runs?.map((r) => (
        <a key={r.id} className="card row-link" href={`#run=${r.id}`}>
          <b>{r.profile.interests}</b>
          <span className="muted">
            {r.status === "done" ? `${r.matches} matches` : r.status === "error" ? "Failed" : "Running"} · {new Date(r.createdAt).toLocaleString()}
          </span>
        </a>
      ))}
    </main>
  );
}

// ---------------- Automation ----------------

const AUTO_STEPS = [
  ["Trigger", "Every Monday 8:00am Mountain time (Netlify scheduled function), or Run now"],
  ["Load students", "Every saved profile and its latest matches"],
  ["Check matched labs", "OpenAlex: new papers from each matched professor since last run"],
  ["Scan interest areas", "OpenAlex: new CU papers in the student's topics from labs not yet matched"],
  ["Dedupe + reminders", "Drop papers already shown; find emails marked sent with no reply after 7 days"],
  ["Notify", "Email each student a digest + follow-up reminders (Resend), record what was sent"],
];

function Automation({ isAdmin }: { isAdmin: boolean }) {
  const [logs, setLogs] = useState<AutomationLog[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => api<AutomationLog[]>("/api/automation").then(setLogs).catch((e) => { setErr(e.message); setLogs([]); });
  useEffect(() => { load(); }, []);

  async function runNow(scope: "me" | "all") {
    setBusy(true);
    setErr("");
    try {
      await api("/api/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, lookbackDays: 60 }),
      });
    } catch (e: any) {
      setErr(e.message);
    }
    await load();
    setBusy(false);
  }

  return (
    <main className="narrow">
      <h2>Weekly automation</h2>
      <p className="muted">Runs separately from the agents. No LLM calls: deterministic lookups, dedupe, and notifications.</p>
      <ol className="flow">
        {AUTO_STEPS.map(([t, d], i) => (
          <li key={t}><span className="num">{i + 1}</span><div><b>{t}</b><span>{d}</span></div></li>
        ))}
      </ol>
      <div className="actions left">
        <button className="primary" onClick={() => runNow("me")} disabled={busy}>{busy ? "Running…" : "Run now for me (60-day lookback)"}</button>
        {isAdmin && <button className="ghost" onClick={() => runNow("all")} disabled={busy}>Run for all students</button>}
      </div>
      {err && <div className="flag bad">{err}</div>}
      <h3>{isAdmin ? "History" : "Your history"}</h3>
      {logs?.length === 0 && <p className="muted">No runs yet.</p>}
      {logs?.map((l) => (
        <div key={l.id} className="card log">
          <div className="loghead">
            <b>{l.trigger === "schedule" ? "Scheduled" : "Manual"} run</b>
            <span className="muted">{new Date(l.startedAt).toLocaleString()}</span>
          </div>
          <ul>{l.steps.map((s, i) => <li key={i} className={s.ok ? "" : "bad"}><b>{s.name}:</b> {s.detail}</li>)}</ul>
        </div>
      ))}
    </main>
  );
}
