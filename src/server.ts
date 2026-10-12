import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import {
  NoSuchToolError,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import {
  MODEL,
  initialCoachState,
  type CoachState,
  type Evaluation,
  type FeedbackReport,
  type InterviewType,
  type Profile,
  type ReportWorkflowParams,
  type TopicStat
} from "./shared";

export { FeedbackReportWorkflow } from "./workflow";

// ── Lenient tool-argument helpers ─────────────────────────────────────────

const looseString = z.union([z.string(), z.number()]).nullish();
const looseNumber = z.union([z.number(), z.string()]).nullish();
const looseList = z.union([z.array(z.string()), z.string()]).nullish();

/** Llama sometimes nests the real arguments: {"parameters": {...}} or a JSON string. */
function unwrapArgs(input: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["parameters", "arguments", "args", "input"]) {
    let inner = input[key];
    if (typeof inner === "string") {
      try {
        inner = JSON.parse(inner);
      } catch {
        continue;
      }
    }
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return { ...input, ...(inner as Record<string, unknown>) };
    }
  }
  return input;
}

/** Turns whatever the model sent into a flat object of strings / numbers / string arrays. */
function sanitizeArgs(raw: unknown): Record<string, unknown> {
  let v: unknown = raw;
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      v = {};
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const obj = unwrapArgs(v as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(obj)) {
    if (x == null) continue;
    if (Array.isArray(x)) {
      out[k] = x.map((e) => (e && typeof e === "object" ? JSON.stringify(e) : String(e)));
    } else if (typeof x === "object") {
      out[k] = JSON.stringify(x);
    } else if (typeof x === "boolean") {
      out[k] = String(x);
    } else {
      out[k] = x;
    }
  }
  return out;
}

function toStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "unknown" ? s : undefined;
}

function toNum(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v)); // "7/10" -> 7
  return Number.isFinite(n) ? n : undefined;
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((e) => {
        if (e && typeof e === "object") {
          const o = e as Record<string, unknown>;
          return String(o.name ?? o.topic ?? o.value ?? Object.values(o)[0] ?? "");
        }
        const s = String(e);
        if (s.startsWith("{")) {
          try {
            return toList([JSON.parse(s)])[0] ?? s;
          } catch {
            return s;
          }
        }
        return s;
      })
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const s = toStr(v);
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      return toList(JSON.parse(s));
    } catch {
      /* fall through */
    }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function toInterviewType(v: unknown): InterviewType | undefined {
  const s = toStr(v)?.toLowerCase().replace(/[\s_]+/g, "-");
  if (!s) return undefined;
  if (s.includes("system")) return "system-design";
  if (s.includes("lld") || s.includes("low-level")) return "lld";
  if (s.includes("dsa") || s.includes("algo") || s.includes("data-struct")) return "dsa";
  if (s.includes("behav")) return "behavioral";
  return "mixed";
}

/**
 * One InterviewCoach instance (a Durable Object) exists per user.
 *  - Chat history is persisted automatically by AIChatAgent (SQLite).
 *  - Long-term memory (profile + per-topic scores) lives in `this.state`,
 *    which is persisted and live-synced to the browser over WebSocket.
 *  - Raw evaluations and past reports live in the agent's own SQLite tables.
 */
export class InterviewCoach extends AIChatAgent<Env, CoachState> {
  initialState = initialCoachState;
  maxPersistedMessages = 200;

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      question TEXT NOT NULL,
      score INTEGER NOT NULL,
      strengths TEXT NOT NULL,
      gaps TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      body TEXT NOT NULL
    )`;
  }

  // ── Chat ──────────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const tools = this.tools();
    type ToolName = keyof typeof tools;
    const allTools = Object.keys(tools) as ToolName[];

    const result = streamText({
      model: workersai(MODEL),
      system: this.buildSystemPrompt(),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools,
      // Loop guard: once a tool has run in this reply, hide it for the
      // remaining steps so the model must answer instead of re-calling it.
      prepareStep: ({ steps }) => {
        const used = new Set<string>();
        for (const s of steps) {
          for (const part of s.content as Array<{ type: string; toolName?: string }>) {
            if ((part.type === "tool-call" || part.type === "tool-error") && part.toolName) {
              used.add(part.toolName);
            }
          }
        }
        return { activeTools: allTools.filter((t) => !used.has(t)) };
      },
      // If the model sends malformed arguments, clean them up instead of failing.
      repairToolCall: async ({ toolCall, error }) => {
        if (NoSuchToolError.isInstance(error)) return null;
        console.warn("repairing tool call", toolCall.toolName, toolCall.input, String(error));
        return { ...toolCall, input: JSON.stringify(sanitizeArgs(toolCall.input)) };
      },
      stopWhen: stepCountIs(4),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      // Show the real error text in the UI (and in Cloudflare logs) instead of
      // the default "An error occurred."
      onError: (error) => {
        console.error("chat error", error);
        return error instanceof Error ? error.message : String(error);
      }
    });
  }

  /** The system prompt is rebuilt every turn from memory, so the coach
   *  "remembers" the candidate across sessions and devices. */
  private buildSystemPrompt(): string {
    const { profile, topics, questionsAnswered, latestReport } = this.state;

    const weakest = Object.values(topics)
      .sort((a, b) => a.avgScore - b.avgScore)
      .slice(0, 5)
      .map(
        (t) =>
          `- ${t.topic}: avg ${t.avgScore.toFixed(1)}/10 over ${t.attempts} answer(s); last gap: ${t.lastGap}`
      )
      .join("\n");

    const memory = profile
      ? `CANDIDATE PROFILE (from memory):
