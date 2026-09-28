// Types shared by the Worker (agent + workflow) and the React client.

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type InterviewType = "dsa" | "system-design" | "lld" | "behavioral" | "mixed";

export interface Profile {
  name?: string;
  targetRole: string;
  yearsOfExperience?: number;
  interviewType: InterviewType;
  focusAreas: string[];
}

export interface TopicStat {
  topic: string;
  attempts: number;
  /** Running average of scores out of 10. */
  avgScore: number;
  lastScore: number;
  lastGap: string;
  updatedAt: number;
}

export interface StudyDay {
  day: number;
  focus: string;
  tasks: string[];
}

export interface FeedbackReport {
  id: string;
  createdAt: number;
  overallScore: number;
  headline: string;
  strengths: string[];
  weaknesses: string[];
  studyPlan: StudyDay[];
  evaluationsCovered: number;
}

export interface ReportJob {
  instanceId: string;
  status: "running" | "complete" | "errored";
  step: string;
  percent: number;
  message?: string;
}

export interface CoachState {
  profile: Profile | null;
  topics: Record<string, TopicStat>;
  questionsAnswered: number;
  lastReportAt: number | null;
  latestReport: FeedbackReport | null;
  reportJob: ReportJob | null;
}

export const initialCoachState: CoachState = {
  profile: null,
  topics: {},
  questionsAnswered: 0,
  lastReportAt: null,
  latestReport: null,
  reportJob: null
};

export interface Evaluation {
  id: string;
  topic: string;
  question: string;
  score: number;
  strengths: string;
  gaps: string;
  createdAt: number;
}

export interface ReportWorkflowParams {
  since: number;
  profile: Profile | null;
}
