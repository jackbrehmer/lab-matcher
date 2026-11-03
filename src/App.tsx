import { useEffect, useState } from "react";
import type { AutomationLog, Match, Run } from "../netlify/lib/types";

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
  useEffect(() => {
    const on = () => setView(parseHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#">
          <span className="mark">◆</span> Lab Matcher
        </a>
        <nav>
          <a className={view.kind === "new" ? "on" : ""} href="#">New search</a>
          <a className={view.kind === "history" ? "on" : ""} href="#history">Past runs</a>
          <a className={view.kind === "automation" ? "on" : ""} href="#automation">Automation</a>
        </nav>
      </header>
      {view.kind === "new" && <NewSearch />}
      {view.kind === "run" && <RunView id={view.id} />}
      {view.kind === "automation" && <Automation />}
      {view.kind === "history" && <History />}
      <footer>CU AI Club capstone · Data: OpenAlex · Agents: Claude</footer>
    </div>
  );
}

// ---------------- New search ----------------

const SAMPLE = {
  name: "Alex Rivera",
  email: "",
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

function NewSearch() {
  const [f, setF] = useState({ name: "", email: "", major: "", year: "Sophomore", interests: "", resume: "" });
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
      const res = await fetch("/api/resume", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
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
    if (!f.resume.trim()) {
      setErr("Please upload your resume.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      try { localStorage.setItem("lm_profile", data.profileId); } catch {}
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
          <label>Name<input value={f.name} onChange={set("name")} required /></label>
          <label>Email<input type="email" value={f.email} onChange={set("email")} required placeholder="for weekly digests" /></label>
        </div>
        <div className="row">
          <label>Major<input value={f.major} onChange={set("major")} required /></label>
          <label>Year
            <select value={f.year} onChange={set("year")}>
              {["Freshman", "Sophomore", "Junior", "Senior"].map((y) => <option key={y}>{y}</option>)}
            </select>
          </label>
        </div>
        <label>Research interests<textarea rows={2} value={f.interests} onChange={set("interests")} required placeholder="comma separated, e.g. reinforcement learning, climate risk, behavioral finance" /></label>
        <label>Resume
          <div className={`upload${f.resume ? " ready" : ""}`}>
            <input type="file" accept=".pdf,.docx,.txt,.md,application/pdf,text/plain" onChange={onResumeFile} disabled={parsing} />
            <span className="upload-text">
              {parsing
                ? `Reading ${resumeFile}…`
                : f.resume
                  ? <>✓ {resumeFile || "Sample resume"} loaded · <u>replace</u></>
                  : <>Drop your resume here or <u>choose a file</u> (PDF, DOCX, or TXT)</>}
            </span>
          </div>
        </label>
        {err && <div className="flag bad">{err}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={() => { setF({ ...SAMPLE, email: f.email }); setResumeFile("sample-resume.txt"); }}>Load sample student</button>
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
        const res = await fetch(`/api/runs?id=${id}`);
        if (!res.ok) throw new Error(res.status === 404 ? "Run not found" : res.statusText);
        const r: Run = await res.json();
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
  const started = run.trace[0]?.t ?? Date.now();
  const elapsed = Math.round(((run.trace.at(-1)?.t ?? Date.now()) - started) / 1000);

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

  async function mark(s: Match["status"]) {
    setStatus(s);
    await fetch("/api/outreach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, authorId: m.authorId, status: s, subject, body }),
    }).catch(() => {});
  }

  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const findEmail = `https://www.google.com/search?q=${encodeURIComponent(`${m.name} University of Colorado Boulder email`)}`;

  return (
    <article className="card match">
      <div className="mhead">
        <div>
          <span className="rank">#{rank}</span>
          <h3>{m.name}</h3>
          <p className="muted">{m.department || "CU Boulder"} {m.labUrl && <> · <a href={m.labUrl} target="_blank">lab page ↗</a></>}</p>
        </div>
      </div>
      <p>{m.reasoning}</p>
      <p className="cite">Cites: <a href={m.citedPaper.url} target="_blank">{m.citedPaper.title}</a> ({m.citedPaper.year})</p>

      {m.email && (
        <div className="email">
          {!m.email.verified && <div className="flag warn">Needs review: {m.email.flags.join("; ")}</div>}
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="actions">
            <a className="ghost btn" href={findEmail} target="_blank">Find their email ↗</a>
            <button className="ghost" onClick={() => { navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
            <a className="ghost btn" href={gmail} target="_blank">Open in Gmail ↗</a>
            {status === "draft" && <button className="primary" onClick={() => mark("sent")}>I sent it</button>}
            {status === "sent" && <button className="primary" onClick={() => mark("replied")}>They replied</button>}
            {status === "replied" && <span className="pill done">Replied</span>}
          </div>
          {status === "sent" && <p className="muted small">Weekly automation will remind {studentName.split(" ")[0]} to follow up if there is no reply in 7 days.</p>}
        </div>
      )}
    </article>
  );
}

// ---------------- History ----------------

function History() {
  const [runs, setRuns] = useState<{ id: string; profile: Run["profile"]; createdAt: string; matches: number }[] | null>(null);
  useEffect(() => { fetch("/api/runs").then((r) => r.json()).then(setRuns).catch(() => setRuns([])); }, []);
  return (
    <main className="narrow">
      <h2>Past runs</h2>
      {!runs && <p className="muted">Loading…</p>}
      {runs?.length === 0 && <p className="muted">No completed runs yet.</p>}
      {runs?.map((r) => (
        <a key={r.id} className="card row-link" href={`#run=${r.id}`}>
          <b>{r.profile.name}</b>
          <span className="muted">{r.profile.major} · {r.matches} matches · {new Date(r.createdAt).toLocaleString()}</span>
        </a>
      ))}
    </main>
  );
}

// ---------------- Automation ----------------

const AUTO_STEPS = [
  ["Trigger", "Every Monday 8:00am MT (Netlify scheduled function), or Run now"],
  ["Load students", "Every saved profile and its latest matches"],
  ["Check matched labs", "OpenAlex: new papers from each matched professor since last run"],
  ["Scan interest areas", "OpenAlex: new CU papers in the student's topics from labs not yet matched"],
  ["Dedupe + reminders", "Drop papers already shown; find emails marked sent with no reply after 7 days"],
  ["Notify", "Email each student a digest + follow-up reminders (Resend), record what was sent"],
];

function Automation() {
  const [logs, setLogs] = useState<AutomationLog[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => fetch("/api/automation").then((r) => r.json()).then(setLogs).catch(() => setLogs([]));
  useEffect(() => { load(); }, []);

  async function runNow() {
    setBusy(true);
    let profileId: string | null = null;
    try { profileId = localStorage.getItem("lm_profile"); } catch {}
    await fetch("/api/automation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, lookbackDays: 60, reminderDays: 0 }),
    }).catch(() => {});
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
        <button className="primary" onClick={runNow} disabled={busy}>{busy ? "Running…" : "Run now (demo: 60-day lookback, reminders due immediately)"}</button>
      </div>
      <h3>History</h3>
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
