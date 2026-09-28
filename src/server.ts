import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import {
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
  type ReportWorkflowParams,
  type TopicStat
} from "./shared";

export { FeedbackReportWorkflow } from "./workflow";

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

    const result = streamText({
      model: workersai(MODEL),
      system: this.buildSystemPrompt(),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: this.tools(),
      stopWhen: stepCountIs(6),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
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
      : `No profile yet. Start by briefly asking the candidate for their target role, years of experience, interview type (dsa, system-design, lld, behavioral or mixed) and focus areas, then call saveProfile.`;

    return `You are "Coach", a friendly but rigorous technical interviewer running mock interviews for software engineers.

${memory}

HOW TO RUN THE INTERVIEW
1. Ask ONE question at a time, tailored to the profile. Prefer the candidate's weakest topics, but mix in new ones.
2. After the candidate answers, ALWAYS call recordEvaluation with an honest score from 1 to 10, one line of strengths and one line of gaps. Then give short feedback (2-4 bullets) and a model-answer hint, and ask the next question or a follow-up.
3. If they say "skip" or "hint", help without scoring.
4. If they ask how they are doing, call getProgress.
5. If they ask for a report, summary or study plan, or say they are done, call generateFeedbackReport and tell them it is being generated in the sidebar.
6. Keep replies concise and use Markdown. Never invent scores that were not recorded.`;
  }

  private tools() {
    return {
      saveProfile: tool({
        description:
          "Save or update the candidate's profile in long-term memory. Call after learning their target role, experience, interview type or focus areas.",
        inputSchema: z.object({
          name: z.string().optional().describe("Candidate's first name"),
          targetRole: z.string().describe("e.g. 'Senior Backend Engineer'"),
          yearsOfExperience: z.coerce.number().optional(),
          interviewType: z
            .enum(["dsa", "system-design", "lld", "behavioral", "mixed"])
            .describe("Kind of interview to practise"),
          focusAreas: z
            .array(z.string())
            .default([])
            .describe("Topics to focus on, e.g. ['kafka', 'caching']")
        }),
        execute: async (profile) => {
          this.setState({ ...this.state, profile });
          return { saved: true, profile };
        }
      }),

      recordEvaluation: tool({
        description:
          "Record the score for the candidate's answer to the last question. Call this after every real answer.",
        inputSchema: z.object({
          topic: z
            .string()
            .describe("Short lowercase topic, e.g. 'rate limiting', 'graphs', 'caching'"),
          question: z.string().describe("The question that was answered"),
          score: z.coerce.number().min(1).max(10).describe("1 = poor, 10 = excellent"),
          strengths: z.string().describe("One line: what was good"),
          gaps: z.string().describe("One line: what was missing or wrong")
        }),
        execute: async (e) => this.recordEvaluation(e)
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
