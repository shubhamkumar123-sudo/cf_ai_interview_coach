import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import type { InterviewCoach } from "./server";
import type { CoachState, FeedbackReport, TopicStat } from "./shared";

// Each browser gets a stable id → its own InterviewCoach Durable Object,
// so memory survives reloads and is private to that user.
function getUserId(): string {
  const KEY = "interview-coach-user";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return "anonymous";
  }
}

const STARTERS = [
  "Hi! I'm a backend engineer with 3 years of experience preparing for Senior SDE system-design rounds.",
  "Give me a DSA question on graphs.",
  "How am I doing so far?",
  "I'm done for today — generate my feedback report."
];

// ── Voice (browser Web Speech API: speech-to-text + text-to-speech) ─────

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

function useSpeechInput(onText: (t: string) => void) {
  const recRef = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const Ctor = (window as unknown as Record<string, unknown>).SpeechRecognition ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  const supported = typeof Ctor === "function";

  const toggle = useCallback(() => {
    if (!supported) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new (Ctor as new () => Recognition)();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      onText(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }, [Ctor, listening, onText, supported]);

  return { supported, listening, toggle };
}

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const plain = text.replace(/[#*`_>|-]/g, " ").replace(/\s+/g, " ").slice(0, 1200);
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
}

// ── Message rendering ───────────────────────────────────────────────────

function toolLabel(name: string, input: Record<string, unknown> | undefined, done: boolean) {
  switch (name) {
    case "recordEvaluation":
      return done
        ? `📝 Scored “${String(input?.topic ?? "answer")}”: ${String(input?.score ?? "?")}/10`
        : "📝 Scoring your answer…";
    case "saveProfile":
      return done ? "💾 Profile saved to memory" : "💾 Saving profile…";
    case "getProgress":
      return "📊 Checked your progress";
    case "generateFeedbackReport":
      return "⚙️ Started feedback-report workflow";
    default:
      return `🔧 ${name}`;
  }
}

function Message({ msg }: { msg: UIMessage }) {
  return (
    <div className={`msg ${msg.role}`}>
      {msg.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          return (
            <div key={i} className="bubble">
              {msg.role === "assistant" ? <Streamdown>{part.text}</Streamdown> : part.text}
            </div>
          );
        }
                if (isToolUIPart(part)) {
          if (part.state === "output-error") {
            return (
              <div key={i} className="tool-chip error" title={part.errorText}>
                ⚠️ {getToolName(part)} failed{part.errorText ? `: ${part.errorText.slice(0, 120)}` : ""}
              </div>
            );
          }
          const done = part.state === "output-available";
          return (
            <div key={i} className={`tool-chip ${done ? "done" : ""}`}>
              {toolLabel(getToolName(part), part.input as Record<string, unknown>, done)}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ── Sidebar: memory + workflow status ───────────────────────────────────

function TopicBar({ t }: { t: TopicStat }) {
  const pct = (t.avgScore / 10) * 100;
  const tone = t.avgScore >= 7 ? "good" : t.avgScore >= 5 ? "ok" : "weak";
  return (
    <div className="topic" title={`Last gap: ${t.lastGap}`}>
      <div className="topic-row">
        <span>{t.topic}</span>
        <span className="muted">
          {t.avgScore.toFixed(1)} · {t.attempts}×
        </span>
      </div>
      <div className="bar">
        <div className={`fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReportCard({ report }: { report: FeedbackReport }) {
  return (
    <div className="report">
      <div className="report-head">
        <div className="score">{report.overallScore.toFixed(1)}</div>
        <div>
          <div className="headline">{report.headline}</div>
          <div className="muted small">
            {new Date(report.createdAt).toLocaleString()} · {report.evaluationsCovered} answers
          </div>
        </div>
      </div>
      <h4>Strengths</h4>
      <ul>{report.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
      <h4>Work on</h4>
      <ul>{report.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul>
      <details>
        <summary>5-day study plan</summary>
        {report.studyPlan.map((d) => (
          <div key={d.day} className="plan-day">
            <strong>Day {d.day}: {d.focus}</strong>
            <ul>{d.tasks.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </div>
        ))}
      </details>
    </div>
  );
}

function Sidebar({
  state,
  onReport,
  onReset
}: {
  state: CoachState | undefined;
  onReport: () => void;
  onReset: () => void;
}) {
  const topics = useMemo(
    () => Object.values(state?.topics ?? {}).sort((a, b) => a.avgScore - b.avgScore),
    [state?.topics]
  );
  const job = state?.reportJob;
  const running = job?.status === "running";

  return (
    <aside className="sidebar">
      <section>
        <h3>Memory</h3>
        {state?.profile ? (
          <div className="profile">
            <div><strong>{state.profile.name ?? "Candidate"}</strong></div>
            <div className="muted">{state.profile.targetRole}</div>
            <div className="muted small">
              {state.profile.interviewType}
              {state.profile.yearsOfExperience != null && ` · ${state.profile.yearsOfExperience} yrs`}
            </div>
            {state.profile.focusAreas.length > 0 && (
              <div className="tags">
                {state.profile.focusAreas.map((f) => <span key={f} className="tag">{f}</span>)}
              </div>
            )}
          </div>
        ) : (
          <p className="muted small">No profile yet — introduce yourself in the chat.</p>
        )}
      </section>

      <section>
        <h3>Topics <span className="muted small">({state?.questionsAnswered ?? 0} answered)</span></h3>
        {topics.length ? topics.map((t) => <TopicBar key={t.topic} t={t} />) : (
          <p className="muted small">Scores appear here as you answer questions.</p>
        )}
      </section>

      <section>
        <h3>Feedback report</h3>
        <button className="primary" onClick={onReport} disabled={running || !state?.questionsAnswered}>
          {running ? "Generating…" : "Generate report"}
        </button>
        {job && job.status !== "complete" && (
          <div className="job">
            <div className="muted small">
              Workflow {job.status}: {job.step}
              {job.message && job.status === "errored" ? ` — ${job.message}` : ""}
            </div>
            {running && (
              <div className="bar"><div className="fill ok" style={{ width: `${job.percent * 100}%` }} /></div>
            )}
          </div>
        )}
        {state?.latestReport && <ReportCard report={state.latestReport} />}
      </section>

      <button className="ghost danger" onClick={onReset}>Reset memory & chat</button>
    </aside>
  );
}

// ── App ─────────────────────────────────────────────────────────────────

export default function App() {
  const userId = useMemo(getUserId, []);
  const agent = useAgent<InterviewCoach, CoachState>({ agent: "InterviewCoach", name: userId });
  const { messages, sendMessage, clearHistory, status, stop } = useAgentChat({ agent });

  const [input, setInput] = useState("");
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "streaming" || status === "submitted";

  const mic = useSpeechInput(setInput);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Read the assistant's reply aloud when it finishes (optional voice mode).
  const lastSpoken = useRef<string | null>(null);
  useEffect(() => {
    if (!voiceReplies || busy) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || lastSpoken.current === last.id) return;
    lastSpoken.current = last.id;
    const text = last.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    if (text.trim()) speak(text);
  }, [messages, busy, voiceReplies]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    if (mic.listening) mic.toggle();
    sendMessage({ text: t });
    setInput("");
  };

  const onReport = async () => {
    const res = (await agent.stub.startReport()) as { started: boolean; reason?: string };
    if (!res.started) setNotice(res.reason ?? "Could not start report.");
  };

  const onReset = async () => {
    if (!window.confirm("Delete your profile, scores, reports and chat history?")) return;
    await agent.stub.resetMemory();
    clearHistory();
  };

  return (
    <div className="layout">
      <main className="chat">
        <header>
          <div>
            <h1>Interview Coach</h1>
            <p className="muted small">Llama 3.3 on Workers AI · Agents SDK · Workflows</p>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={voiceReplies} onChange={(e) => setVoiceReplies(e.target.checked)} />
            Speak replies
          </label>
        </header>

        <div className="messages">
          {messages.length === 0 && (
            <div className="empty">
              <h2>Practise your next interview</h2>
              <p className="muted">
                Tell the coach your target role. It asks questions, scores each answer, remembers your weak
                topics across sessions, and builds a study plan when you're done.
              </p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s} onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => <Message key={m.id} msg={m} />)}
          {status === "submitted" && <div className="typing">Coach is thinking…</div>}
          <div ref={endRef} />
        </div>

        {notice && (
          <div className="notice" onClick={() => setNotice(null)}>{notice} <span className="muted">(dismiss)</span></div>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            value={input}
            placeholder={mic.listening ? "Listening… speak your answer" : "Type your answer, or use the mic"}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          {mic.supported && (
            <button type="button" className={`icon ${mic.listening ? "rec" : ""}`} onClick={mic.toggle}
              title={mic.listening ? "Stop recording" : "Answer by voice"}>
              {mic.listening ? "■" : "🎤"}
            </button>
          )}
          {busy ? (
            <button type="button" className="primary" onClick={() => stop()}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={!input.trim()}>Send</button>
          )}
        </form>
      </main>

      <Sidebar state={agent.state} onReport={onReport} onReset={onReset} />
    </div>
  );
}
