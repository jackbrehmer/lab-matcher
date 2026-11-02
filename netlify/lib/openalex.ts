import type { Paper } from "./types.ts";

const BASE = "https://api.openalex.org";
const CU_ROR = "02ttsq026"; // University of Colorado Boulder
const CU_FALLBACK_ID = "I188538660";

let cuId: string | null = null;

function withMailto(url: URL) {
  const mail = process.env.NOTIFY_EMAIL;
  if (mail) url.searchParams.set("mailto", mail);
  return url;
}

/** Some OpenAlex filters (lineage) are newer; fall back to a plain institution id filter on 4xx. */
async function oaCU(path: string, params: Record<string, string>): Promise<any> {
  try {
    return await oa(path, params);
  } catch (e) {
    if (!params.filter?.includes("lineage")) throw e;
    return oa(path, { ...params, filter: params.filter.replace("authorships.institutions.lineage", "authorships.institutions.id") });
  }
}

async function oa(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = withMailto(new URL(BASE + path));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "lab-matcher (CU AI Club capstone)" } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    throw new Error(`OpenAlex ${res.status} on ${path}`);
  }
  throw new Error(`OpenAlex unavailable on ${path}`);
}

export const shortId = (id: string) => id.replace("https://openalex.org/", "");

export async function cuInstitutionId(): Promise<string> {
  if (cuId) return cuId;
  try {
    const inst = await oa(`/institutions/ror:${CU_ROR}`);
    cuId = shortId(inst.id);
  } catch {
    cuId = CU_FALLBACK_ID;
  }
  return cuId;
}

export function rebuildAbstract(inv: Record<string, number[]> | null | undefined, max = 900): string | undefined {
  if (!inv) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  const text = words.filter(Boolean).join(" ");
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function toPaper(w: any, abstractMax = 900): Paper {
  return {
    id: shortId(w.id),
    title: w.title ?? w.display_name ?? "(untitled)",
    year: w.publication_year ?? null,
    date: w.publication_date,
    venue: w.primary_location?.source?.display_name ?? undefined,
    abstract: rebuildAbstract(w.abstract_inverted_index, abstractMax),
    url: w.doi ?? w.primary_location?.landing_page_url ?? w.id,
    citedBy: w.cited_by_count,
  };
}

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

function isCU(inst: any, cu: string) {
  const id = inst?.id ? shortId(inst.id) : "";
  const lineage: string[] = (inst?.lineage ?? []).map(shortId);
  return id === cu || lineage.includes(cu) || (inst?.ror ?? "").endsWith(CU_ROR);
}

export type ResearcherHit = {
  authorId: string;
  name: string;
  matchingPapers: number;
  lastAuthorCount: number;
  latestYear: number | null;
  sampleTitles: string[];
};

/** Search recent CU Boulder papers for a topic and aggregate the CU-affiliated authors. */
export async function searchCUResearchers(topic: string, sinceDays = 3 * 365): Promise<ResearcherHit[]> {
  const cu = await cuInstitutionId();
  const data = await oaCU("/works", {
    search: topic,
    filter: `authorships.institutions.lineage:${cu},from_publication_date:${isoDaysAgo(sinceDays)}`,
    per_page: "40",
    select: "id,title,publication_year,authorships",
  });
  const map = new Map<string, ResearcherHit>();
  for (const w of data.results ?? []) {
    const n = w.authorships?.length ?? 0;
    w.authorships?.forEach((a: any, i: number) => {
      if (!a.author?.id || !(a.institutions ?? []).some((inst: any) => isCU(inst, cu))) return;
      const id = shortId(a.author.id);
      const hit: ResearcherHit = map.get(id) ?? {
        authorId: id,
        name: a.author.display_name,
        matchingPapers: 0,
        lastAuthorCount: 0,
        latestYear: null,
        sampleTitles: [],
      };
      hit.matchingPapers++;
      if (a.author_position === "last" || (n > 1 && i === n - 1)) hit.lastAuthorCount++;
      hit.latestYear = Math.max(hit.latestYear ?? 0, w.publication_year ?? 0) || null;
      if (hit.sampleTitles.length < 3) hit.sampleTitles.push(w.title);
      map.set(id, hit);
    });
  }
  return [...map.values()]
    .sort((a, b) => b.lastAuthorCount * 2 + b.matchingPapers - (a.lastAuthorCount * 2 + a.matchingPapers))
    .slice(0, 15);
}

export async function getAuthorProfile(authorId: string) {
  const a = await oa(`/authors/${shortId(authorId)}`);
  return {
    authorId: shortId(a.id),
    name: a.display_name,
    worksCount: a.works_count,
    citedBy: a.cited_by_count,
    hIndex: a.summary_stats?.h_index,
    institutions: (a.last_known_institutions ?? (a.last_known_institution ? [a.last_known_institution] : []))
      .map((i: any) => i.display_name),
    topics: (a.topics ?? a.x_concepts ?? []).slice(0, 6).map((t: any) => t.display_name),
    orcid: a.orcid ?? undefined,
  };
}

export async function getRecentWorks(authorId: string, n = 5, sinceDays = 4 * 365): Promise<Paper[]> {
  const data = await oa("/works", {
    filter: `author.id:${shortId(authorId)},from_publication_date:${isoDaysAgo(sinceDays)}`,
    sort: "publication_date:desc",
    per_page: String(n),
    select: "id,title,publication_year,publication_date,primary_location,doi,cited_by_count,abstract_inverted_index",
  });
  return (data.results ?? []).map((w: any) => toPaper(w, 600));
}

export async function getWork(workId: string): Promise<Paper> {
  return toPaper(await oa(`/works/${shortId(workId)}`), 2500);
}

/** Deterministic lookup used by the automation (no LLM). */
export async function worksSince(authorId: string, sinceDate: string): Promise<Paper[]> {
  const data = await oa("/works", {
    filter: `author.id:${shortId(authorId)},from_publication_date:${sinceDate}`,
    sort: "publication_date:desc",
    per_page: "10",
    select: "id,title,publication_year,publication_date,primary_location,doi",
  });
  return (data.results ?? []).map((w: any) => toPaper(w));
}

export async function newCUWorksForTopic(topic: string, sinceDate: string): Promise<{ paper: Paper; cuAuthors: { id: string; name: string }[] }[]> {
  const cu = await cuInstitutionId();
  const data = await oaCU("/works", {
    search: topic,
    filter: `authorships.institutions.lineage:${cu},from_publication_date:${sinceDate}`,
    per_page: "15",
    select: "id,title,publication_year,publication_date,primary_location,doi,authorships",
  });
  return (data.results ?? []).map((w: any) => ({
    paper: toPaper(w),
    cuAuthors: (w.authorships ?? [])
      .filter((a: any) => a.author?.id && (a.institutions ?? []).some((i: any) => isCU(i, cu)))
      .map((a: any) => ({ id: shortId(a.author.id), name: a.author.display_name })),
  }));
}
