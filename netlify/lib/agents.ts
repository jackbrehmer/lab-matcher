import { runAgent, type ToolDef } from "./claude.ts";
import { getAuthorProfile, getRecentWorks, getWork, searchCUResearchers } from "./openalex.ts";
import type { Candidate, EmailDraft, Match, Paper, Profile, Rejection, TraceEvent } from "./types.ts";

type Emit = (e: Omit<TraceEvent, "t">) => Promise<void> | void;

const profileBlock = (p: Profile) => `STUDENT PROFILE
Name: ${p.name}
Major: ${p.major}
Year: ${p.year}
Research interests: ${p.interests}

RESUME
${p.resume.slice(0, 6000)}`;

// ---------- shared tools ----------

const fetchPage: ToolDef = {
  name: "fetch_page",
  description: "Fetch a web page (e.g. a lab or faculty page) and return its visible text, truncated.",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  label: (i) => `fetch_page(${i.url})`,
  run: async ({ url }) => {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 lab-matcher" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url, text: text.slice(0, 6000) };
  },
  summarize: (o) => `${o.text.length} chars of page text`,
};

// ---------- Agent 1: Lab Scout ----------

export async function labScout(profile: Profile, emit: Emit): Promise<Candidate[]> {
  const tools: ToolDef[] = [
    {
      name: "search_cu_researchers",
      description:
        "Search CU Boulder-affiliated papers from the last 3 years for a topic and return the CU authors on them, with how many matching papers each has and how often they are last author (a strong signal they run the lab).",
      input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      label: (i) => `search_cu_researchers("${i.topic}")`,
      run: ({ topic }) => searchCUResearchers(topic),
      summarize: (o: any[]) => `${o.length} CU researchers` + (o[0] ? `, top: ${o.slice(0, 3).map((h) => h.name).join(", ")}` : ""),
    },
    {
      name: "get_author_profile",
      description: "Get an author's OpenAlex profile: total works, citations, h-index, current institutions, research topics. Use to tell faculty (PIs) from grad students.",
      input_schema: { type: "object", properties: { authorId: { type: "string" } }, required: ["authorId"] },
      label: (i) => `get_author_profile(${i.authorId})`,
      run: ({ authorId }) => getAuthorProfile(authorId),
      summarize: (o) => `${o.name}: ${o.worksCount} works, h-index ${o.hIndex ?? "?"}, ${o.institutions?.[0] ?? "unknown inst"}`,
    },
    fetchPage,
  ];

  const finalTool: ToolDef = {
    name: "submit_candidates",
    description: "Submit the final shortlist of CU Boulder faculty candidates.",
    input_schema: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              authorId: { type: "string", description: "OpenAlex author id, e.g. A5012345678" },
              name: { type: "string" },
              department: { type: "string" },
              labUrl: { type: "string", description: "Only if you actually found it" },
              undergradSignal: { type: "string", description: "Evidence they take undergrads, or 'unknown'" },
              reason: { type: "string", description: "One sentence: why this person fits the student's interests" },
            },
            required: ["authorId", "name", "reason"],
          },
        },
      },
      required: ["candidates"],
    },
  };

  const out = await runAgent<{ candidates: Candidate[] }>({
    agent: "scout",
    emit,
    tools,
    finalTool,
    maxTurns: 12,
    system: `You are Lab Scout, an agent that finds CU Boulder faculty an undergraduate could realistically join as a research assistant.

Process (you decide the exact steps):
1. Turn the student's interests into 3-6 specific search topics. Include adjacent fields: a finance major interested in ML may fit in Leeds finance, CS, applied math, or economics labs.
2. Run search_cu_researchers for each topic. Prefer people who are frequently LAST author (lab heads) and published in the last 2 years.
3. Verify promising people with get_author_profile. Faculty usually have 30+ works. Drop grad students, postdocs, and anyone no longer at CU Boulder.
4. For your top picks, use web_search (if available) to find their lab page and any sign they take undergraduates. Do not invent URLs.
5. Call submit_candidates with 6-10 candidates, best first. Only include authorIds returned by the tools.

Be decisive. Keep your text between tool calls to one short sentence explaining the decision you just made.`,
    prompt: profileBlock(profile),
  });

  return (out.candidates ?? []).slice(0, 10);
}

// ---------- Agent 2: Fit Analyst ----------

