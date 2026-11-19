import type { Filters, Metric, Report } from "./domain";

/** Each observation is derived from authorized report values, never inferred transactions. */
export type CommercialInsight = {
  id: string;
  kind: "fact" | "hypothesis" | "recommendation";
  severity: "neutral" | "warning" | "favorable";
  title: string;
  detail: string;
  metric: Metric;
  impact: number | null;
  period: { from: string; to: string };
  action: string;
};

export type CustomerDetails = {
  lastPurchase: string | null;
  purchaseDays: number | null;
  municipality: string | null;
  limitations: string[];
  period: { from: string; to: string };
};

export type VisitBriefing = {
  client: {
    code: string;
    name: string;
    municipality: string | null;
    states: string[];
    representatives: string[];
    regionals: string[];
  };
  filters: Filters;
  timeline: Report;
  products: Report;
  productLosses: Report;
  categories: Report | null;
  insights: CommercialInsight[];
  summary: string;
  objectives: string[];
  questions: string[];
  recommendations: string[];
  activity: {
    lastPurchase: string | null;
    lastPurchaseMonth: string | null;
    purchaseDays: number | null;
    monthsWithPurchases: number;
    monthsAnalyzed: number;
    observedProductCount: number;
    productCountIsPartial: boolean;
  };
  limitations: string[];
  generatedAt: string;
};

export type AssistantStatus = {
  source: "manual" | "powerbi";
  enabledForSource: boolean;
  credentialConfigured: boolean;
  model: string;
  ready: boolean;
  reason: "ready" | "source_disabled" | "credential_missing";
  pending: ("source_disabled" | "credential_missing")[];
  message: string;
};
