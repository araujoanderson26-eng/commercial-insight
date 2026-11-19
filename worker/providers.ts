import type { DataCapabilities, ModelConfig, Plan, Report } from "../shared/domain";
import { query as powerBIQuery } from "./analysis";
import { config, fail, required, type DbUser, type Env } from "./core";
import { manualContext, queryManual, sourceSettings } from "./manual";

export interface DataProvider {
  sourceType: "manual" | "powerbi";
  versionId: string | null;
  semantics: Pick<ModelConfig, "allowAI" | "measures"> & { capabilities?: DataCapabilities };
  query(plan: Plan): Promise<Report>;
}

/** Re-read policy at each outbound AI boundary; the data snapshot stays pinned. */
export async function assertAssistantAccess(env: Env, provider: DataProvider) {
  const allowed = provider.sourceType === "manual"
    ? (await sourceSettings(env)).allowAI
    : (await config(env)).model?.allowAI;
  if (!allowed) fail(409, "O administrador desabilitou a análise com IA para esta fonte.");
}

export class PowerBIProvider implements DataProvider {
  readonly sourceType = "powerbi";
  readonly versionId = null;
  readonly semantics: ModelConfig;
  constructor(private env: Env, model: ModelConfig | null, private revision: number, private user: DbUser) {
    this.semantics = required(model);
  }
  query(plan: Plan) { return powerBIQuery(this.env, this.semantics, this.revision, this.user, plan); }
}

export class ManualD1Provider implements DataProvider {
  readonly sourceType = "manual";
  constructor(private env: Env, private user: DbUser, readonly versionId: string,
    readonly semantics: Pick<ModelConfig, "allowAI" | "measures"> & { capabilities?: DataCapabilities }) {}
  query(plan: Plan) { return queryManual(this.env, this.user, plan, this.versionId); }
}

/** Resolve once per request so totals, charts and AI all use one immutable snapshot. */
export async function dataProvider(env: Env, model: ModelConfig | null, revision: number, user: DbUser,
  historical?: { sourceType: "manual" | "powerbi"; versionId: string | null }): Promise<DataProvider> {
  const settings = await sourceSettings(env);
  if ((historical?.sourceType ?? settings.source) === "powerbi")
    return new PowerBIProvider(env, model, revision, user);
  const context = await manualContext(env, historical?.versionId ?? undefined);
  return new ManualD1Provider(env, user, context.versionId,
    { allowAI: settings.allowAI, measures: context.measures, capabilities: context.capabilities });
}
