# cf_ai_interview_coach

An AI mock-interview coach that runs entirely on Cloudflare. It asks interview questions tailored to your target role, scores every answer, **remembers your weak topics across sessions**, and runs a durable **Workflow** that turns your answers into a feedback report and a 5-day study plan. You can type or **answer by voice**.

> **Live demo:** `https://cf-ai-interview-coach.<your-subdomain>.workers.dev` ← _replace after `npm run deploy`_

## How it meets the assignment

| Requirement | How it is implemented | Where |
|---|---|---|
| **LLM** | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Workers AI, via the AI SDK + `workers-ai-provider` for streamed chat with tool calling, and in JSON-schema mode inside the workflow | `src/server.ts`, `src/workflow.ts` |
| **Workflow / coordination** | `InterviewCoach` agent (Durable Object) orchestrates the chat loop and tools; `FeedbackReportWorkflow` (Cloudflare Workflows) runs a 4-step durable pipeline with retries and exponential backoff, reports progress back to the agent, and saves results via RPC | `src/server.ts`, `src/workflow.ts` |
| **User input (chat or voice)** | React chat UI served as static assets from the same Worker, connected to the agent over WebSocket (`useAgent` + `useAgentChat`). Voice input via the browser Web Speech API, with optional spoken replies | `src/app.tsx` |
| **Memory / state** | Per-user Durable Object with SQLite. Chat history is persisted automatically; profile and per-topic running scores live in agent state (live-synced to the UI); raw evaluations and reports are stored in SQL tables. Memory is injected into the system prompt on every turn | `src/server.ts` |

## Architecture

```
Browser (React, Web Speech API)
   │  WebSocket  /agents/interview-coach/<user-id>
   ▼
Worker ── routeAgentRequest ──► InterviewCoach  (Durable Object, one per user)
                                 │  • AIChatAgent: streams Llama 3.3 replies
                                 │  • tools: saveProfile, recordEvaluation,
                                 │           getProgress, generateFeedbackReport
                                 │  • state: profile, topic scores, report job  ──► synced to UI
                                 │  • SQLite: messages, evaluations, reports
                                 │
                                 └─ runWorkflow() ──► FeedbackReportWorkflow
                                                       1. load-evaluations  (RPC → agent SQL)
                                                       2. analyse           (Llama 3.3, JSON mode)
                                                       3. study-plan        (Llama 3.3, JSON mode)
                                                       4. save-report       (RPC → agent state)
                                                       progress ──► onWorkflowProgress ──► UI
```

**Flow of one session**

1. You introduce yourself. The model calls `saveProfile`, which writes to agent state; the sidebar updates instantly.
2. The coach asks a question. After you answer, it calls `recordEvaluation` (score 1–10, strengths, gaps). This inserts a row in SQLite and updates the running average for that topic.
3. Every turn, the system prompt is rebuilt from memory (profile + the 5 weakest topics), so the coach steers towards what you are worst at, even after a reload or on another day.
4. When you say you're done (or click **Generate report**), the agent starts `FeedbackReportWorkflow`. Each step is checkpointed, so a failed LLM call retries without redoing earlier steps. Progress streams to the sidebar, and the final report is saved to memory.

**Why an Agent and a Workflow?** The agent handles real-time work (chat streaming, WebSockets, state sync). The workflow handles multi-step background work that must survive failures (several LLM calls with retries). This is the split recommended in the Cloudflare docs.

## Run it locally

Prerequisites: Node.js 20+ and a free Cloudflare account (Workers AI has a free daily allowance).

```bash
git clone https://github.com/<you>/cf_ai_interview_coach.git
cd cf_ai_interview_coach
npm install
npx wrangler login        # Workers AI runs remotely even in local dev
npm run dev               # opens http://localhost:5173
```

Things to try:

1. Click the first suggestion, or type: _"I'm a backend engineer with 3 years of experience, practising system design."_ → check that the **Memory** panel fills in.
2. Answer 2–3 questions (type, or click 🎤 to speak). A chip shows the score, and the **Topics** bars update.
3. Reload the page. Your chat, profile and scores are still there (Durable Object memory).
4. Type _"I'm done, generate my report"_ or click **Generate report**. Watch the workflow's progress, then open the 5-day study plan.
5. Tick **Speak replies** to hear the coach's answers.

Voice input uses the Web Speech API, which works in Chrome and Edge. In other browsers the mic button is hidden and text chat still works.

## Deploy

```bash
npm run deploy            # vite build && wrangler deploy
```

Wrangler prints your `*.workers.dev` URL. Paste it into the **Live demo** line at the top of this README.

## Project layout

```
src/
  server.ts     InterviewCoach agent: chat loop, tools, memory, workflow callbacks, RPC
  workflow.ts   FeedbackReportWorkflow: durable 4-step report pipeline
  shared.ts     Types and the model id shared by the Worker and the UI
  app.tsx       React UI: chat, voice input/output, memory sidebar, report card
  styles.css    Styles (light and dark)
wrangler.jsonc  Bindings: Workers AI, Durable Object (SQLite), Workflow, static assets
PROMPTS.md      AI prompts used while building this project
```

## Design notes and trade-offs

- **One Durable Object per user.** The browser generates a random id (stored in `localStorage`) and uses it as the agent name. This gives each user isolated, strongly consistent memory with no external database. For production I would replace this with real authentication.
- **Scores are running averages per topic**, not a full model of skill. It is simple, explainable and cheap to inject into the prompt.
- **Structured output in the workflow** uses Workers AI JSON-schema mode. The parser also accepts a JSON string as a fallback and throws on invalid output, which makes the step retry.
- **Tool-calling reliability.** Llama 3.3 occasionally skips `recordEvaluation`. The system prompt tells it to call the tool after every answer, and scores are only ever shown from recorded data.
- **Possible extensions:** Realtime voice (speech-to-text and text-to-speech on Workers AI), scheduled daily practice reminders with `this.schedule()`, and Vectorize retrieval over a question bank.
