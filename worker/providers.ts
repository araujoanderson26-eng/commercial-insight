import type { DataCapabilities, ModelConfig, Plan, Report } from "../shared/domain";
import type { CustomerDetails } from "../shared/commercial";
import { query as powerBIQuery } from "./analysis";
import { config, fail, required, type DbUser, type Env } from "./core";
import { manualContext, manualCustomerDetails, manualSearch, queryManual, sourceSettings } from "./manual";
import { assertControlledHmlAISource, assertControlledHmlUser, controlledHmlPolicy } from "./real-hml-policy";
import { assertProductionAI } from './production-ai-budget';

export interface DataProvider {
  sourceType: "manual" | "powerbi";
  versionId: string | null;
  semantics: Pick<ModelConfig, "allowAI" | "measures"> & { capabilities?: DataCapabilities };
  query(plan: Plan): Promise<Report>;
  search?(filters: Plan["filters"], dimension: "client" | "product" | "category", query: string): Promise<{ items: { key: string; name: string }[]; truncated: boolean }>;
  customerDetails?(filters: Plan["filters"]): Promise<CustomerDetails>;
}

/** Re-read policy at each outbound AI boundary; the data snapshot stays pinned. */
export async function assertAssistantAccess(env: Env, provider: DataProvider, actorId?: string) {
  await assertProductionAI(env,actorId);
  await assertControlledHmlAISource(env);
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
  readonly search?: DataProvider["search"];
  readonly customerDetails?: DataProvider["customerDetails"];
  constructor(private env: Env, private user: DbUser, readonly versionId: string,
    readonly semantics: Pick<ModelConfig, "allowAI" | "measures"> & { capabilities?: DataCapabilities }) {
    if (semantics.capabilities) this.search = (filters, dimension, query) => manualSearch(this.env, this.user, filters, dimension, query, this.versionId);
    if (semantics.capabilities) this.customerDetails = filters => manualCustomerDetails(this.env, this.user, filters, this.versionId);
  }
  query(plan: Plan) { return queryManual(this.env, this.user, plan, this.versionId); }
}

/** Resolve human-readable names only inside the provider's authorized snapshot. No fuzzy auto-selection. */
export async function resolvePlanEntities(provider: DataProvider, plan: Plan, activeFilters?: Plan["filters"]) {
  if (!provider.search) return plan;
  const resolved = { ...plan, filters: { ...plan.filters } };
  for(const field of ["categoriesInclude","categoriesExclude"]as const){
    if(!resolved.filters[field]?.length)continue;
    const values:string[]=[];
    for(const requested of resolved.filters[field]!){
      const word=requested.trim().toLocaleUpperCase('pt-BR');
      const macro=({SUCOS:'SUCO',SUCO:'SUCO',VINHOS:'VINHO',VINHO:'VINHO',ESPUMANTES:'ESPUMANTE',ESPUMANTE:'ESPUMANTE'}as Record<string,string>)[word];
      const target=macro?'Macro Categoria: '+macro:word==='GRANEL'?'GRANEL':requested;
      const found=await provider.search({...resolved.filters,category:"",categoriesInclude:[],categoriesExclude:[]},"category",target);
      if(word==='GRANEL'&&!found.truncated){const groups=found.items.filter(v=>!v.key.startsWith('Macro Categoria: ')&&/\bGRANEL\b/iu.test(v.key));if(groups.length){values.push(...groups.map(v=>v.key));continue;}}
      const exact=found.items.filter(v=>v.key.trim().toLocaleLowerCase("pt-BR")===target.trim().toLocaleLowerCase("pt-BR")||v.name.trim().toLocaleLowerCase("pt-BR")===target.trim().toLocaleLowerCase("pt-BR"));
      if(exact.length!==1)fail(422,"Selecione o grupo oficial exato nos filtros de categorias. Famílias genéricas precisam de classificação comercial validada.");
      values.push(exact[0].key);
    }resolved.filters[field]=[...new Set(values)];
  }
  for (const dimension of ["client", "product", "category"] as const) {
    const requested = resolved.filters[dimension];
    if (!requested) continue;
    // Codes selected by the user are authoritative; the subsequent query enforces their ACL.
    if (activeFilters?.[dimension] === requested) continue;
    const result = await provider.search(resolved.filters, dimension, requested);
    const normalize = (value: string) => value.normalize("NFC").trim().toLocaleLowerCase("pt-BR");
    const exact = result.items.filter(item => normalize(item.key) === normalize(requested) || normalize(item.name) === normalize(requested));
    const looksLikeCode = /^[\p{L}\p{N}._/-]+$/u.test(requested)
      && (/\d/u.test(requested) || requested.length <= 3 || requested === requested.toLocaleUpperCase("pt-BR"));
    if (!exact.length && looksLikeCode) fail(422, "O código informado não foi localizado exatamente no seu escopo. Selecione o cadastro correto nos filtros.");
    const candidates = exact.length ? exact : result.items;
    if (candidates.length !== 1 || (!exact.length && result.truncated)) {
      const choices = candidates.slice(0, 5).map(item => item.name).join("; ");
      fail(422, !candidates.length
        ? `Nenhum cadastro de ${dimension === "client" ? "cliente" : dimension === "product" ? "produto" : "categoria"} foi localizado no seu escopo. Pesquise e selecione o código nos filtros.`
        : `Há mais de um cadastro compatível. Selecione o código correto nos filtros: ${choices}${result.truncated ? "; há outros resultados" : ""}.`);
    }
    resolved.filters[dimension] = candidates[0].key;
  }
  return resolved;
}

/** Resolve once per request so totals, charts and AI all use one immutable snapshot. */
export async function dataProvider(env: Env, model: ModelConfig | null, revision: number, user: DbUser,
  historical?: { sourceType: "manual" | "powerbi"; versionId: string | null }): Promise<DataProvider> {
  assertControlledHmlUser(env,user.id);
  const settings = await sourceSettings(env);
  if (controlledHmlPolicy(env) && (historical?.sourceType ?? settings.source) !== "manual") fail(403,"Esta validação usa somente o snapshot manual autorizado.");
  if ((historical?.sourceType ?? settings.source) === "powerbi")
    return new PowerBIProvider(env, model, revision, user);
  const context = await manualContext(env, historical?.versionId ?? undefined);
  return new ManualD1Provider(env, user, context.versionId,
    { allowAI: settings.allowAI, measures: context.measures, capabilities: context.capabilities });
}
