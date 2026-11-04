import type { Config } from "@netlify/functions";
import mammoth from "mammoth";
import { callClaude, MODEL } from "../lib/claude.ts";
import { json, LIMITS, requireUser, takeQuota } from "../lib/auth.ts";

const MAX_BYTES = 4 * 1024 * 1024;

async function pdfToText(buf: Buffer): Promise<string> {
  const res = await callClaude({
    model: MODEL(),
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
          {
            type: "text",
            text: "Transcribe the full text of this resume as plain text. Keep section headings and bullet points. Output only the resume text, with no commentary.",
          },
        ],
      },
    ],
  });
  return (res.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

/** Accepts a resume file (PDF, DOCX, TXT, MD) and returns its plain text. */
export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return json({ error: "No file uploaded" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "File is too large (max 4 MB)" }, 400);

  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    let text = "";
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      // PDFs are transcribed by Claude, which costs money, so they count against a daily limit.
      if (!(await takeQuota(auth.user.id, "resume-pdf", LIMITS.resumeUploadsPerDay))) {
        return json({ error: `Daily upload limit reached (${LIMITS.resumeUploadsPerDay} PDFs per day). Try a DOCX or TXT file, or try again tomorrow.` }, 429);
      }
      text = await pdfToText(buf);
    } else if (name.endsWith(".docx")) {
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (name.endsWith(".txt") || name.endsWith(".md") || file.type.startsWith("text/")) {
      text = buf.toString("utf8");
    } else {
      return json({ error: "Unsupported file type. Upload a PDF, DOCX, or TXT file." }, 400);
    }
    text = text.trim().slice(0, 20000);
    if (!text) return json({ error: "Couldn't read any text from that file." }, 422);
    return json({ text, fileName: file.name });
  } catch (e: any) {
    console.error("Resume parse failed:", e);
    return json({ error: "Couldn't read that file. Try another format (PDF, DOCX, or TXT)." }, 500);
  }
};

export const config: Config = { path: "/api/resume" };
