import { createHash } from "node:crypto";
import { z } from "zod";
import { metricKeys, monthsBetween, filtersSchema, type Filters, type Metric, type Plan, type Report, type Row } from "../shared/domain";
import {
  MANUAL_SOURCE, UPLOAD_PART_BYTES, MAX_MANIFEST_BYTES, MAX_DATA_PART_BYTES,MAX_PART_ROWS,
  DEFAULT_MAX_PACKAGE_BYTES, decimalInteger, factSchema, manifestSchema,
  type ManualManifest, type ManualMetric, type ControlFilters,
} from "../shared/manual";
import { audit, body, fail, json, now, stmt, type DbUser, type Env } from "./core";
import { assertControlledHmlManifest, assertControlledHmlPackage, assertControlledHmlUser, controlledHmlFilters, controlledHmlPolicy } from "./real-hml-policy";
import { nativeCapabilities, nativeControl, nativeControlResult, nativeCustomerDetails, nativeOptions, nativePeriod, nativeSearch, nativePartStatements, nativeStorageTables, nativeValues, queryNative, validateNativeModel,validateNativeStorage,type NativeResult } from "./native-model";

export type ManualJob={jobId:string};
type ManualEnv = Env & { BUCKET: R2Bucket; MANUAL_MAX_BYTES?: string; MANUAL_ALLOW_SYNTHETIC?: string; MANUAL_JOBS?:Queue<ManualJob> };
type ImportRow = {
  id: string; owner: string; actor: string; filename: string; bytes: number; sha256: string;
  object_key: string; upload_id: string | null; status: string; base_generation: number;
  uploaded_bytes: number; processed_bytes: number; part_cursor: number; rows: number; tables: number;
  manifest: string | null; report: string | null; error: string | null; created: number; updated: number;
  published: number | null; lease_token: string | null; lease_until: number;
};
type SourceRow = { source: "manual" | "powerbi"; active_version_id: string | null; generation: number; latest_import_id: string | null; stale_days: number; allow_ai: number; active_at:number|null; active_actor:string|null };
type Check = { name: string; status: "passed" | "warning" | "failed"; detail: string };
type ValidationReport = { checks: Check[]; controls: { metric: string; context: string; expected: string | null; actual: string | null; passed: boolean; filters: ControlFilters; referenceDate: string; dax: string; tolerance: string }[]; errors: { table?: string; row?: number; column?: string; message: string }[]; metrics: ManualManifest["metrics"]; stage?: "integrity"|"structure"|"keys"|"precision"|"continuity"|"controls"|"publish"; controlCursor?: number; keyCursor?:number };
const MANUAL_PREFIX = "commercial-insight/manual/";
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const manualEnv = (e: Env): ManualEnv => {
  if (!(e as Partial<ManualEnv>).BUCKET) fail(503, "O armazenamento privado da atualização não está configurado.");
  return e as ManualEnv;
};
const maxBytes = (e: Env) => Math.min(2 * 1024 ** 3, Math.max(UPLOAD_PART_BYTES, Number((e as ManualEnv).MANUAL_MAX_BYTES) || DEFAULT_MAX_PACKAGE_BYTES));
const errorText = (err: unknown) => err instanceof Error ? err.message.slice(0, 1800) : "Falha na importação.";
function parsed(row: ImportRow) { return row.manifest ? manifestSchema.parse(JSON.parse(row.manifest)) : null; }
async function sourceRow(e: Env): Promise<SourceRow> {
  return (await stmt(e, "SELECT * FROM ci_sources WHERE id=?", MANUAL_SOURCE).first<SourceRow>()) ?? fail(503, "A migração de atualização manual ainda não foi aplicada.");
}
export async function sourceSettings(e: Env) {
  const s = await sourceRow(e);
  return { source: s.source, allowAI: !!s.allow_ai, staleDays: s.stale_days };
}
async function getImport(e: Env, id: string) {
  return (await stmt(e, "SELECT * FROM ci_imports WHERE id=?", id).first<ImportRow>()) ?? fail(404, "Importação não encontrada.");
}
async function publishedVersion(e: Env, id?: string) {
  const versionId = id || (await sourceRow(e)).active_version_id;
  if (!versionId) fail(409, "Nenhuma base manual válida foi publicada. O administrador precisa enviar uma atualização.");
  const row = await getImport(e, versionId);
  if (!row.published || row.status !== "published") fail(409, "Esta versão não está disponível para consulta.");
  const manifest = parsed(row) ?? fail(409, "Manifesto da versão indisponível.");
  assertControlledHmlManifest(e, manifest, row.sha256,true);
  return { row, manifest };
}
export async function manualContext(e: Env, versionId?: string) {
  const { row, manifest } = await publishedVersion(e, versionId);
  return {
    versionId: row.id,
    capabilities:manifest.formatVersion===2?nativeCapabilities(manifest):undefined,
    measures: Object.fromEntries(metricKeys.map((key) => {
      const m = manifest.metrics.find((m) => m.id === key && m.status === "validated" && m.kind !== "unavailable");
      return [key, m?.originalName ?? null];
    })) as Record<Metric, string | null> & {revenue:string},
  };
}
function activeInfo(row: ImportRow, source:SourceRow) {
  const m = parsed(row)!;
  return { id: row.id, publishedAt: iso(source.active_at??row.published!), actor: source.active_actor??row.actor, importedPublishedAt:iso(row.published!), uploadedAt:iso(row.created), extractedAt: m.extractedAt,
    sourceUpdatedAt: m.sourceUpdatedAt, from: m.projection.from, to: m.projection.to,
    rows: m.inventory.tables.reduce((sum,table)=>sum+table.rowCount,0), projectionRows:m.projection.rowCount, processedRows:row.rows, tables: row.tables, model: m.model.name, referenceDate: m.referenceDate, capabilities:m.formatVersion===2?nativeCapabilities(m):undefined };
}
export async function dataStatus(e: Env) {
  const s = await sourceRow(e);
  const active = s.active_version_id ? await getImport(e, s.active_version_id) : null;
  if (active?.published) assertControlledHmlManifest(e, parsed(active)!, active.sha256,true);
  return { source: s.source, staleDays: s.stale_days, allowAI: !!s.allow_ai,
    active: active?.published ? activeInfo(active,s) : null,
    stale: active?.published ? Date.now()-new Date(parsed(active)!.sourceUpdatedAt??parsed(active)!.extractedAt).valueOf()>s.stale_days*86400000 : false };
}
export async function manualSearch(e: Env, u: DbUser, filters: Filters, dimension: "client" | "product" | "category", query: string, versionId?: string) {
  filters = controlledHmlFilters(e, u, filters);
  if (u.role === "operador" || u.update_only) fail(403,"O operador de atualização não possui acesso às análises comerciais.");
  const {row,manifest} = await publishedVersion(e,versionId);
  if (manifest.formatVersion !== 2) fail(422,"A pesquisa por descrição requer um pacote nativo v2.");
  return nativeSearch(e,u,filters,manifest,row.id,dimension,query);
}
export async function manualCustomerDetails(e: Env, u: DbUser, filters: Filters, versionId?: string) {
  filters = controlledHmlFilters(e, u, filters);
  if (u.role === "operador" || u.update_only) fail(403,"O operador de atualização não possui acesso às análises comerciais.");
  const {row,manifest} = await publishedVersion(e,versionId);
  if (manifest.formatVersion !== 2) fail(422,"Os detalhes diários exigem um pacote nativo v2.");
  return nativeCustomerDetails(e,u,filters,manifest,row.id);
}
async function status(e: Env, operator?: string) {
  const rows = (await stmt(e, "SELECT * FROM ci_imports" + (operator ? " WHERE owner=?" : "") + " ORDER BY seq DESC LIMIT 30", ...(operator ? [operator] : [])).all<ImportRow>()).results;
  const history = [];
  for (const r of rows) {
    const manifest=parsed(r);
    const parts = (await stmt(e, "SELECT part AS partNumber,etag FROM ci_upload_parts WHERE import_id=? ORDER BY part", r.id).all()).results;
    history.push({ id: r.id, versionId: r.id, status: r.status, created: iso(r.created), updated: iso(r.updated),
      filename: r.filename, bytes: r.bytes, uploadedBytes: r.uploaded_bytes, processedBytes: r.processed_bytes,
      rows: manifest?manifest.inventory.tables.reduce((sum,table)=>sum+table.rowCount,0):0, projectionRows:manifest?.projection.rowCount??0, processedRows:r.rows, actor:r.actor, uploadedAt:iso(r.created), tables: r.tables, error: r.error, report: r.report ? JSON.parse(r.report) : null,
      publishedAt: r.published ? iso(r.published) : null, uploadedParts: parts });
  }
  return { ...await dataStatus(e), history, limits: { partBytes: UPLOAD_PART_BYTES, maxBytes: maxBytes(e), format: ".ci.ndjson" } };
}
export async function manualRoute(req: Request, e: Env, u: DbUser, path: string): Promise<Response | null> {
  assertControlledHmlUser(e, u.id);
  const method = req.method;
  if (path === "/data/status" && method === "GET") return json(await dataStatus(e));
  if (path === "/data/options" && method === "POST") {
    if (u.role === "operador") fail(403, "O operador de atualização não possui acesso às análises comerciais.");
    return json(await manualOptions(e,u,filtersSchema.parse(await body(req))));
  }
  if (path === "/data/search" && method === "POST") {
    if (u.role === "operador") fail(403, "O operador de atualização não possui acesso às análises comerciais.");
    const value = z.object({filters:filtersSchema,dimension:z.enum(["client","product","category"]),query:z.string().trim().min(1).max(100)}).strict().parse(await body(req));
    const source = await sourceRow(e);
    if (source.source !== "manual") fail(422,"A pesquisa por descrição requer a fonte manual nativa.");
    return json(await manualSearch(e,u,value.filters,value.dimension,value.query));
  }
  if (!path.startsWith("/admin/data")) return null;
  if (u.role !== "admin" && u.role !== "operador") fail(403, "Acesso exclusivo da administração ou operação de atualização.");
  if (u.role === "operador" && (path === "/admin/data/settings" || path === "/admin/data/restore")) fail(403, "Somente o administrador pode configurar a fonte ou restaurar versões.");
  if (path === "/admin/data" && method === "GET") return json(await status(e, u.role === "operador" ? u.id : undefined));
  if (path === "/admin/data/settings" && method === "PUT") {
    const v = z.object({ source: z.enum(["manual", "powerbi"]), staleDays: z.number().int().min(1).max(365), allowAI: z.boolean() }).strict().parse(await body(req));
    if (controlledHmlPolicy(e) && v.source !== "manual") fail(403,"Esta validação usa somente o snapshot manual autorizado.");
    await e.DB.batch([stmt(e, "UPDATE ci_sources SET source=?,stale_days=?,allow_ai=?,updated=? WHERE id=?", v.source, v.staleDays, +v.allowAI, now(), MANUAL_SOURCE), audit(e,u.id,"fonte_comercial_configurada",v.source)]);
    return json(await dataStatus(e));
  }
  if (path === "/admin/data/imports" && method === "POST") {
    const v = z.object({ filename: z.string().min(1).max(200).regex(/\.ci\.ndjson$/i), bytes: z.number().int().min(100).max(maxBytes(e)), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body(req));
    assertControlledHmlPackage(e, v.sha256);
    const existing = await stmt(e, "SELECT * FROM ci_imports WHERE sha256=? AND bytes=?", v.sha256, v.bytes).first<ImportRow>();
    if (existing) {
      if (u.role === "operador" && existing.owner !== u.id) fail(409, "Este pacote já foi recebido por outro operador. Consulte o administrador.");
      const uploadedParts = (await stmt(e, "SELECT part AS partNumber,etag FROM ci_upload_parts WHERE import_id=? ORDER BY part", existing.id).all()).results;
      return json({ id: existing.id, status: existing.status, existing: true, partBytes: UPLOAD_PART_BYTES, parts: Math.ceil(v.bytes / UPLOAD_PART_BYTES), uploadedParts });
    }
    const s = await sourceRow(e), id = crypto.randomUUID(), key = MANUAL_PREFIX + id + ".ci.ndjson";
    const multipart = await manualEnv(e).BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: "application/x-ndjson" }, customMetadata: { importId: id, sourceId: MANUAL_SOURCE } });
    try {
      await e.DB.batch([
        stmt(e, "INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,upload_id,status,base_generation,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id,u.id,u.name,v.filename,v.bytes,v.sha256,key,multipart.uploadId,"uploading",s.generation,now(),now()),
        stmt(e, "UPDATE ci_sources SET latest_import_id=?,updated=? WHERE id=?",id,now(),MANUAL_SOURCE),
        audit(e,u.id,"atualizacao_criada",id),
      ]);
    } catch (err) { await multipart.abort().catch(() => {}); throw err; }
    return json({ id, status: "uploading", partBytes: UPLOAD_PART_BYTES, parts: Math.ceil(v.bytes / UPLOAD_PART_BYTES), uploadedParts: [] },201);
  }
  const match = path.match(/^\/admin\/data\/imports\/([a-f0-9-]{36})(?:\/(parts\/(\d+)|complete|cancel|retry|package|report))?$/);
  if (match) {
    const row = await getImport(e, match[1]), action = match[2];
    if (u.role === "operador" && (row.owner !== u.id || action === "package")) fail(403, "Esta operação não está autorizada para o operador.");
    if (action?.startsWith("parts/") && method === "PUT") {
      if (row.status !== "uploading" || !row.upload_id) fail(409,"O envio não está aberto.");
      const part = Number(match[3]), count = Math.ceil(row.bytes / UPLOAD_PART_BYTES);
      if (!Number.isInteger(part) || part < 1 || part > count) fail(400,"Parte inválida.");
      const size = part === count ? row.bytes - (count-1)*UPLOAD_PART_BYTES : UPLOAD_PART_BYTES;
      if (Number(req.headers.get("content-length")) !== size) fail(400,"Tamanho da parte incorreto.");
      if (!req.body) fail(400,"Parte vazia.");
      const upload = manualEnv(e).BUCKET.resumeMultipartUpload(row.object_key,row.upload_id);
      const result = await upload.uploadPart(part,req.body);
      await e.DB.batch([
        stmt(e,"INSERT INTO ci_upload_parts(import_id,part,etag,bytes) VALUES(?,?,?,?) ON CONFLICT(import_id,part) DO UPDATE SET etag=excluded.etag,bytes=excluded.bytes",row.id,part,result.etag,size),
        stmt(e,"UPDATE ci_imports SET uploaded_bytes=(SELECT COALESCE(SUM(bytes),0) FROM ci_upload_parts WHERE import_id=?),updated=? WHERE id=? AND status='uploading'",row.id,now(),row.id),
      ]);
      return json({part,etag:result.etag,uploadedBytes:(await getImport(e,row.id)).uploaded_bytes});
    }
    if (action === "complete" && method === "POST") {
      if (["queued","importing","validating","published"].includes(row.status)) {if(row.status!=="published")await wakeManualJob(e,row.id);return json({id:row.id,status:row.status});}
      if (row.status !== "uploading" || !row.upload_id) fail(409,"O envio não está aberto.");
      const parts = (await stmt(e,"SELECT part AS partNumber,etag,bytes FROM ci_upload_parts WHERE import_id=? ORDER BY part",row.id).all<{partNumber:number;etag:string;bytes:number}>()).results;
      const expected = Math.ceil(row.bytes/UPLOAD_PART_BYTES);
      if(parts.length!==expected || parts.some((p,i)=>p.partNumber!==i+1) || parts.reduce((a,p)=>a+p.bytes,0)!==row.bytes) fail(409,"Envio incompleto. Retome as partes ausentes.");
      // Only server-recorded ETags can complete this private R2 object.
      const existingObject = await manualEnv(e).BUCKET.head(row.object_key);
      const object = existingObject ?? await manualEnv(e).BUCKET.resumeMultipartUpload(row.object_key,row.upload_id).complete(parts.map(({partNumber,etag})=>({partNumber,etag})));
      if(object.size!==row.bytes) fail(400,"Tamanho final divergente.");
      await e.DB.batch([stmt(e,"UPDATE ci_imports SET status='queued',updated=? WHERE id=? AND status='uploading'",now(),row.id),audit(e,u.id,"atualizacao_recebida",row.id)]);
      await wakeManualJob(e,row.id);
      return json({id:row.id,status:"queued"});
    }
    if(action==="retry" && method==="POST") {
      if(!["failed","cancelled","superseded"].includes(row.status)) fail(409,"Esta importação não precisa de retomada.");
      const object=await manualEnv(e).BUCKET.head(row.object_key),s=await sourceRow(e);
      const manifest=parsed(row),complete=manifest?entries(manifest):[];
      if(row.status==="failed"&&object?.size===row.bytes&&manifest&&row.part_cursor===complete.length&&row.processed_bytes===row.bytes&&row.rows===complete.reduce((n,x)=>n+x.part.rows,0)){
        validateManifest(manifest,e,row.sha256,true);
        const checkpoints=(await stmt(e,"SELECT table_id,part,rows,sha256 FROM ci_parts WHERE version_id=?",row.id).all<{table_id:string;part:number;rows:number;sha256:string}>()).results;
        const recorded=new Map(checkpoints.map(p=>[JSON.stringify([p.table_id,p.part]),p]));
        if(checkpoints.length===complete.length&&complete.every(({table,part})=>{const p=recorded.get(JSON.stringify([table?.id??"__projection__",part.index]));return p?.rows===part.rows&&p.sha256===part.sha256;})){
          const resumed=await e.DB.batch([
            stmt(e,"UPDATE ci_imports SET status='validating',base_generation=?,error=NULL,report=NULL,lease_token=NULL,lease_until=0,updated=? WHERE id=? AND status='failed' AND EXISTS(SELECT 1 FROM ci_sources WHERE id=? AND generation=?)",s.generation,now(),row.id,MANUAL_SOURCE,s.generation),
            stmt(e,"UPDATE ci_sources SET latest_import_id=?,updated=? WHERE id=? AND generation=? AND EXISTS(SELECT 1 FROM ci_imports WHERE id=? AND status='validating' AND base_generation=?)",row.id,now(),MANUAL_SOURCE,s.generation,row.id,s.generation),
            audit(e,u.id,"atualizacao_retomada",row.id),
          ]);
          if(!resumed[0].meta.changes)fail(409,"A importação ou a fonte mudou durante a retomada. Atualize a página.");
          await wakeManualJob(e,row.id);
          return json({id:row.id,status:"validating",resumedValidation:true,partBytes:UPLOAD_PART_BYTES,parts:Math.ceil(row.bytes/UPLOAD_PART_BYTES),uploadedParts:[]});
        }
      }
      let uploadId=row.upload_id,status="queued";
      if(!object) { const upload=await manualEnv(e).BUCKET.createMultipartUpload(row.object_key,{httpMetadata:{contentType:"application/x-ndjson"},customMetadata:{importId:row.id,sourceId:MANUAL_SOURCE}});uploadId=upload.uploadId;status="uploading"; }
      await e.DB.batch([
        stmt(e,"UPDATE ci_imports SET status=?,base_generation=?,upload_id=?,error=NULL,report=NULL,manifest=NULL,processed_bytes=0,part_cursor=0,rows=0,tables=0,lease_token=NULL,lease_until=0,updated=? WHERE id=? AND status IN ('failed','cancelled','superseded')",status,s.generation,uploadId,now(),row.id),
        ...(!object?[stmt(e,"DELETE FROM ci_upload_parts WHERE import_id=?",row.id),stmt(e,"UPDATE ci_imports SET uploaded_bytes=0 WHERE id=?",row.id)]:[]),
        stmt(e,"UPDATE ci_sources SET latest_import_id=?,updated=? WHERE id=?",row.id,now(),MANUAL_SOURCE),
        audit(e,u.id,"atualizacao_retomada",row.id),
      ]);
      if(status==="queued")await wakeManualJob(e,row.id);
      return json({id:row.id,status,partBytes:UPLOAD_PART_BYTES,parts:Math.ceil(row.bytes/UPLOAD_PART_BYTES),uploadedParts:[]});
    }
    if(action==="cancel" && method==="POST") {
      if(row.status==="published") fail(409,"Uma versão publicada não pode ser cancelada. Restaure uma versão anterior.");
      const cancelled=await stmt(e,"UPDATE ci_imports SET status='cancelled',lease_token=NULL,lease_until=0,updated=? WHERE id=? AND status<>'published'",now(),row.id).run();
      if(!cancelled.meta.changes) fail(409,"A versão acabou de ser publicada. Restaure a versão anterior se necessário.");
      if(row.upload_id && row.status==="uploading") await manualEnv(e).BUCKET.resumeMultipartUpload(row.object_key,row.upload_id).abort().catch(()=>{});
      await audit(e,u.id,"atualizacao_cancelada",row.id).run();
      return json({ok:true});
    }
    if(action==="package" && method==="GET") {
      if (row.manifest) assertControlledHmlManifest(e,parsed(row)!,row.sha256,true);
      if(row.status==="uploading") fail(409,"Arquivo ainda incompleto.");
      const object=await manualEnv(e).BUCKET.get(row.object_key);
      if(!object) fail(404,"Pacote privado não encontrado.");
      return new Response(object.body,{headers:{"Content-Type":"application/x-ndjson","Content-Disposition":'attachment; filename="'+row.id+'.ci.ndjson"',"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
    }
    if((action==="report" || !action) && method==="GET") return json({id:row.id,status:row.status,report:row.report?JSON.parse(row.report):null,error:row.error});
  }
  if(path==="/admin/data/restore" && method==="POST") {
    const v=z.object({versionId:z.uuid(),expectedActiveVersionId:z.uuid().nullable()}).strict().parse(await body(req));
    const target=await publishedVersion(e,v.versionId), s=await sourceRow(e);
    if(s.active_version_id!==v.expectedActiveVersionId) fail(409,"A versão ativa mudou. Atualize a página antes de restaurar.");
    const result=await stmt(e,"UPDATE ci_sources SET active_version_id=?,active_at=?,active_actor=?,generation=generation+1,latest_import_id=NULL,updated=? WHERE id=? AND generation=? AND active_version_id IS ?",target.row.id,now(),u.name,now(),MANUAL_SOURCE,s.generation,v.expectedActiveVersionId).run();
    if(!result.meta.changes) fail(409,"Outra publicação ocorreu. Atualize a página.");
    await audit(e,u.id,"versao_restaurada",target.row.id).run();
    return json(await dataStatus(e));
  }
  fail(404,"Operação de atualização desconhecida.");
}

function validateManifest(m:ManualManifest,e:Env,packageSha256?:string,active=false) {
  assertControlledHmlManifest(e,m,packageSha256,active);
  if(e.HML_SYNTHETIC_ONLY==="true" && !m.synthetic) throw new Error("Esta homologação aceita exclusivamente pacotes sintéticos. Dados comerciais reais não são autorizados neste ambiente.");
  if(m.synthetic && (e as ManualEnv).MANUAL_ALLOW_SYNTHETIC!=="true") throw new Error("Dados sintéticos são aceitos apenas em ambiente de teste explicitamente configurado.");
  if(m.sourceUpdatedAt && new Date(m.sourceUpdatedAt).valueOf()>new Date(m.extractedAt).valueOf()+300000) throw new Error("Atualização da origem posterior à extração.");
  if(m.referenceDate>m.extractedAt.slice(0,10)) throw new Error("Data de referência posterior à extração.");
  if(new Date(m.extractedAt).valueOf()>Date.now()+300000) throw new Error("Horário de extração está no futuro.");
  if(m.projection.from>m.projection.to) throw new Error("Período de cobertura inválido.");
  const ids=new Set<string>(), names=new Set<string>();
  let bytes=0;
  for(const t of m.inventory.tables) {
    if(t.id==="__projection__" || ids.has(t.id) || names.has(t.name)) throw new Error("Inventário contém tabelas duplicadas.");
    ids.add(t.id);names.add(t.name);
    if(t.sourceRowCount!==t.rowCount) throw new Error("Contagem da origem ausente ou divergente em "+t.name);
    const metadataOnly=m.formatVersion===2&&t.metadataOnly===true&&!t.allowEmpty&&t.rowCount===0&&t.parts.length===0&&m.inventory.measures.some(x=>typeof x==="object"&&x!==null&&"table"in x&&x.table===t.name)&&!m.inventory.relationships.some(x=>typeof x==="object"&&x!==null&&(("fromTable"in x&&x.fromTable===t.id)||("toTable"in x&&x.toTable===t.id)))&&!Object.values(m.nativeModel??{}).some(x=>typeof x==="object"&&x!==null&&"table"in x&&x.table===t.id);
    if(t.metadataOnly===true&&!metadataOnly)throw Error("Tabela marcada como metadados contém dependências, linhas ou autorização de vazio incompatível: "+t.name);
    if(!t.rowCount && !t.allowEmpty&&!metadataOnly) throw new Error("Tabela vazia sem autorização explícita: "+t.name);
    if(new Set(t.columns.map(c=>c.name)).size!==t.columns.length) throw new Error("Colunas duplicadas em "+t.name);
    validateParts(t.parts,t.rowCount,t.name);bytes+=t.parts.reduce((n,p)=>n+p.bytes,0);
  }
  if(m.formatVersion===1)validateParts(m.projection.parts,m.projection.rowCount,"projeção");
  else validateNativeModel(m);
  bytes+=m.projection.parts.reduce((n,p)=>n+p.bytes,0);
  if(bytes>maxBytes(e)) throw new Error("Volume exportado excede a capacidade configurada. Nenhum dado será truncado.");
  const metricIds=new Set<string>();
  for(const metric of m.metrics) {
    if(metricIds.has(metric.id)) throw new Error("Identificador de métrica duplicado.");metricIds.add(metric.id);
    if(metric.unit!==({gross:"money",revenue:"money",returns:"money",buyers:"count",margin:"percent"} as const)[metric.id]) throw new Error("Unidade incompatível com o indicador do aplicativo: "+metric.id);
    if(metric.status!=="validated" || metric.kind==="unavailable") continue;
    if(m.formatVersion===1&&(metric.supportedFilters.length!==6 || new Set(metric.supportedFilters).size!==6)) throw new Error("Métrica não comprovada para todos os filtros usados pelo aplicativo: "+metric.id);
    if(m.formatVersion===2&&nativeCapabilities(m).filters.some(f=>!metric.supportedFilters.includes(f)))throw Error("Métrica relacional sem suporte a um filtro declarado.");
    if(metric.kind==="sum" && !metric.component) throw new Error("Componente de soma ausente.");
    if(metric.kind==="ratio" && (!metric.numerator || !metric.denominator)) throw new Error("Componentes da razão ausentes.");
    if(metric.kind==="distinctClient" && metric.id!=="buyers") throw new Error("Contagem distinta incompatível com a métrica.");
    const controls=m.controls.filter(c=>c.metric===metric.id);
    for(const context of (m.formatVersion===2?["total","month","region","client","product","state","category","regional",...(m.nativeModel?.regions.manager?["manager"]:[])]:["total","month","region","client","product","state"])) {
      if(!controls.some(c=>c.context===context)) throw new Error("Controle DAX obrigatório ausente: "+metric.id+" / "+context);
    }
    if(!controls.some(c=>c.context==="total" && c.filters.from===m.projection.from && c.filters.to===m.projection.to)) throw new Error("Controle total não cobre todo o histórico: "+metric.id);
    for(const c of controls) {
      if(c.referenceDate!==m.referenceDate || c.filters.from>c.filters.to) throw new Error("Data de referência do controle divergente.");
      if(c.context!=="total" && c.context!=="month" && !c.filters[c.context]) throw new Error("Controle de recorte sem filtro explícito: "+c.context);
      const tolerance=Number(c.tolerance);
      if(!Number.isFinite(tolerance)||tolerance<0||tolerance>0.01) throw new Error("Tolerância inválida; máximo documentado é 0,01 na unidade da medida.");
    }
  }
  const revenue=m.metrics.find(x=>x.id==="revenue");
  if(!revenue || revenue.status!=="validated" || revenue.kind==="unavailable") throw new Error("Faturamento essencial não possui implementação e controles DAX reconciliáveis.");
}
export { validateManifest as validateManualManifest };

function validateParts(parts:ManualManifest["projection"]["parts"],count:number,label:string) {
  if(parts.some((p,i)=>p.index!==i+1) || parts.reduce((n,p)=>n+p.rows,0)!==count) throw new Error("Partes ou contagem incompletas: "+label);
}
function entries(m:ManualManifest) {
  return [
    ...m.inventory.tables.flatMap(table=>table.parts.map(part=>({table,part}))),
    ...m.projection.parts.map(part=>({table:null,part})),
  ];
}
function componentScales(m:ManualManifest) {
  const components=new Map<string,number>();
  for(const metric of m.metrics.filter(x=>x.status==="validated"&&x.kind!=="unavailable")) {
    for(const key of [metric.component,metric.numerator,metric.denominator].filter((s):s is string=>!!s)) {
      if(components.has(key)&&components.get(key)!==metric.scale) throw new Error("Componente usado com escalas incompatíveis: "+key);
      components.set(key,metric.scale);
    }
  }
  return components;
}
async function range(e:Env,key:string,offset:number,length:number) {
  const object=await manualEnv(e).BUCKET.get(key,{range:{offset,length}});
  if(!object) throw new Error("Pacote privado desapareceu antes da validação.");
  const buffer=await object.arrayBuffer();
  if(buffer.byteLength>length) throw new Error("Armazenamento devolveu intervalo maior que o permitido.");
  return new Uint8Array(buffer);
}
const sha256=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
async function loadManifest(e:Env,row:ImportRow) {
  const bytes=await range(e,row.object_key,0,Math.min(row.bytes,MAX_MANIFEST_BYTES+1));
  const end=bytes.indexOf(10);
  if(end<0 || end>MAX_MANIFEST_BYTES) throw new Error("Manifesto excede 1 MiB ou não termina com LF.");
  const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0,end));
  const manifest=manifestSchema.parse(JSON.parse(text));validateManifest(manifest,e,row.sha256,true);
  const storage=await stmt(e,storageBytesSql()).first<{bytes:number}>();
  const capacity=Number((e as Env & {MANUAL_D1_CAPACITY_BYTES?:string}).MANUAL_D1_CAPACITY_BYTES)||450*1024**2;
  if((storage?.bytes??0)*2+row.bytes*3>capacity) throw new Error("Capacidade insuficiente para coexistir com o snapshot completo e índices. Redimensione ou revise retenção antes da carga; nenhum dado será truncado.");
  const size=end+1+entries(manifest).reduce((n,p)=>n+p.part.bytes,0);
  if(size!==row.bytes) throw new Error("Tamanho do manifesto e das partes não coincide com o pacote completo.");
  await stmt(e,"UPDATE ci_imports SET manifest=?,tables=?,processed_bytes=?,status='importing',updated=? WHERE id=? AND lease_token=? AND status='queued'",JSON.stringify(manifest),manifest.inventory.tables.length,end+1,now(),row.id,row.lease_token).run();
  return manifest;
}
async function importPart(e:Env,row:ImportRow,m:ManualManifest) {
  const entry=entries(m)[row.part_cursor];
  if(!entry) {
    await stmt(e,"UPDATE ci_imports SET status='validating',updated=? WHERE id=? AND lease_token=? AND status='importing'",now(),row.id,row.lease_token).run();return;
  }
  const bytes=await range(e,row.object_key,row.processed_bytes,entry.part.bytes);
  if(bytes.length!==entry.part.bytes || bytes[bytes.length-1]!==10 || sha256(bytes)!==entry.part.sha256) throw new Error("Checksum ou tamanho divergente na parte "+entry.part.index+" de "+(entry.table?.name??"projeção"));
  if(bytes.length>MAX_DATA_PART_BYTES) throw new Error("Parte descomprimida excede 1 MiB.");
  const data=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0,-1)));
  const tableId=entry.table?.id??"__projection__";
  const writes:D1PreparedStatement[]=[],insertRows:(string|number|null)[][]=[];
  if(entry.table) {
    const v=z.object({kind:z.literal("rows"),table:z.literal(entry.table.id),part:z.literal(entry.part.index),rows:z.array(z.object({row:z.number().int().positive(),values:z.array(z.union([z.string(),z.boolean(),z.null()]))}).strict()).max(m.formatVersion===2?MAX_PART_ROWS:100)}).strict().parse(data);
    if(v.rows.length!==entry.part.rows) throw new Error("Contagem da parte divergente: "+entry.table.name);
    const preceding=entry.table.parts.slice(0,entry.part.index-1).reduce((n,p)=>n+p.rows,0);
    for(const [i,r] of v.rows.entries()) {
      if(r.row!==preceding+i+1 || r.values.length!==entry.table.columns.length) throw new Error("Tabela "+entry.table.name+", linha "+r.row+": sequência ou quantidade de colunas inválida.");
      for(let c=0;c<r.values.length;c++) validateCell(r.values[c],entry.table.columns[c].type,entry.table.name,r.row,entry.table.columns[c].name);
      insertRows.push([row.id,tableId,r.row,JSON.stringify(r.values)]);
    }
    writes.push(...nativePartStatements(e,m,row.id,tableId,v.rows));
  } else {
    const v=z.object({kind:z.literal("facts"),part:z.literal(entry.part.index),rows:z.array(factSchema).max(100)}).strict().parse(data);
    if(v.rows.length!==entry.part.rows) throw new Error("Contagem de fatos divergente.");
    const preceding=m.projection.parts.slice(0,entry.part.index-1).reduce((n,p)=>n+p.rows,0),scales=componentScales(m);
    for(const [i,r] of v.rows.entries()) {
      if(r.row!==preceding+i+1 || r.date<m.projection.from || r.date>m.projection.to) throw new Error("Fato linha "+r.row+": sequência ou data fora do período declarado.");
      const values:Record<string,number|null>={};
      for(const [key,scale] of scales) {
        if(!(key in r.values)) throw new Error("Fato linha "+r.row+", componente "+key+": valor ausente.");
        try { values[key]=r.values[key]===null?null:decimalInteger(r.values[key]!,scale); }
        catch(err) { throw new Error("Fato linha "+r.row+", componente "+key+": "+errorText(err)); }
      }
      insertRows.push([row.id,r.row,r.date,r.region,r.client,r.product,r.category,r.state,JSON.stringify(values)]);
    }
  }
  const width=entry.table?4:9,chunk=Math.floor(90/width),target=entry.table?"ci_raw_rows(version_id,table_id,row_no,value)":"ci_facts(version_id,row_no,date,region,client,product,category,state,value)";
  for(let offset=0;offset<insertRows.length;offset+=chunk) {
    const group=insertRows.slice(offset,offset+chunk);
    writes.push(stmt(e,"INSERT INTO "+target+" VALUES "+group.map(()=>"("+Array(width).fill("?").join(",")+")").join(",")+" ON CONFLICT DO NOTHING",...group.flat()));
  }
  writes.push(stmt(e,"INSERT INTO ci_parts(version_id,table_id,part,rows,sha256) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",row.id,tableId,entry.part.index,entry.part.rows,entry.part.sha256));
  writes.push(stmt(e,"UPDATE ci_imports SET part_cursor=part_cursor+1,processed_bytes=processed_bytes+?,rows=rows+?,updated=?,lease_until=? WHERE id=? AND lease_token=? AND part_cursor=? AND status='importing'",entry.part.bytes,entry.part.rows,now(),now()+120,row.id,row.lease_token,row.part_cursor));
  // INSERTs and checkpoint share one transaction. A retried part cannot duplicate facts.
  await e.DB.batch(writes);
}
function validateCell(value:string|boolean|null,type:string,table:string,row:number,column:string) {
  if(value===null) return;
  const t=type.toLowerCase();
  let valid=true;
  if(["int64","integer","whole number"].includes(t)) valid=typeof value==="string" && /^-?\d+$/.test(value);
  else if(t==="double")valid=typeof value==="string"&&/^-?(0|[1-9]\d*)(\.\d+)?([Ee][+-]?\d+)?$/.test(value)&&Number.isFinite(Number(value));
  else if(["decimal","currency","decimalnumber","decimal number"].includes(t)) valid=typeof value==="string" && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value);
  else if(["boolean","bool"].includes(t)) valid=typeof value==="boolean";
  else if(["datetime","date"].includes(t)) valid=typeof value==="string" && Number.isFinite(Date.parse(value));
  else valid=typeof value==="string";
  if(!valid) throw new Error("Tabela "+table+", linha "+row+", coluna "+column+": tipo "+type+" inválido.");
}

