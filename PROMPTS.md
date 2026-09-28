# AI prompts used

I used an AI coding assistant (Claude) during development, as the assignment allows. Below are the prompts I gave it, followed by the runtime prompts the app sends to Llama 3.3.

## 1. Development prompts (AI-assisted coding)

**Initial request**
> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components: LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice; Workflow / coordination (recommend using Workflows, Workers or Durable Objects); User input via chat or voice (recommend using Pages or Realtime); Memory or state. https://developers.cloudflare.com/agents/ — can you help me with this?

**Idea and architecture** (summarised)
> Build an AI mock-interview coach using the current Cloudflare Agents SDK. Use AIChatAgent (Durable Object) for chat and memory, with Llama 3.3 70B on Workers AI. Add tools for saving a candidate profile, scoring each answer and checking progress. Store evaluations in the agent's SQLite and keep per-topic running averages in agent state synced to the UI. Add a Cloudflare Workflow that loads the evaluations, analyses them with the LLM, builds a 5-day study plan and saves the report back to the agent, reporting progress along the way. Build a React chat UI with voice input (Web Speech API), optional spoken replies and a sidebar showing memory and report status.

**Verification**
> Typecheck, build and dry-run deploy. Smoke-test the agent's state sync and RPC locally, and test the workflow end-to-end with a stubbed LLM.

<!-- Add any further prompts you use while iterating on the project below. -->

## 2. Runtime prompts (sent to Llama 3.3 by the app)

### Chat system prompt (`src/server.ts` → `buildSystemPrompt`)
This prompt is rebuilt every turn. The memory block is filled in from the agent's state.

```
You are "Coach", a friendly but rigorous technical interviewer running mock interviews for software engineers.

CANDIDATE PROFILE (from memory): name, target role, experience, interview type, focus areas, questions answered
WEAKEST TOPICS SO FAR: up to 5 topics with average score, attempts and last gap
LAST REPORT HEADLINE: ...

HOW TO RUN THE INTERVIEW
1. Ask ONE question at a time, tailored to the profile. Prefer the candidate's weakest topics, but mix in new ones.
2. After the candidate answers, ALWAYS call recordEvaluation with an honest score from 1 to 10, one line of strengths and one line of gaps. Then give short feedback (2-4 bullets) and a model-answer hint, and ask the next question or a follow-up.
3. If they say "skip" or "hint", help without scoring.
4. If they ask how they are doing, call getProgress.
5. If they ask for a report, summary or study plan, or say they are done, call generateFeedbackReport and tell them it is being generated in the sidebar.
6. Keep replies concise and use Markdown. Never invent scores that were not recorded.
```

### Workflow step "analyse" (`src/workflow.ts`)
```
You review mock-interview results for a candidate targeting "<role>".
Return JSON with keys: overallScore (number 1-10), headline (one sentence), strengths (3 short strings), weaknesses (3 short strings, most important first).
```

### Workflow step "study-plan" (`src/workflow.ts`)
```
You are a senior engineer mentoring a candidate for "<role>".
Return JSON {"plan": [...]} with exactly 5 items, one per day: {"day": number, "focus": string, "tasks": [2-3 concrete, specific tasks]}. Prioritise the weaknesses.
```
