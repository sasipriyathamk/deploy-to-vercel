export type AiVerdictLabel = "strong" | "ok" | "avoid" | "unavailable";

export type HolderThesis = {
  who: string;
  text: string;
  sizeUsd: number;
  unrealizedUsd: number;
  realizedUsd: number;
  pnlPct: number;
  closed: boolean;
  likes: number;
  replies: number;
  at: string;
};

export type AiVerdictBody = {
  verdict: "strong" | "ok" | "avoid";
  conviction: number;
  bullPoints: string[];
  redFlags: string[];
  narrative: string;
  invalidation: string;
  holderSummary: string;
  reasoning: string;
};

export type AiShadowVerdict = {
  verdict: AiVerdictLabel;
  conviction: number | null;
  bullPoints: string[];
  redFlags: string[];
  narrative: string | null;
  invalidation: string | null;
  holderSummary: string | null;
  reasoning: string | null;
  unavailableReason: string | null;
  model: string | null;
  createdAt: string;
  stage: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  theses: HolderThesis[];
};

export type ShadowBucket = {
  verdict: "strong" | "ok" | "avoid";
  n: number;
  withGain: number;
  avgGainPct: number | null;
  medianGainPct: number | null;
  avgAthGainPct: number | null;
  medianAthGainPct: number | null;
};

export type ShadowStats = {
  shadow: true;
  configured: boolean;
  fomoConfigured: boolean;
  dailyCap: number;
  usedToday: number;
  dayStart: string;
  buckets: ShadowBucket[];
};