function recipe(metric:ManualMetric) {
  const path=(key:string)=>'$.'+JSON.stringify(key);
  if(metric.kind==="sum") return { sql:"SUM(CAST(json_extract(value,?) AS INTEGER))",args:[path(metric.component!)] };
  if(metric.kind==="distinctClient") return { sql:"COUNT(DISTINCT client)",args:[] };
  if(metric.kind==="ratio") return {sql:"CASE WHEN SUM(CAST(json_extract(value,?) AS INTEGER))<>0 THEN 1.0*SUM(CAST(json_extract(value,?) AS INTEGER))/SUM(CAST(json_extract(value,?) AS INTEGER)) END",args:[path(metric.denominator!),path(metric.numerator!),path(metric.denominator!)]};
  return {sql:"NULL",args:[]};
}
function outputValue(value:unknown,metric:ManualMetric):number|null {
  if(value===null || value===undefined) return null;
  const n=Number(value);
  if(!Number.isFinite(n)) throw new Error("Resultado numérico inválido: "+metric.id);
  if(metric.kind==="sum") {if(!Number.isSafeInteger(n)) throw new Error("Soma excede precisão inteira segura.");return n/10**metric.scale;}
  return n*(metric.kind==="ratio"&&metric.unit==="percent"?100:1);
}
function security(u:DbUser,p:Plan) {
  if(u.role==="operador"||u.update_only)fail(403,"O operador de atualização não possui acesso às análises comerciais.");
  const regions=z.array(z.string()).parse(JSON.parse(u.regions)),clients=z.array(z.string()).parse(JSON.parse(u.clients));
  const national=u.role==="admin"||(u.role==="diretoria"&&!!u.national);
  if(!national && ((u.role==="gerente"&&!regions.length)||(!regions.length&&!clients.length))) fail(403,"Nenhuma carteira ou regional autorizada.");
  const clauses:string[]=[],args:(string|number|null)[]=[];
  if([...(p.filters.categoriesInclude??[]),...(p.filters.categoriesExclude??[])].some(v=>v.startsWith("Macro Categoria: ")))fail(422,"Macro Categoria exige a fonte relacional com cadastro oficial de produtos.");
  for(const [key,allowed] of [["region",regions],["client",clients],["product",[]],["category",[]]] as const) {
    const requested=p.filters[key],scoped=!national&&allowed.length>0;
    const multiRequested=key==="region"?(p.filters.regions??[]):key==="client"?(p.filters.clients??[]):[];
    if((requested&&scoped&&!(allowed as readonly string[]).includes(requested))||(scoped&&multiRequested.some(v=>!(allowed as readonly string[]).includes(v)))) fail(403,"Seleção fora do seu escopo.");
    const values=requested?[requested]:scoped?allowed:[];
    if(values.length) {clauses.push(key+" IN (SELECT value FROM json_each(?))");args.push(JSON.stringify(values));}
  }
  for(const [field,operator]of [["categoriesInclude","IN"],["categoriesExclude","NOT IN"]]as const){const values=p.filters[field];if(values?.length){clauses.push("category "+operator+" (SELECT value FROM json_each(?))");args.push(JSON.stringify(values));}}
  return {clauses,args};
}
async function aggregate(e:Env,version:string,m:ManualManifest,where:string[],whereArgs:(string|number|null)[],group?:string) {
  const args:(string|number|null)[]=[],expressions:string[]=[];
  for(const id of metricKeys) {
    const metric=m.metrics.find(x=>x.id===id&&x.status==="validated"&&x.kind!=="unavailable");
    const r=metric?recipe(metric):{sql:"NULL",args:[]};expressions.push(r.sql+' AS "'+id+'"');args.push(...r.args);
  }
  const label=group==='month'?"substr(date,1,7)":group;
  const sql="SELECT "+(label?label+" AS name,":"")+"COUNT(*) AS records,"+expressions.join(",")+" FROM ci_facts WHERE version_id=?"+(where.length?" AND "+where.join(" AND "):"")+(label?" GROUP BY "+label+" LIMIT 10001":"");
  const result = (await stmt(e,sql,...args,version,...whereArgs).all<Record<string,unknown>>()).results;
  if(result.length>10000) fail(422,"Mais de 10.000 grupos no recorte. Restrinja o período ou os filtros para consultar sem truncar a base.");
  return result;
}
function pairRow(name:string,a:Record<string,unknown>|undefined,b:Record<string,unknown>|undefined,m:ManualManifest):Row {
  const values=Object.fromEntries(metricKeys.map(id=>{
    const metric=m.metrics.find(x=>x.id===id&&x.status==="validated"&&x.kind!=="unavailable");
    return [id,{current:metric&&a&&Number(a.records)>0?outputValue(a[id],metric):null,previous:metric&&b&&Number(b.records)>0?outputValue(b[id],metric):null}];
  })) as Row["values"];
  return {name,values};
}
function dateBounds(from:string,to:string,offset:number) {
  const start=(Number(from.slice(0,4))+offset)+from.slice(4)+"-01";
  const end=new Date(Date.UTC(Number(to.slice(0,4))+offset,Number(to.slice(5,7)),1)).toISOString().slice(0,10);
  return [start,end];
}
export async function queryManual(e:Env,u:DbUser,p:Plan,versionId?:string):Promise<Report> {
  p={...p,filters:controlledHmlFilters(e,u,p.filters)};
  const {row,manifest:m}=await publishedVersion(e,versionId);
  if(m.formatVersion===2){const report=await queryNative(e,u,p,m,row.id);report.sourceInfo=sourceInfo(row,m);
    if(controlledHmlPolicy(e))report.warnings=[...(report.warnings??[]),"Validação autorizada limitada a janeiro–outubro de 2026 e ao período homólogo de 2025; nenhum período posterior foi incluído."];
    return report;}
  if(!["month","client","region","product","category"].includes(p.group)||p.filters.state||p.filters.regional||p.filters.manager||p.filters.states?.length||p.filters.regionals?.length||p.filters.managers?.length||p.filters.regions?.length||p.filters.clients?.length||p.filters.products?.length||p.filters.channels?.length||p.filters.segments?.length||p.filters.brands?.length||p.filters.variationDirection&&p.filters.variationDirection!=="all"||p.filters.revenueMin!==undefined||p.filters.revenueMax!==undefined||p.filters.ticketMin!==undefined||p.filters.ticketMax!==undefined)fail(422,"Este filtro ou agrupamento não está disponível no pacote legado.");
  const selected=m.metrics.find(x=>x.id===p.metric&&x.status==="validated"&&x.kind!=="unavailable");
  if(!selected) fail(422,"Indicador indisponível nesta versão manual: "+(m.metrics.find(x=>x.id===p.metric)?.reason??"sem equivalência comprovada com o modelo Power BI"));
  const acl=security(u,p), period=nativePeriod(m,p.filters);
  const currentWhere=[...acl.clauses,"date>=?","date<=?"],currentArgs=[...acl.args,period.current.from,period.current.to];
  const previousWhere=[...acl.clauses,"date>=?","date<=?"],previousArgs=[...acl.args,period.previous.from,period.previous.to];
  const [total0,details0,total1,details1]=await Promise.all([
    aggregate(e,row.id,m,currentWhere,currentArgs),
    aggregate(e,row.id,m,currentWhere,currentArgs,p.group),
    aggregate(e,row.id,m,previousWhere,previousArgs),
    aggregate(e,row.id,m,previousWhere,previousArgs,p.group),
  ]);
  const results=[{total:total0[0],details:details0},{total:total1[0],details:details1}];
  const names=new Set([...results[0].details,...results[1].details].map(x=>String(x.name)));
  let rows:Row[]=[];
  if(p.group==="month") {
    const [year,month]=p.filters.from.split("-").map(Number);
    for(let i=0;i<=monthsBetween(p.filters.from,p.filters.to);i++) {
      const name=new Date(Date.UTC(year,month-1+i,1)).toISOString().slice(0,7),before=(Number(name.slice(0,4))-1)+name.slice(4);
      rows.push(pairRow(name,results[0].details.find(x=>x.name===name),results[1].details.find(x=>x.name===before),m));
    }
  } else {
    for(const name of names) rows.push(pairRow(name,results[0].details.find(x=>String(x.name)===name),results[1].details.find(x=>String(x.name)===name),m));
    const score=(r:Row)=>p.order==="current"?(r.values[p.metric].current??-Infinity):(r.values[p.metric].current??0)-(r.values[p.metric].previous??0);
    rows.sort((a,b)=>(p.order==="decline"?1:-1)*(score(a)-score(b))||a.name.localeCompare(b.name,"pt-BR"));
  }
  const report:Report={total:pairRow("Total",results[0].total,results[1].total,m),rows:rows.slice(0,30),plan:p,asOf:new Date().toISOString(),truncated:rows.length>30,source:"Arquivo manual (D1)",sourceInfo:sourceInfo(row,m),comparison:period};
  const available=(range:{from:string;to:string})=>range.from<=range.to&&range.from>=m.projection.from&&range.to<=m.projection.to;
  for(const item of [report.total,...report.rows])for(const metric of metricKeys){
    const bounds=p.group==="month"&&item!==report.total?nativePeriod(m,{...p.filters,from:item.name,to:item.name}):period;
    if(!available(bounds.current))item.values[metric].current=null;
    if(!available(bounds.previous))item.values[metric].previous=null;
  }
  return report;
}
function sourceInfo(row:ImportRow,m:ManualManifest):NonNullable<Report["sourceInfo"]>{return {versionId:row.id,extractedAt:m.extractedAt,sourceUpdatedAt:m.sourceUpdatedAt,referenceDate:m.referenceDate,coverage:{from:m.projection.from,to:m.projection.to},publishedAt:iso(row.published!),model:m.model.name,metrics:Object.fromEntries(metricKeys.map(id=>{const metric=m.metrics.find(x=>x.id===id);return [id,{status:metric?.status??"unavailable",reason:metric?.reason??(!metric?"Métrica não mapeada nesta versão.":undefined)}];})),capabilities:m.formatVersion===2?nativeCapabilities(m):undefined};}
async function controlValue(e:Env,id:string,m:ManualManifest,metric:ManualMetric,filters:ControlFilters) {
  if(m.formatVersion===2)return nativeControl(e,m,id,filters,metric.id);
  const where=["date>=?","date<=?"],args:(string|number|null)[]=[filters.from,filters.to];
  for(const key of ["region","client","product","category","state"] as const) if(filters[key]) {where.push(key+"=?");args.push(filters[key]!);}
  const rows=await aggregate(e,id,m,where,args),r=rows[0];
  return r&&Number(r.records)>0?{value:outputValue(r[metric.id],metric),raw:r[metric.id] as number|null}:{value:null,raw:null};
}
async function verifyHash(e:Env,row:ImportRow) {
  const object=await manualEnv(e).BUCKET.get(row.object_key);
  if(!object || object.size!==row.bytes) throw new Error("Pacote recebido não está completo no armazenamento privado.");
  const reader=object.body.getReader(),hash=createHash("sha256");let total=0;
  for(;;) {const p=await reader.read();if(p.done)break;total+=p.value.length;if(total>row.bytes){await reader.cancel();throw new Error("Pacote maior que o declarado.");}hash.update(p.value);}
  if(total!==row.bytes||hash.digest("hex")!==row.sha256) throw new Error("Checksum SHA-256 do pacote completo divergente.");
}
async function validateAndPublish(e:Env,row:ImportRow,m:ManualManifest) {
  const report:ValidationReport=row.report?JSON.parse(row.report):{checks:[],controls:[],errors:[],metrics:m.metrics,stage:"integrity",controlCursor:0};
  const checkpoint=async(stage:ValidationReport["stage"])=>{report.stage=stage;await stmt(e,"UPDATE ci_imports SET report=?,updated=?,lease_until=? WHERE id=? AND status='validating' AND lease_token=?",JSON.stringify(report),now(),now()+120,row.id,row.lease_token).run();};
  const pass=(name:string,detail:string)=>report.checks.push({name,status:"passed",detail});
  try {
    if(report.stage==="integrity") {await verifyHash(e,row);pass("integridade","SHA-256, tamanho integral e todas as partes conferem.");await checkpoint("structure");return;}
    if(report.stage==="structure") {
    const parts=(await stmt(e,"SELECT table_id,SUM(rows) AS rows,COUNT(*) AS parts FROM ci_parts WHERE version_id=? GROUP BY table_id",row.id).all<{table_id:string;rows:number;parts:number}>()).results;
    const rawCounts=(await stmt(e,"SELECT table_id,COUNT(*) AS n FROM ci_raw_rows WHERE version_id=? GROUP BY table_id",row.id).all<{table_id:string;n:number}>()).results;
    for(const table of m.inventory.tables) {
      const count=rawCounts.find(c=>c.table_id===table.id);
      if((count?.n??0)!==table.rowCount || (table.rowCount>0&&!parts.some(p=>p.table_id===table.id&&p.rows===table.rowCount&&p.parts===table.parts.length))) throw new Error("Contagem D1 divergente: "+table.name);
    }
    if(m.formatVersion===2)await validateNativeStorage(e,m,row.id);
    const facts=m.formatVersion===2?await stmt(e,"SELECT COUNT(*) AS n,MIN(date) AS first,MAX(date) AS last FROM (SELECT date FROM ci_native_sales WHERE version_id=? UNION ALL SELECT date FROM ci_native_returns WHERE version_id=?)",row.id,row.id).first<{n:number;first:string;last:string}>():await stmt(e,"SELECT COUNT(*) AS n,MIN(date) AS first,MAX(date) AS last FROM ci_facts WHERE version_id=?",row.id).first<{n:number;first:string;last:string}>();
    if(facts?.n!==m.projection.rowCount) throw new Error("Contagem ou cobertura da projeção não confere com o D1.");
    if(m.formatVersion===2){
      if(!facts.first||!facts.last||facts.first<m.projection.from||facts.last>m.projection.to)throw new Error("Contagem ou cobertura da projeção não confere com o D1.");
      // A holiday or weekend can extend a declared period beyond its first/last movement.
      // Such extensions require every calendar day; exact fact bounds keep the existing contract.
      if(facts.first!==m.projection.from||facts.last!==m.projection.to){
        const calendar=await stmt(e,"SELECT MIN(date) AS first,MAX(date) AS last,COUNT(DISTINCT date) AS days FROM ci_native_calendar WHERE version_id=? AND date>=? AND date<=?",row.id,m.projection.from,m.projection.to).first<{first:string|null;last:string|null;days:number}>();
        const days=(Date.parse(m.projection.to+"T00:00:00Z")-Date.parse(m.projection.from+"T00:00:00Z"))/86400000+1;
        if(!Number.isSafeInteger(days)||days<1||calendar?.first!==m.projection.from||calendar.last!==m.projection.to||calendar.days!==days)throw new Error("O calendário não comprova todos os dias da cobertura declarada sem movimento nas extremidades.");
        pass("cobertura_calendario","Período declarado comprovado pelo calendário diário completo; as extremidades podem não ter movimento comercial.");
      }
    }else if(facts.first!==m.projection.from||facts.last!==m.projection.to)throw new Error("Contagem ou cobertura da projeção não confere com o D1.");
    pass("contagens","Origem, exportação, todas as partes e D1 reconciliados sem descartar linhas.");
    await checkpoint("keys");return;}
    if(report.stage==="keys") {
      const checks=structuralChecks(m),cursor=report.keyCursor??0;
      for(const check of checks.slice(cursor,cursor+8)) await check(e,row.id);
      report.keyCursor=cursor+Math.min(8,checks.length-cursor);
      if(report.keyCursor<checks.length) {await checkpoint("keys");return;}
      pass("chaves_referencias",m.formatVersion===2?"Colunas e unicidade dos lados um verificadas. Relações limitadas muitos-para-muitos preservam chaves sem correspondência na origem; controles DAX validam sua propagação, sem excluir linhas brutas.":"Chaves declaradas e referências de todos os relacionamentos inventariados foram verificadas integralmente; linhas de fatos iguais são preservadas.");
      await checkpoint("precision");return;}
    if(report.stage==="precision") {
    if(m.formatVersion===2){const r=await stmt(e,"SELECT SUM(ABS(amount)) AS n FROM (SELECT amount FROM ci_native_sales WHERE version_id=? UNION ALL SELECT amount FROM ci_native_returns WHERE version_id=?)",row.id,row.id).first<{n:number|null}>();if(r?.n!=null&&!Number.isSafeInteger(r.n))throw Error("Os fatos excedem a precisão monetária segura.");}
    for(const [component] of componentScales(m)) {
      const p='$.'+JSON.stringify(component),r=await stmt(e,"SELECT SUM(ABS(CAST(json_extract(value,?) AS INTEGER))) AS n FROM ci_facts WHERE version_id=?",p,row.id).first<{n:number|null}>();
      if(r?.n!=null&&!Number.isSafeInteger(r.n)) throw new Error("Volume do componente excede precisão inteira segura: "+component);
    }
    pass("precisao","Valores monetários agregados em inteiros na escala declarada, sem arredondamento implícito.");
    await checkpoint("continuity");return;}
    if(report.stage==="continuity") {
    const s=await sourceRow(e);
    if(s.active_version_id) {
      const previous=await publishedVersion(e,s.active_version_id),p=previous.manifest;
      const authorizedTransition=!!controlledHmlPolicy(e,true)&&p.synthetic&&!m.synthetic;
      if(authorizedTransition){
        assertControlledHmlManifest(e,m,row.sha256,true);
        pass("continuidade","Transição isolada do fixture sintético para a amostra real explicitamente autorizada e fixada por SHA-256; versão anterior preservada.");
      } else {
      if(p.model.id!==m.model.id) throw new Error("Modelo de origem mudou. Use uma identidade de fonte própria ou corrija o pacote.");
      if(m.projection.from>p.projection.from || m.projection.to<p.projection.to || m.projection.rowCount<p.projection.rowCount*0.5) throw new Error("Perda material de histórico ou volume em relação à versão ativa. A base anterior foi preservada.");
      const schema=(x:ManualManifest)=>JSON.stringify(x.inventory.tables.map(t=>({id:t.id,columns:t.columns.map(c=>({name:c.name,type:c.type}))})).sort((a,b)=>a.id.localeCompare(b.id)));
      const incompatible=p.formatVersion===2&&m.formatVersion===2?nativeCompatibility(p)!==nativeCompatibility(m):schema(p)!==schema(m)||JSON.stringify(p.metrics)!==JSON.stringify(m.metrics)||JSON.stringify(p.inventory.relationships)!==JSON.stringify(m.inventory.relationships)||p.formatVersion!==m.formatVersion;
      if(incompatible) throw new Error("O esquema mudou. O mapeamento e os controles precisam de revisão explícita antes da publicação.");
      pass("continuidade","Identidade, esquema e cobertura histórica compatíveis com a versão ativa.");
      }
    }
    // D1 capacity is a conservative configured ceiling; no automatic plan purchase or truncation.
    const stored=await stmt(e,storageBytesSql()).first<{bytes:number}>();
    const capacity=Number((e as Env & {MANUAL_D1_CAPACITY_BYTES?:string}).MANUAL_D1_CAPACITY_BYTES)||450*1024**2;
    if((stored?.bytes??0)*2>capacity) throw new Error("Estimativa conservadora de D1 com índices e versões excede a capacidade configurada. Redimensione ou revise a retenção sem truncar dados.");
    pass("capacidade","Estimativa conservadora com coexistência de versões dentro do teto configurado.");
    await checkpoint("controls");return;}
    if(report.stage==="controls") {
    const cursor=report.controlCursor??0;
    const controlBatch=m.controls.slice(cursor,cursor+12),nativeCache=new Map<string,NativeResult>();
    const cacheKey=(filters:ControlFilters)=>JSON.stringify(Object.entries(filters).sort(([a],[b])=>a.localeCompare(b)));
    if(m.formatVersion===2){
      const contexts=new Map(controlBatch.map(c=>[cacheKey(c.filters),c.filters]));
      const results=await nativeValues(e,row.id,[...contexts.values()]);let index=0;
      for(const key of contexts.keys())nativeCache.set(key,results[index++]);
    }
    for(const c of controlBatch) {
      const metric=m.metrics.find(x=>x.id===c.metric&&x.status==="validated"&&x.kind!=="unavailable");
      if(!metric) continue;
      const observed=m.formatVersion===2?nativeControlResult(m,nativeCache.get(cacheKey(c.filters))!,metric.id):await controlValue(e,row.id,m,metric,c.filters),actual=observed.value,expected=c.expected===null?null:Number(c.expected);
      if(expected!==null&&!Number.isFinite(expected)) throw new Error("Controle contém resultado esperado inválido.");
            let passed:boolean;
      if(actual===null||expected===null) passed=actual===expected;
      else if(metric.kind==="sum"||(metric.kind==="native"&&metric.id!=="buyers")) {
        const expectedInteger=decimalInteger(c.expected!,metric.scale),toleranceInteger=decimalInteger(c.tolerance,metric.scale);
        const difference=BigInt(observed.raw!)-BigInt(expectedInteger);
        passed=(difference<0n?-difference:difference)<=BigInt(toleranceInteger);
      } else if(metric.kind==="distinctClient"||(metric.kind==="native"&&metric.id==="buyers")) passed=actual===expected;
      else passed=Math.abs(actual-expected)<=Number(c.tolerance)+Math.min(1e-9,Number.EPSILON*Math.max(Math.abs(actual),Math.abs(expected))*4);
      report.controls.push({metric:c.metric,context:c.context,expected:c.expected,actual:actual===null?null:String(actual),passed,filters:c.filters,referenceDate:c.referenceDate,dax:c.dax,tolerance:c.tolerance});
    }
    report.controlCursor=cursor+Math.min(12,m.controls.length-cursor);
    if(report.controlCursor<m.controls.length) {await checkpoint("controls");return;}
    if(report.controls.some(c=>!c.passed)) throw new Error("Divergência em controle DAX essencial; consulte os recortes no relatório de validação.");
    pass("reconciliacao",report.controls.length+" controles DAX reconciliados. Evidência limitada aos contextos registrados; D1 não executa DAX.");
    report.checks.push({name:"relacionamentos",status:"warning",detail:"Inventário completo preservado. As consultas usam apenas a projeção de fatos e as definições explicitamente mapeadas e reconciliadas; medidas não mapeadas permanecem indisponíveis."});
    await checkpoint("publish");return;}
    if(report.stage!=="publish") throw new Error("Checkpoint de validação inválido.");
    const result=await e.DB.batch([
      stmt(e,"UPDATE ci_sources SET active_version_id=?,active_at=?,active_actor=?,generation=generation+1,updated=? WHERE id=? AND generation=? AND latest_import_id=? AND EXISTS(SELECT 1 FROM ci_imports WHERE id=? AND status='validating' AND lease_token=?)",row.id,now(),row.actor,now(),MANUAL_SOURCE,row.base_generation,row.id,row.id,row.lease_token),
      stmt(e,"UPDATE ci_imports SET status='published',published=?,report=?,error=NULL,updated=? WHERE id=? AND status='validating' AND lease_token=? AND EXISTS(SELECT 1 FROM ci_sources WHERE id=? AND active_version_id=? AND generation=?)",now(),JSON.stringify(report),now(),row.id,row.lease_token,MANUAL_SOURCE,row.id,row.base_generation+1),
      audit(e,row.owner,"atualizacao_validada",row.id),
    ]);
    if(!result[0].meta.changes) {
      await stmt(e,"UPDATE ci_imports SET status='superseded',report=?,error=?,updated=? WHERE id=? AND status='validating' AND lease_token=?",JSON.stringify(report),"Outra importação ou restauração tem precedência. Esta versão não foi ativada.",now(),row.id,row.lease_token).run();
    }
  } catch(err) {
    if(transientD1Error(err))throw err;
    const message=errorText(err);report.errors.push({message});report.checks.push({name:"publicacao",status:"failed",detail:message});
    await stmt(e,"UPDATE ci_imports SET status='failed',report=?,error=?,updated=? WHERE id=? AND status='validating' AND lease_token=?",JSON.stringify(report),message,now(),row.id,row.lease_token).run();
  }
}
/** Cron is the durable driver: each validated part and its checkpoint is committed together. */
export async function processManualJobs(e:Env,jobId?:string) {
  const started=Date.now();
  const row=await stmt(e,"SELECT * FROM ci_imports WHERE status IN ('queued','importing','validating') AND lease_until<?"+(jobId?" AND id=?":"")+" ORDER BY seq LIMIT 1",now(),...(jobId?[jobId]:[])).first<ImportRow>();
  if(!row){await wakeManualJob(e,jobId);return;}
  const lease=crypto.randomUUID();
  const locked=await stmt(e,"UPDATE ci_imports SET lease_token=?,lease_until=? WHERE id=? AND status IN ('queued','importing','validating') AND lease_until<?",lease,now()+120,row.id,now()).run();
  if(!locked.meta.changes){await wakeManualJob(e,jobId);return;}
  let retryDelay=0;
  try {
    for(let i=0;i<10&&Date.now()-started<45000;i++) {
      const current=await getImport(e,row.id);
      if(current.lease_token!==lease||!["queued","importing","validating"].includes(current.status)) break;
      if(current.manifest) validateManifest(parsed(current)!,e,current.sha256,true);
      if(current.status==="queued") await loadManifest(e,current);
      else if(current.status==="importing") await importPart(e,current,parsed(current)!);
      else {await validateAndPublish(e,current,parsed(current)!);break;}
    }
  } catch(err) {
    if(transientD1Error(err)){retryDelay=30;return;}
    const message=errorText(err);
    await stmt(e,"UPDATE ci_imports SET status='failed',error=?,report=?,updated=? WHERE id=? AND lease_token=? AND status IN ('queued','importing','validating')",message,JSON.stringify({checks:[{name:"importacao",status:"failed",detail:message}],controls:[],errors:[{message}],metrics:[]}),now(),row.id,lease).run();
  } finally {
    await stmt(e,"UPDATE ci_imports SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?",row.id,lease).run();
    await wakeManualJob(e,row.id,retryDelay);
  }
}