export async function fitAnalyst(
  profile: Profile,
  candidates: Candidate[],
  emit: Emit
): Promise<{ matches: Match[]; rejected: Rejection[] }> {
  const retrieved = new Map<string, Paper[]>(); // authorId -> papers the agent actually read

  const tools: ToolDef[] = [
    {
      name: "get_recent_papers",
      description: "Get an author's 5 most recent papers with abstracts. You must call this for a candidate before scoring them.",
      input_schema: { type: "object", properties: { authorId: { type: "string" } }, required: ["authorId"] },
      label: (i) => `get_recent_papers(${i.authorId})`,
      run: async ({ authorId }) => {
        const papers = await getRecentWorks(authorId);
        retrieved.set(authorId, papers);
        return papers;
      },
      summarize: (o: Paper[]) => `${o.length} papers` + (o[0] ? `, latest: "${o[0].title.slice(0, 70)}" (${o[0].year})` : ""),
    },
    fetchPage,
  ];

  const finalTool: ToolDef = {
    name: "submit_scores",
    description: "Submit scored matches (score >= 6 only, max 5, best first) and rejected candidates with reasons.",
    input_schema: {
      type: "object",
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              authorId: { type: "string" },
              topic: { type: "integer", description: "0-4 overlap between student's interests and recent papers" },
              skills: { type: "integer", description: "0-3 how well resume skills map to the lab's methods" },
              access: { type: "integer", description: "0-3 likelihood the lab takes undergrads" },
              reasoning: { type: "string", description: "2-3 sentences, specific to the papers you read" },
              citedPaperId: { type: "string", description: "OpenAlex work id of the paper the email should reference. Must come from get_recent_papers." },
              gaps: { type: "array", items: { type: "string" }, description: "Skills the student should brush up on" },
              askType: { type: "string", enum: ["volunteer", "credit", "paid"] },
            },
            required: ["authorId", "topic", "skills", "access", "reasoning", "citedPaperId", "askType"],
          },
        },
        rejected: {
          type: "array",
          items: {
            type: "object",
            properties: { authorId: { type: "string" }, reason: { type: "string" } },
            required: ["authorId", "reason"],
          },
        },
      },
      required: ["matches", "rejected"],
    },
  };

  const list = candidates
    .map((c, i) => `${i + 1}. ${c.name} [${c.authorId}]${c.department ? `, ${c.department}` : ""}. Scout note: ${c.reason}. Undergrad signal: ${c.undergradSignal ?? "unknown"}`)
    .join("\n");

  const out = await runAgent<{
    matches: { authorId: string; topic: number; skills: number; access: number; reasoning: string; citedPaperId: string; gaps?: string[]; askType: Match["askType"] }[];
    rejected: { authorId: string; reason: string }[];
  }>({
    agent: "fit",
    emit,
    tools,
    finalTool,
    maxTurns: 14,
    webSearch: false,
    system: `You are Fit Analyst. You score how well an undergraduate fits each CU Boulder lab, using evidence, not vibes.

For EVERY candidate, call get_recent_papers first. Then score:
- topic (0-4): overlap between the student's stated interests and what the lab published recently
- skills (0-3): does the resume show methods the lab uses (Python, stats, wet lab, finance data, etc.)
- access (0-3): evidence they take undergrads; 1 if unknown
Total = topic + skills + access (max 10). Only return matches with total >= 6, at most 5, best first. Reject the rest with a one-line reason.

Pick citedPaperId: the recent paper the student could most credibly talk about. It must be an id you received from get_recent_papers.
Pick askType: "paid" only if the resume shows directly usable skills; "credit" for freshmen/sophomores with some relevant coursework; otherwise "volunteer".
Keep text between tool calls to one short sentence.`,
    prompt: `${profileBlock(profile)}\n\nCANDIDATES FROM LAB SCOUT\n${list}`,
  });

  const byId = new Map(candidates.map((c) => [c.authorId, c]));
  const matches: Match[] = [];
  for (const m of out.matches ?? []) {
    const c = byId.get(m.authorId);
    const papers = retrieved.get(m.authorId) ?? [];
    if (!c || papers.length === 0) continue; // never scored without evidence
    let cited = papers.find((p) => p.id === m.citedPaperId);
    if (!cited) {
      cited = papers[0];
      await emit({ agent: "fit", kind: "error", text: `Guardrail: cited paper for ${c.name} was not in retrieved papers, replaced with most recent` });
    }
    const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(n || 0)));
    const breakdown = { topic: clamp(m.topic, 4), skills: clamp(m.skills, 3), access: clamp(m.access, 3) };
    const score = breakdown.topic + breakdown.skills + breakdown.access;
    if (score < 6) continue;
    matches.push({
      authorId: c.authorId,
      name: c.name,
      department: c.department,
      labUrl: c.labUrl,
      score,
      scoreBreakdown: breakdown,
      reasoning: m.reasoning,
      citedPaper: cited,
      gaps: m.gaps ?? [],
      askType: m.askType,
      status: "draft",
    });
  }
  matches.sort((a, b) => b.score - a.score);
  const rejected: Rejection[] = (out.rejected ?? []).map((r) => ({
    authorId: r.authorId,
    name: byId.get(r.authorId)?.name ?? r.authorId,
    reason: r.reason,
  }));
  return { matches: matches.slice(0, 5), rejected };
}

