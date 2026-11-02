export type Profile = {
  id: string;
  name: string;
  email: string;
  major: string;
  year: string;
  interests: string;
  resume: string;
  createdAt: string;
  seenWorkIds?: string[];
  lastAutomationAt?: string;
};

export type AgentName = "scout" | "fit" | "writer" | "system";

export type TraceEvent = {
  t: number;
  agent: AgentName;
  kind: "thought" | "tool" | "result" | "decision" | "error" | "status";
  text: string;
};

export type Paper = {
  id: string;
  title: string;
  year: number | null;
  date?: string;
  venue?: string;
  abstract?: string;
  url?: string;
  citedBy?: number;
};

export type Candidate = {
  authorId: string;
  name: string;
  department?: string;
  labUrl?: string;
  undergradSignal?: string;
  reason: string;
};

export type Rejection = { authorId: string; name: string; reason: string };

export type EmailDraft = {
  subject: string;
  body: string;
  verified: boolean;
  flags: string[];
};

export type Match = {
  authorId: string;
  name: string;
  department?: string;
  labUrl?: string;
  score: number;
  scoreBreakdown: { topic: number; skills: number; access: number };
  reasoning: string;
  citedPaper: Paper;
  gaps: string[];
  askType: "volunteer" | "credit" | "paid";
  email?: EmailDraft;
  status: "draft" | "sent" | "replied";
  sentAt?: string;
  lastReminderAt?: string;
};

export type RunStatus = "queued" | "scout" | "fit" | "writer" | "done" | "error";

export type Run = {
  id: string;
  profileId: string;
  profile: Pick<Profile, "name" | "major" | "year" | "interests">;
  status: RunStatus;
  trace: TraceEvent[];
  candidates?: Candidate[];
  rejected?: Rejection[];
  matches?: Match[];
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

export type AutomationStep = { name: string; detail: string; ok: boolean };

export type AutomationLog = {
  id: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  steps: AutomationStep[];
};