- Name: ${profile.name ?? "unknown"}
- Target role: ${profile.targetRole}
- Experience: ${profile.yearsOfExperience ?? "unknown"} years
- Interview type: ${profile.interviewType}
- Focus areas: ${profile.focusAreas.join(", ") || "none given"}
- Questions answered so far: ${questionsAnswered}
${weakest ? `WEAKEST TOPICS SO FAR:\n${weakest}` : "No answers scored yet."}
${latestReport ? `LAST REPORT HEADLINE: ${latestReport.headline}` : ""}`
      : `No profile yet. Start by briefly asking the candidate for their target role, years of experience, interview type (dsa, system-design, lld, behavioral or mixed) and focus areas, then call saveProfile once with whatever they told you (leave unknown fields out) and ask the first question.`;

    return `You are "Coach", a friendly but rigorous technical interviewer running mock interviews for software engineers.

${memory}

HOW TO RUN THE INTERVIEW
1. Ask ONE question at a time, tailored to the profile. Prefer the candidate's weakest topics, but mix in new ones.
2. After the candidate answers, ALWAYS call recordEvaluation with an honest score from 1 to 10, one line of strengths and one line of gaps. Then give short feedback (2-4 bullets) and a model-answer hint, and ask the next question or a follow-up.
3. If they say "skip" or "hint", help without scoring.
4. If they ask how they are doing, call getProgress.
5. If they ask for a report, summary or study plan, or say they are done, call generateFeedbackReport and tell them it is being generated in the sidebar.
6. Keep replies concise and use Markdown. Never invent scores that were not recorded.
7. Call each tool at most ONCE per reply. After a tool returns, do not call it again; write your reply to the candidate.`;
  }

  private tools() {
    return {
      saveProfile: tool({
        description:
          "Save or update the candidate's profile in long-term memory. Call after learning their target role, experience, interview type or focus areas.",
        // Schemas are deliberately lenient: Llama often sends null for unknown
        // fields, numbers as strings, or a list as a single string. Strict
        // schemas make every call fail and the model retries in a loop.
        inputSchema: z.object({
          name: looseString.describe("Candidate's first name, if given"),
          targetRole: looseString.describe("e.g. 'Senior Backend Engineer'"),
          yearsOfExperience: looseNumber.describe("Years of experience, if given"),
          interviewType: looseString.describe(
            "One of: dsa, system-design, lld, behavioral, mixed"
          ),
          focusAreas: looseList.describe("Topics to focus on, e.g. ['kafka', 'caching']")
        }).passthrough(),
        execute: async (raw) => {
          const input = unwrapArgs(raw);
          const prev = this.state.profile;
          const profile: Profile = {
            name: toStr(input.name) ?? prev?.name,
            targetRole: toStr(input.targetRole) ?? prev?.targetRole ?? "Software Engineer",
            yearsOfExperience: toNum(input.yearsOfExperience) ?? prev?.yearsOfExperience,
            interviewType: toInterviewType(input.interviewType) ?? prev?.interviewType ?? "mixed",
            focusAreas: toList(input.focusAreas).length
              ? toList(input.focusAreas)
              : (prev?.focusAreas ?? [])
          };
          this.setState({ ...this.state, profile });
          return { saved: true, profile, next: "Profile saved. Now ask the first interview question." };
        }
      }),

      recordEvaluation: tool({
        description:
          "Record the score for the candidate's answer to the last question. Call this after every real answer.",
        inputSchema: z.object({
          topic: looseString.describe(
            "Short lowercase topic, e.g. 'rate limiting', 'graphs', 'caching'"
          ),
          question: looseString.describe("The question that was answered"),
          score: looseNumber.describe("Score from 1 (poor) to 10 (excellent)"),
          strengths: looseString.describe("One line: what was good"),
          gaps: looseString.describe("One line: what was missing or wrong")
        }).passthrough(),
        execute: async (raw) => {
          const e = unwrapArgs(raw);
          const score = toNum(e.score);
          if (score == null) {
            return { recorded: false, error: "score must be a number from 1 to 10" };
          }
          return this.recordEvaluation({
            topic: toStr(e.topic) ?? "general",
            question: toStr(e.question) ?? "(question not given)",
            score,
            strengths: toStr(e.strengths) ?? "",
            gaps: toStr(e.gaps) ?? ""
          });
        }
      }),

      getProgress: tool({
        description: "Get the candidate's scores per topic from long-term memory.",
        inputSchema: z.object({}),
        execute: async () => ({
          questionsAnswered: this.state.questionsAnswered,
          topics: Object.values(this.state.topics).map((t) => ({
            topic: t.topic,
            attempts: t.attempts,
            avgScore: Number(t.avgScore.toFixed(1))
          }))
        })
      }),

      generateFeedbackReport: tool({
        description:
          "Start the background workflow that analyses all recorded answers and produces a feedback report with a 5-day study plan.",
        inputSchema: z.object({}),
        execute: async () => this.startReport()
      })
    };
  }

  // ── Memory ────────────────────────────────────────────────────────────

  private recordEvaluation(e: {
    topic: string;
    question: string;
    score: number;
    strengths: string;
    gaps: string;
  }) {
    const topic = e.topic.trim().toLowerCase();
    const score = Math.round(Math.min(10, Math.max(1, e.score)));
    const now = Date.now();
    const id = crypto.randomUUID();

    this.sql`INSERT INTO evaluations (id, topic, question, score, strengths, gaps, created_at)
      VALUES (${id}, ${topic}, ${e.question}, ${score}, ${e.strengths}, ${e.gaps}, ${now})`;

    const prev = this.state.topics[topic];
    const attempts = (prev?.attempts ?? 0) + 1;
    const stat: TopicStat = {
      topic,
      attempts,
      avgScore: ((prev?.avgScore ?? 0) * (attempts - 1) + score) / attempts,
      lastScore: score,
      lastGap: e.gaps,
      updatedAt: now
    };

    this.setState({
      ...this.state,
      topics: { ...this.state.topics, [topic]: stat },
      questionsAnswered: this.state.questionsAnswered + 1
    });

    return { recorded: true, topic, score, topicAverage: Number(stat.avgScore.toFixed(1)) };
  }

  // ── Workflow coordination ─────────────────────────────────────────────

  @callable()
  async startReport() {
    if (this.state.reportJob?.status === "running") {
      return { started: false, reason: "A report is already being generated." };
    }
    const [{ n }] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM evaluations`;
    if (n === 0) {
      return { started: false, reason: "No answers recorded yet. Answer a few questions first." };
    }

    const params: ReportWorkflowParams = {
      since: this.state.lastReportAt ?? 0,
      profile: this.state.profile
    };
    const instanceId = await this.runWorkflow("FEEDBACK_REPORT_WORKFLOW", params);

    this.setState({
      ...this.state,
      reportJob: { instanceId, status: "running", step: "queued", percent: 0 }
    });
    return { started: true, instanceId };
  }

  /** RPC used by the workflow. Falls back to all history if nothing is new. */
  async getEvaluationsSince(since: number): Promise<Evaluation[]> {
    type Row = Omit<Evaluation, "createdAt"> & { created_at: number };
    let rows = this.sql<Row>`SELECT * FROM evaluations WHERE created_at > ${since} ORDER BY created_at`;
    if (rows.length === 0) {
      rows = this.sql<Row>`SELECT * FROM evaluations ORDER BY created_at DESC LIMIT 30`;
    }
    return rows.map(({ created_at, ...r }) => ({ ...r, createdAt: created_at }));
  }

  /** RPC used by the workflow's final step. */
  async saveReport(report: FeedbackReport) {
    this.sql`INSERT OR REPLACE INTO reports (id, created_at, body)
      VALUES (${report.id}, ${report.createdAt}, ${JSON.stringify(report)})`;
    this.setState({
      ...this.state,
      latestReport: report,
      lastReportAt: report.createdAt,
      reportJob: this.state.reportJob
        ? { ...this.state.reportJob, status: "complete", step: "done", percent: 1 }
        : null
    });
  }

  async onWorkflowProgress(_name: string, instanceId: string, progress: unknown) {
    const p = progress as { step?: string; percent?: number; message?: string };
    this.setState({
      ...this.state,
      reportJob: {
        instanceId,
        status: "running",
        step: p.step ?? "working",
        percent: p.percent ?? 0,
        message: p.message
      }
    });
  }

  async onWorkflowError(_name: string, instanceId: string, error: string) {
    this.setState({
      ...this.state,
      reportJob: { instanceId, status: "errored", step: "failed", percent: 0, message: error }
    });
  }

  // ── Methods the UI calls directly over WebSocket RPC ──────────────────

  @callable()
  async listReports(): Promise<FeedbackReport[]> {
    return this.sql<{ body: string }>`SELECT body FROM reports ORDER BY created_at DESC LIMIT 10`.map(
      (r) => JSON.parse(r.body) as FeedbackReport
    );
  }

  @callable()
  async resetMemory() {
    this.sql`DELETE FROM evaluations`;
    this.sql`DELETE FROM reports`;
    this.setState(initialCoachState);
    // Chat history is cleared by the client via useAgentChat().clearHistory().
    return { reset: true };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;