import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { InterviewCoach } from "./server";
import {
  MODEL,
  type Evaluation,
  type FeedbackReport,
  type ReportWorkflowParams,
  type StudyDay
} from "./shared";

interface Analysis {
  overallScore: number;
  headline: string;
  strengths: string[];
  weaknesses: string[];
}

/**
 * Durable, multi-step pipeline that turns raw answer evaluations into a
 * feedback report. Each `step.do` is checkpointed and retried on failure,
 * so a flaky LLM call does not lose the work done by earlier steps.
 *
 *   1. load-evaluations  (RPC back into the agent's SQLite)
 *   2. analyse           (Llama 3.3: strengths / weaknesses / score)
 *   3. study-plan        (Llama 3.3: 5-day plan targeting the weaknesses)
 *   4. save-report       (RPC: persist + push to every open browser tab)
 */
export class FeedbackReportWorkflow extends AgentWorkflow<
  InterviewCoach,
  ReportWorkflowParams
> {
  async run(event: AgentWorkflowEvent<ReportWorkflowParams>, step: AgentWorkflowStep) {
    const { since, profile } = event.payload;

    await this.reportProgress({ step: "Loading your answers", percent: 0.1 });
    const evaluations = await step.do("load-evaluations", async () =>
      this.agent.getEvaluationsSince(since)
    );

    await this.reportProgress({ step: "Analysing performance", percent: 0.35 });
    const analysis = await step.do(
      "analyse",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => this.analyse(evaluations, profile?.targetRole)
    );

    await this.reportProgress({ step: "Building your study plan", percent: 0.7 });
    const studyPlan = await step.do(
      "study-plan",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => this.buildPlan(analysis, profile?.targetRole)
    );

    const report: FeedbackReport = await step.do("save-report", async () => {
      const r: FeedbackReport = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        ...analysis,
        studyPlan,
        evaluationsCovered: evaluations.length
      };
      await this.agent.saveReport(r);
      return r;
    });

    await step.reportComplete(report);
    return report;
  }

  private async analyse(evaluations: Evaluation[], role?: string): Promise<Analysis> {
    const transcript = evaluations
      .map(
        (e, i) =>
          `${i + 1}. [${e.topic}] score ${e.score}/10\n   Q: ${e.question}\n   + ${e.strengths}\n   - ${e.gaps}`
      )
      .join("\n");

    const fallbackScore =
      evaluations.reduce((s, e) => s + e.score, 0) / Math.max(1, evaluations.length);

    const out = await this.askJson<Analysis>(
      `You review mock-interview results for a candidate targeting "${role ?? "software engineer"}".
Return JSON with keys: overallScore (number 1-10), headline (one sentence), strengths (3 short strings), weaknesses (3 short strings, most important first).`,
      transcript,
      {
        type: "object",
        properties: {
          overallScore: { type: "number" },
          headline: { type: "string" },
          strengths: { type: "array", items: { type: "string" } },
          weaknesses: { type: "array", items: { type: "string" } }
        },
        required: ["overallScore", "headline", "strengths", "weaknesses"]
      }
    );

    return {
      overallScore: Number(
        (Number.isFinite(out.overallScore) ? out.overallScore : fallbackScore).toFixed(1)
      ),
      headline: out.headline ?? "Report generated.",
      strengths: (out.strengths ?? []).slice(0, 5),
      weaknesses: (out.weaknesses ?? []).slice(0, 5)
    };
  }

  private async buildPlan(analysis: Analysis, role?: string): Promise<StudyDay[]> {
    const out = await this.askJson<{ plan: StudyDay[] }>(
      `You are a senior engineer mentoring a candidate for "${role ?? "software engineer"}".
Return JSON {"plan": [...]} with exactly 5 items, one per day: {"day": number, "focus": string, "tasks": [2-3 concrete, specific tasks]}. Prioritise the weaknesses.`,
      `Weaknesses:\n- ${analysis.weaknesses.join("\n- ")}\nStrengths:\n- ${analysis.strengths.join("\n- ")}`,
      {
        type: "object",
        properties: {
          plan: {
            type: "array",
            items: {
              type: "object",
              properties: {
                day: { type: "number" },
                focus: { type: "string" },
                tasks: { type: "array", items: { type: "string" } }
              },
              required: ["day", "focus", "tasks"]
            }
          }
        },
        required: ["plan"]
      }
    );
    return (out.plan ?? []).slice(0, 5).map((d, i) => ({
      day: i + 1,
      focus: d.focus,
      tasks: (d.tasks ?? []).slice(0, 4)
    }));
  }

  /** Calls Llama 3.3 in JSON mode. Throws on bad output so the step retries. */
  private async askJson<T>(system: string, user: string, schema: object): Promise<T> {
    const res = (await this.env.AI.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: 1200
    } as never)) as { response?: unknown };

    const raw = res?.response;
    if (raw && typeof raw === "object") return raw as T;
    if (typeof raw === "string") {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]) as T;
    }
    throw new Error("Model did not return valid JSON");
  }
}