/** Queue payload contains only an opaque ID; D1 remains the durable source of truth. */
async function wakeManualJob(e:Env,jobId?:string,minimumDelay=1){
  const queue=(e as ManualEnv).MANUAL_JOBS;if(!queue)return;
  try{
    const row=await stmt(e,"SELECT id,lease_until FROM ci_imports WHERE status IN ('queued','importing','validating')"+(jobId?" AND id=?":"")+" ORDER BY seq LIMIT 1",...(jobId?[jobId]:[])).first<{id:string;lease_until:number}>();
    if(row)await queue.send({jobId:row.id},{delaySeconds:Math.min(120,Math.max(minimumDelay,row.lease_until-now()+1))});
  }catch{/* Scheduled recovery resumes persisted jobs when the optional accelerator is unavailable. */}
}
function transientD1Error(error:unknown){
  const message=error instanceof Error?error.message:"";
  return /\bSQLITE_(?:BUSY|LOCKED)\b/i.test(message)||(/\bD1(?:_ERROR| API error)\b/i.test(message)&&/\b(?:timeout|timed out|overloaded|temporarily unavailable|too many requests|429)\b/i.test(message));
}
export async function processManualQueue(batch:MessageBatch<ManualJob>,e:Env){
  for(const message of batch.messages){
    const job=z.object({jobId:z.uuid()}).strict().safeParse(message.body);
    if(!job.success){message.ack();continue;}
    try{await processManualJobs(e,job.data.jobId);message.ack();}catch{message.retry({delaySeconds:30});}
  }
}