// ---------- Agent 3: Outreach Writer ----------

export async function outreachWriter(profile: Profile, matches: Match[], emit: Emit): Promise<Match[]> {
  if (matches.length === 0) return matches;

  const tools: ToolDef[] = [
    {
      name: "read_paper",
      description: "Read the full abstract of a paper so the email can reference something specific in it.",
      input_schema: { type: "object", properties: { paperId: { type: "string" } }, required: ["paperId"] },
      label: (i) => `read_paper(${i.paperId})`,
      run: ({ paperId }) => getWork(paperId),
      summarize: (o: Paper) => `"${o.title.slice(0, 80)}", ${o.abstract ? o.abstract.length + " char abstract" : "no abstract"}`,
    },
  ];

  const finalTool: ToolDef = {
    name: "submit_emails",
    description: "Submit one cold email per professor.",
    input_schema: {
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: {
            type: "object",
            properties: {
              authorId: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" },
            },
            required: ["authorId", "subject", "body"],
          },
        },
      },
      required: ["emails"],
    },
  };

  const brief = matches
    .map(
      (m) =>
        `- ${m.name} [${m.authorId}] score ${m.score}/10, ask: ${m.askType}\n  Cited paper [${m.citedPaper.id}]: "${m.citedPaper.title}" (${m.citedPaper.year})\n  Why: ${m.reasoning}`
    )
    .join("\n");

  const out = await runAgent<{ emails: { authorId: string; subject: string; body: string }[] }>({
    agent: "writer",
    emit,
    tools,
    finalTool,
    maxTurns: 8,
    webSearch: false,
    system: `You are Outreach Writer. You draft cold emails from an undergraduate to CU Boulder professors asking to join their lab.

For each professor, read_paper on the cited paper first, then write an email that:
- Is under 150 words in the body
- Opens with "Dear Professor <LastName>,"
- Names the cited paper by its exact title (in quotes) and makes ONE specific, accurate observation about it from the abstract
- Connects 1-2 concrete items from the resume to the lab's methods
- Makes a clear ask matching askType (volunteer, course credit, or paid RA), offers ~10 hrs/week, and asks for a 15-minute chat
- Ends with "Resume attached." and the student's name
- No flattery, no "I am passionate about", no em dashes
Subject line: short and specific, e.g. "CU sophomore, interested in your work on <topic>".`,
    prompt: `${profileBlock(profile)}\n\nMATCHES\n${brief}`,
  });

  const byId = new Map((out.emails ?? []).map((e) => [e.authorId, e]));
  return matches.map((m) => {
    const e = byId.get(m.authorId);
    if (!e) return { ...m, email: { subject: "", body: "", verified: false, flags: ["Writer did not produce an email"] } };
    return { ...m, email: verifyEmail(e, m) };
  });
}

/** Deterministic guardrails run on every draft before a human sees it. */
export function verifyEmail(e: { subject: string; body: string }, m: Match): EmailDraft {
  const flags: string[] = [];
  const words = e.body.trim().split(/\s+/).length;
  if (words > 170) flags.push(`${words} words (limit 150)`);
  const titleStart = m.citedPaper.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 40);
  const bodyNorm = e.body.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  if (!bodyNorm.includes(titleStart)) flags.push("Cited paper title not found verbatim");
  const last = m.name.trim().split(/\s+/).pop()!.toLowerCase();
  const escaped = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\b${escaped}\\b`, "i").test(e.body)) flags.push("Professor's name missing");
  if (/passionate|delve|i hope this email finds you/i.test(e.body)) flags.push("Generic phrasing");
  return { subject: e.subject, body: e.body.replace(/—/g, ", "), verified: flags.length === 0, flags };
}
