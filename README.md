# Lab Matcher

Helps CU Boulder undergrads find research labs that fit them and write a credible first email.

**User:** undergrads who want a research position but don't know which professors to contact. A department or CU's undergraduate research office could run this tool for its students.
**Problem:** most students email a handful of famous professors with generic messages and get no reply. Finding labs that are active, a good match, and open to undergrads takes hours of reading faculty pages and papers.

## How it works

```
Student profile ──► Lab Scout ──► Fit Analyst ──► Outreach Writer ──► Student reviews + sends
                     (agent 1)     (agent 2)        (agent 3)               (human)
Weekly cron ──► load students ──► check matched labs ──► scan new CU papers ──► dedupe + reminders ──► email digest
                                       (automation, no LLM)
```

| Agent | Input | Tools | Decisions it makes |
|---|---|---|---|
| Lab Scout | interests, major, resume | `search_cu_researchers`, `get_author_profile`, `web_search`, `fetch_page` | which topics to search, who is a lab head vs. a student, who is still active at CU, which 6-10 people to shortlist |
| Fit Analyst | shortlist + resume | `get_recent_papers`, `fetch_page` | 0-10 score (topic, skills, access), which paper to cite, what to ask for (volunteer, credit, paid), who to reject and why |
| Outreach Writer | top matches | `read_paper` | subject line, the one specific observation to make about the paper, which resume items to connect to the lab |

Every agent is a Claude tool-use loop: the model chooses which tools to call and when it's finished, and returns its result through a structured "submit" tool. On its final allowed turn, the agent is forced to submit, so every run ends.

**Guardrails (code, not LLM):**
- The cited paper must be one that the Fit Analyst actually retrieved from OpenAlex. If it isn't, the most recent retrieved paper is swapped in and the swap is logged.
- Scores are clamped to their rubric ranges and recomputed.
- Every email is checked for the exact paper title, the professor's name, a 150-word limit, and generic AI phrasing. Any failed check is shown to the student as a flag.
- Nothing is ever sent automatically.

**Automation** (`netlify/functions/weekly-automation.mts`, Mondays 8am MT; the same code also runs from `/api/automation` for demos):
1. Load every student and their latest matches.
2. Find new papers from each matched lab since the last run (OpenAlex).
3. Find new CU papers in the student's interest areas from labs they haven't been matched with.
4. Dedupe against papers already shown.
5. Find emails marked "sent" with no reply after 7 days.
6. Email a digest and follow-up reminders (Resend), then log the run.

## Stack

- Vite + React frontend
- Netlify Functions (a background function for the agents, a scheduled function for the automation)
- Netlify Blobs for storage
- Claude API (default `claude-sonnet-5-5`, override with `MODEL`)
- OpenAlex for publication data
- Resend for email

## Setup

1. Import the repo into Netlify. The build settings come from `netlify.toml`.
2. Set these environment variables:
   - `ANTHROPIC_API_KEY` (required)
   - `RESEND_API_KEY` (needed for digest emails)
   - `NOTIFY_EMAIL`: Resend's test sender only delivers to the account owner, so for the demo all mail goes to this address
   - Optional: `MODEL`, `ENABLE_WEB_SEARCH=false`, `FROM_EMAIL`
3. Deploy. For local development: `npm i -g netlify-cli && netlify dev`.

## Failure points

| Failure | Mitigation |
|---|---|
| OpenAlex misattributes an author or has a stale affiliation | Scout checks profiles. The student sees the lab page link and the paper before sending. |
| A professor isn't taking students | The access score and undergrad signal are shown. The student decides whether to send. |
| The LLM cites a paper it never read | Code checks the cited paper against the papers that were actually retrieved. |
| Email has the wrong tone, is generic, or overclaims the student's skills | Guardrail flags, plus every draft is edited and sent by the student. |
| Fit scores drift between runs | Fixed rubric (4+3+3), scores clamped and recomputed in code. |
| Web search is disabled on the API key | The agent falls back to OpenAlex only and notes it in the trace. |
| The digest spams students | Dedupe on paper IDs, and a reminder goes out at most once every 7 days. |

## How much to trust it without a human

- **High:** discovery and the weekly digest. The output is a list of real papers and people, and a bad entry costs the student a few seconds.
- **Medium:** fit scores. They're a starting point for ranking, not a final verdict.
- **None:** sending emails. A wrong or generic email to a professor hurts the student's reputation, so a human sends every one.