function nativeCompatibility(m:ManualManifest){
  const n=m.nativeModel!;
  const bindings:([string,Record<string,string|null|undefined>])[]=[];
  for(const [role,value]of Object.entries(n))if(typeof value==="object"&&value!==null&&"table"in value)bindings.push([role,value as unknown as Record<string,string|null|undefined>]);
  const tables=bindings.map(([role,ref])=>{const t=m.inventory.tables.find(t=>t.id===ref.table)!;return {role,id:t.id,name:t.name,columns:Object.entries(ref).filter(([key,value])=>key!=="table"&&value!=null).map(([key,value])=>({binding:key,name:value,type:t.columns.find(c=>c.name===value)!.type})).sort((a,b)=>a.binding.localeCompare(b.binding))};}).sort((a,b)=>a.role.localeCompare(b.role));
  // Both manifests already passed the exact recognizer, so kind+bound refs capture semantics;
  // whitespace, function case and equivalent blank-to-zero syntax need no weekly remapping.
  const recipes=Object.fromEntries(Object.entries(n.recipes).map(([id,recipe])=>[id,{measure:recipe.measure,kind:recipe.kind}]));
  const metrics=m.metrics.filter(metric=>["gross","revenue","returns","buyers"].includes(metric.id)).map(({id,originalName,unit,kind,scale,status})=>({id,originalName,unit,kind,scale,status})).sort((a,b)=>a.id.localeCompare(b.id));
  return JSON.stringify({nativeModel:{...n,recipes},tables,metrics});
}

export async function manualOptions(e:Env,u:DbUser,filters:Filters) {
  filters=controlledHmlFilters(e,u,filters);
  const {row,manifest}=await publishedVersion(e);
  if(manifest.formatVersion===2)return nativeOptions(e,u,filters,manifest,row.id);
  if(filters.state||filters.regional||filters.manager)fail(422,"Filtro indisponível neste pacote legado.");
  const plan:Plan={group:"month",metric:"revenue",order:"current",filters};
  const acl=security(u,plan),[start,end]=dateBounds(filters.from,filters.to,0);
  const values={region:[] as string[],client:[] as string[],product:[] as string[]},truncated={region:false,client:false,product:false};
  for(const dimension of ["region","client","product"] as const) {
    const result=(await stmt(e,"SELECT DISTINCT "+dimension+" AS value FROM ci_facts WHERE version_id=? AND date>=? AND date<?"+(acl.clauses.length?" AND "+acl.clauses.join(" AND "):"")+" ORDER BY "+dimension+" LIMIT 251",row.id,start,end,...acl.args).all<{value:string}>()).results;
    values[dimension]=result.slice(0,250).map(x=>x.value);truncated[dimension]=result.length>250;
  }
  return {values,sourceVersion:row.id,truncated};
}

function structuralChecks(m:ManualManifest) {
  const checks:((e:Env,id:string)=>Promise<void>)[]=[];
  const column=(tableId:string,name:string)=>{
    const table=m.inventory.tables.find(t=>t.id===tableId);
    if(!table) throw new Error("Relacionamento aponta para tabela ausente: "+tableId);
    const index=table.columns.findIndex(c=>c.name===name);
    if(index<0) throw new Error("Relacionamento aponta para coluna ausente: "+table.name+" / "+name);
    return {table,path:"$["+index+"]"};
  };
  const uniqueness=(tableId:string,name:string,requireNonNull:boolean)=>{
    const c=column(tableId,name);
    checks.push(async(e,id)=>{
      const duplicate=await stmt(e,"SELECT MIN(row_no) AS row,COUNT(*) AS n FROM ci_raw_rows WHERE version_id=? AND table_id=?"+(!requireNonNull?" AND json_extract(value,?) IS NOT NULL":"")+" GROUP BY json_extract(value,?) HAVING COUNT(*)>1"+(requireNonNull?" OR json_extract(value,?) IS NULL":"")+" LIMIT 1",id,tableId,...(!requireNonNull?[c.path]:[]),c.path,...(requireNonNull?[c.path]:[])).first<{row:number;n:number}>();
      if(duplicate) throw new Error("Tabela "+c.table.name+", coluna "+name+", linha "+duplicate.row+": chave declarada duplicada ou nula.");
    });
  };
  for(const table of m.inventory.tables) for(const c of table.columns) if(c.isKey===true) uniqueness(table.id,c.name,true);
  for(const raw of m.inventory.relationships) {
    const relation=z.object({fromTable:z.string(),fromColumn:z.string(),toTable:z.string(),toColumn:z.string(),fromCardinality:z.string(),toCardinality:z.string()}).passthrough().parse(raw);
    const from=column(relation.fromTable,relation.fromColumn),to=column(relation.toTable,relation.toColumn);
    if(relation.fromCardinality.toLowerCase()==="one") uniqueness(relation.fromTable,relation.fromColumn,false);
    if(relation.toCardinality.toLowerCase()==="one") uniqueness(relation.toTable,relation.toColumn,false);
    if(m.formatVersion===2)continue;
    checks.push(async(e,id)=>{
      const missing=await stmt(e,"SELECT row_no AS row FROM ci_raw_rows WHERE version_id=? AND table_id=? AND json_extract(value,?) IS NOT NULL AND json_extract(value,?) NOT IN (SELECT json_extract(value,?) FROM ci_raw_rows WHERE version_id=? AND table_id=? AND json_extract(value,?) IS NOT NULL) LIMIT 1",id,relation.fromTable,from.path,from.path,to.path,id,relation.toTable,to.path).first<{row:number}>();
      if(missing) throw new Error("Tabela "+from.table.name+", coluna "+relation.fromColumn+", linha "+missing.row+": referência não encontrada em "+to.table.name+" / "+relation.toColumn+".");
    });
  }
  return checks;
}

function storageBytesSql(){return "SELECT (SELECT COALESCE(SUM(length(value)),0) FROM ci_raw_rows)+(SELECT COALESCE(SUM(length(value)+length(region)+length(client)+length(product)+length(category)+length(state)+64),0) FROM ci_facts)"+nativeStorageTables.map(name=>"+(SELECT COALESCE(SUM(length(display)+128),0) FROM "+name+")").join("")+" AS bytes";}
