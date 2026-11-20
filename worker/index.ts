import { z } from "zod";
import { configSchema, filtersSchema, planSchema, type Commentary, type Plan, type Report } from "../shared/domain";
import type { VisitBriefing } from "../shared/commercial";
import { passwordHash } from "../shared/password.mjs";
import { assertAssistantAccess, dataProvider, resolvePlanEntities } from "./providers";
import { activeCsvBatch, csvAdminRoute } from "./csv-importer";
import { executeDeterministicQA } from "./deterministic-qa";
import { routeCommercialIntent } from "./intent-router";
import { controlledHmlPolicy } from "./real-hml-policy";
import { dataStatus, manualRoute, processManualJobs, processManualQueue, type ManualJob } from "./manual";
import { comment, factualCommentary, interpret, reviewCommentary } from "./assistant";
import { assistantStatus, isVisitRequest, prepareVisit } from "./commercial";
import { authenticate, authRoute, origin } from "./auth";
import { assertControlledHmlUser } from "./real-hml-policy";
import { controlledHmlModelPreflight } from "./openai-budget";
import { productionAIStatus, productionAIModelPreflight } from './production-ai-budget';
import { classifyWorkerError, classifyWorkerErrorDetail } from "./error-diagnostics";
import {
  allowedMobileOrigin,
  audit,
  body,
  config,
  corsHeaders,
  digest,
  fail,
  json,
  limit,
  now,
  passwordSchema,
  Problem,
  publicUser,
  required,
  scheduleBackground,
  stmt,
  userSchema,
  type DbUser,
  type Env,
} from "./core";
import { finish, start, MicrosoftProblem, type CallbackStage } from "./entra";

function edgeCache(): Cache | null {
  return typeof caches !== "undefined" && "default" in caches
    ? (caches as unknown as { default: Cache }).default
    : null;
}

async function edgeCacheKey(endpoint: string, scopeParts: (string | number | null)[], payload: unknown): Promise<Request> {
  const keyHash = await digest(JSON.stringify([scopeParts, payload]));
  return new Request("https://cache.commercial-insight.internal/v1/" + endpoint + "/" + keyHash, { method: "GET" });
}

function withCors(res: Response, e: Env, req: Request): Response {
  const extra = corsHeaders(e, req);
  if (!Object.keys(extra).length) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function api(req: Request, e: Env, ctx: ExecutionContext) {
  const url = new URL(req.url),
    p = url.pathname.slice(4),
    method = req.method;
  const reqOrigin = req.headers.get("origin");
  const mobileOrigin = allowedMobileOrigin(e, reqOrigin);
  if (method === "OPTIONS" && mobileOrigin)
    return new Response(null, { status: 204, headers: corsHeaders(e, req) });
  if (
    method !== "GET" &&
    !mobileOrigin &&
    (reqOrigin !== origin(e) || req.headers.get("sec-fetch-site") === "cross-site")
  )
    fail(403, "Origem da solicitação não autorizada.");
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) fail(405, "Método inválido.");
  if (p.startsWith("/auth/") && method === "POST") return authRoute(e, req, p.slice(6), ctx);
  if (p === "/microsoft/callback" && method === "GET") {
    const diagnostic: CallbackStage = { stage: "session" };
    try {
      const { user, hash } = await authenticate(e, req, ctx);
      diagnostic.stage = "config";
      const { model, revision } = await config(e);
      await finish(e, required(model), revision, user, hash, url, diagnostic);
      return redirectProfile(e, "vinculado");
    } catch (err) {
      console.warn(JSON.stringify({ event: "microsoft_callback_failed", stage: diagnostic.stage,
        status: err instanceof Problem ? err.status : 500,
        ...(err instanceof MicrosoftProblem ? { microsoft_status: err.providerStatus, microsoft_code: err.providerCode } : {}) }));
      return redirectProfile(e, "erro");
    }
  }
  const { user: u, hash } = await authenticate(e, req, ctx),
    { model, revision } = await config(e);
  const owner = u.id;
  if (p !== "/auth/profile") assertControlledHmlUser(e, owner);
  if (p === "/hml-real/preflight" && method === "GET") return json(await controlledHmlModelPreflight(e,owner));
  if (p === "/me" && method === "GET") {
    const data = await dataStatus(e);
    const linked = await stmt(
      e,
      "SELECT 1 AS yes FROM microsoft_tokens WHERE owner=? AND revision=?",
      owner,
      revision,
    ).first();
    return json({
      user: publicUser(u),
      policyVersion: u.scope_version + "." + revision,
      expires: u.expires,
      integrations: {
        configured: !!model && !!e.MS_CLIENT_SECRET,
        mode: model?.mode ?? "delegated",
        linked: !!linked,
        ai: !!e.OPENAI_API_KEY && (data.source === "manual" ? data.allowAI : !!model?.allowAI) && (await productionAIStatus(e,owner)).ready,
      },
      data: {
        source: data.source,
        ready: data.source === "manual" ? !!data.active : !!model && !!e.MS_CLIENT_SECRET && (model.mode === "application" || !!linked),
        activeVersionId: data.active?.id ?? null,
        extractedAt: data.active?.extractedAt ?? null,
        stale: data.stale,
        referenceDate: data.source === "manual" ? data.active?.referenceDate ?? null : null,
        model: data.source === "manual" ? data.active?.model ?? null : null,
        storageEngine: data.source === "manual" ? data.active?.storageEngine ?? null : null,
        capabilities: data.source === "manual" ? data.active?.capabilities : undefined,
      },
    });
  }
  if (p === "/data/status" || p === "/data/options" || p === "/data/search" || p.startsWith("/admin/data")) {
    if ((p === "/data/options" || p === "/data/search") && method === "POST") await limit(e, "options:" + owner, 30, 60);
    const cache = edgeCache();
    if (cache && p === "/data/options" && method === "POST") {
      if (u.role === "operador" || u.update_only) fail(403, "O operador de atualização não possui acesso às análises comerciais.");
      const t0 = Date.now();
      const reqFilters = filtersSchema.parse(await body(req.clone()));
      await checkAccess(e, u, revision, hash);
      const statusInfo = await dataStatus(e);
      if (statusInfo.source === "manual" && statusInfo.active?.id) {
        const csvScope = (await activeCsvBatch(e))?.batchId ?? "shadow";
        const cacheKey = await edgeCacheKey("options", [owner, u.scope_version, revision, statusInfo.active.id, csvScope], reqFilters);
        const cached = await cache.match(cacheKey);
        if (cached) {
          const payload = await cached.json();
          return json(payload, 200, { "X-Cache": "HIT", "Server-Timing": "app;dur=" + (Date.now() - t0) });
        }
        const response = await manualRoute(req, e, u, p);
        if (response) {
          await checkAccess(e, u, revision, hash);
          const payload = await response.json();
          scheduleBackground(
            ctx,
            cache.put(cacheKey, new Response(JSON.stringify(payload), {
              headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
            })),
          );
          return json(payload, 200, { "X-Cache": "MISS", "Server-Timing": "app;dur=" + (Date.now() - t0) });
        }
      }
    }
    const response = await manualRoute(req, e, u, p);
    if (response) {
      if (p === "/data/options" || p === "/data/search") await checkAccess(e, u, revision, hash);
      return response;
    }
  }
  if (p.startsWith("/admin/csv")) {
    const csvResponse = await csvAdminRoute(req, e, u, p);
    if (csvResponse) return csvResponse;
  }
  if (u.role === "operador" && p !== "/auth/profile") fail(403, "O operador de atualização tem acesso somente à importação de pacotes e ao próprio perfil.");
  if (p === "/microsoft/start" && method === "POST")
    return json(await start(e, required(model), revision, u, hash));
  if (p === "/microsoft" && method === "DELETE") {
    await e.DB.batch([
      stmt(e, "DELETE FROM microsoft_tokens WHERE owner=?", owner),
      stmt(e, "DELETE FROM oauth_state WHERE owner=?", owner),
      audit(e, owner, "microsoft_desvinculado"),
    ]);
    return json({ ok: true });
  }
  if (p.startsWith("/admin/")) {
    if (u.role !== "admin") fail(403, "Acesso exclusivo do administrador.");
    if (p === '/admin/ai/preflight' && method === 'GET') {
      await limit(e,'ai-preflight:'+owner,3,600);
      await checkAccess(e,u,revision,hash);
      const result=await productionAIModelPreflight(e,owner);
      await checkAccess(e,u,revision,hash);
      return json(result);
    }
    if (p === "/admin/config") {
      if (method === "GET")
        return json({
          model,
          revision,
          secrets: {
            microsoft: !!e.MS_CLIENT_SECRET,
            encryption: !!e.TOKEN_ENCRYPTION_KEY,
            openai: !!e.OPENAI_API_KEY,
            mail: !!e.MAIL_FROM && !!e.RESEND_API_KEY,
          },
        });
      if (method === "PUT") {
        const v = z
          .object({ revision: z.number().int(), model: configSchema })
          .parse(await body(req));
        const q =
          v.revision === 0
            ? stmt(
                e,
                "INSERT INTO settings(id,body,revision) VALUES(1,?,1) ON CONFLICT(id) DO NOTHING",
                JSON.stringify(v.model),
              )
            : stmt(
                e,
                "UPDATE settings SET body=?,revision=revision+1 WHERE id=1 AND revision=?",
                JSON.stringify(v.model),
                v.revision,
              );
        const res = await q.run();
        if (!res.meta.changes) fail(409, "O mapeamento mudou. Reabra a configuração.");
        await audit(e, owner, "modelo_configurado").run();
        return json({ ok: true });
      }
    }
    if (p === "/admin/users" && method === "GET")
      return json(
        (await stmt(e, "SELECT * FROM users ORDER BY name").all<DbUser>()).results.map(publicUser),
      );
    if (
      (p === "/admin/users" && method === "POST") ||
      (/^\/admin\/users\/[a-f0-9-]{36}$/.test(p) && method === "PUT")
    ) {
      const { user, password } = z
        .object({ user: userSchema, password: passwordSchema.optional() })
        .parse(await body(req));
      const edit = method === "PUT",
        id = edit ? p.split("/").pop()! : crypto.randomUUID();
      if (edit && id === owner)
        fail(400, "Peça a outro administrador para alterar o seu próprio perfil de acesso.");
      if (!edit && !password) fail(400, "Defina uma senha inicial.");
      const fields = [
        user.name,
        user.email,
        user.role === "operador" ? "comercial" : user.role,
        JSON.stringify([...new Set(user.regions)]),
        JSON.stringify([...new Set(user.clients)]),
        +user.national,
        +user.active,
        user.entraOid,
      ];
      const pw = password ? await passwordHash(password) : null;
      const q = edit
        ? stmt(
            e,
            "UPDATE users SET name=?,email=?,role=?,regions=?,clients=?,national=?,active=?,entra_oid=?,password=COALESCE(?,password),update_only=?,version=version+1,scope_version=scope_version+1 WHERE id=? AND (role<>'admin' OR active=0 OR ?=1 OR EXISTS(SELECT 1 FROM users other WHERE other.id<>users.id AND other.active=1 AND other.role='admin'))",
            ...fields,
            pw,
            +(user.role === "operador"),
            id,
            +(user.active && user.role === "admin"),
          )
        : stmt(
            e,
            "INSERT INTO users(name,email,role,regions,clients,national,active,entra_oid,password,id,created,update_only) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            ...fields,
            pw,
            id,
            now(),
            +(user.role === "operador"),
          );
      try {
        const result = await e.DB.batch([
          q,
          stmt(e, "DELETE FROM microsoft_tokens WHERE owner=?", id),
          stmt(e, "DELETE FROM oauth_state WHERE owner=?", id),
          audit(e, owner, edit ? "usuario_atualizado" : "usuario_criado", id),
        ]);
        if (!result[0].meta.changes)
          fail(409, "Atualização recusada. Confira o cadastro e mantenha um administrador ativo.");
      } catch (err) {
        if (String(err).includes("UNIQUE")) fail(409, "E-mail ou ID Microsoft já cadastrado.");
        throw err;
      }
      return json({ ok: true, id });
    }
    if (p === "/admin/audit" && method === "GET")
      return json(
        (
          await stmt(
            e,
            "SELECT a.id,a.action,a.target,a.created,u.name AS actor FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 150",
          ).all()
        ).results,
      );
  }
  const scope = [owner, u.scope_version, revision];
  if (p === "/assistant/status" && method === "GET") {
    const provider = await dataProvider(e, model, revision, u);
    const result = assistantStatus(e, provider);
    const financial = await productionAIStatus(e,owner);
    if (!financial.ready) {
      result.ready = false;
      result.reason = financial.reason!;
      result.pending.push(financial.reason!);
      result.message = financial.message!;
    }
    if (financial.budget) result.budget = financial.budget;
    const deterministicReady =
      provider.sourceType === "manual" &&
      !controlledHmlPolicy(e) &&
      Boolean(provider.semantics.capabilities) &&
      u.role !== "operador" &&
      !u.update_only;
    const csvActive = deterministicReady ? await activeCsvBatch(e) : null;
    result.deterministic = {
      ready: deterministicReady,
      source: !deterministicReady ? "none" : csvActive ? "csv" : "manual",
      message: deterministicReady
        ? csvActive
          ? "Consultas comerciais diretas disponíveis na base CSV estruturada (D1), sem uso de créditos OpenAI."
          : "Consultas comerciais diretas disponíveis na base manual (D1), sem uso de créditos OpenAI."
        : "Consultas comerciais diretas indisponíveis para esta fonte.",
    };
    result.advancedAI = {
      ready: result.ready,
      reason: result.reason,
      message: result.message,
    };
    await checkAccess(e, u, revision, hash);
    return json(result);
  }
  if (p === "/visit" && method === "POST") {
    const filters = filtersSchema.parse(await body(req));
    await limit(e, "visit:" + owner, 8, 600);
    const provider = await dataProvider(e, model, revision, u);
    const briefing = await prepareVisit(provider, filters);
    await checkAccess(e, u, revision, hash);
    await audit(e, owner, "visita_preparada").run();
    return json(briefing);
  }
  if (p === "/saved-reports" && method === "GET") {
    const records = (await stmt(e, "SELECT id,title,plan,question,favorite,created FROM saved_reports WHERE owner=? AND scope_version=? AND revision=? ORDER BY created DESC LIMIT 100", ...scope).all<{ id:string;title:string;plan:string;question:string|null;favorite:number;created:number }>()).results;
    await checkAccess(e, u, revision, hash);
    return json(records.map(record => ({...record, plan: planSchema.parse(JSON.parse(record.plan)), favorite:!!record.favorite})));
  }
  if (p === "/saved-reports" && method === "POST") {
    const value = z.object({title:z.string().trim().min(2).max(120),plan:planSchema,question:z.string().trim().max(900).optional()}).strict().parse(await body(req));
    await limit(e, "save-report:"+owner, 20, 600);
    // Reauthorize the complete plan before persisting a reusable query.
    const provider = await dataProvider(e, model, revision, u);
    await provider.query(value.plan);
    await checkAccess(e, u, revision, hash);
    const id = crypto.randomUUID(), created = now();
    const result = await stmt(e, "INSERT INTO saved_reports(id,owner,scope_version,revision,title,plan,question,created) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM saved_reports WHERE owner=? AND scope_version=? AND revision=?)<100", id,...scope,value.title,JSON.stringify(value.plan),value.question??null,created,...scope).run();
    if (!result.meta.changes) fail(409,"Limite de 100 relatórios salvos. Exclua um relatório para continuar.");
    await audit(e,owner,"relatorio_salvo",id).run();
    return json({id,title:value.title,plan:value.plan,question:value.question??null,favorite:true,created},201);
  }
  const savedId = p.match(/^\/saved-reports\/([0-9a-f-]{36})$/)?.[1];
  if (savedId && method === "DELETE") {
    const result = await stmt(e,"DELETE FROM saved_reports WHERE id=? AND owner=? AND scope_version=? AND revision=?",savedId,...scope).run();
    if (!result.meta.changes) fail(404,"Relatório salvo indisponível.");
    return json({ok:true});
  }
  if (p === "/conversations" && method === "GET")
    return json(
      (
        await stmt(
          e,
          "SELECT id,title,updated FROM conversations WHERE owner=? AND version=? AND revision=? ORDER BY updated DESC LIMIT 100",
          ...scope,
        ).all()
      ).results,
    );
  const threadId = p.match(/^\/conversations\/([0-9a-f-]{36})$/)?.[1];
  if (threadId) {
    const existing = await stmt(
      e,
      "SELECT id FROM conversations WHERE id=? AND owner=? AND version=? AND revision=?",
      threadId,
      ...scope,
    ).first();
    if (!existing) fail(404, "Conversa indisponível.");
    if (method === "GET")
      return json(
        (
          await stmt(
            e,
            "SELECT id,question,created,plan,source_type,source_version FROM turns WHERE conversation=? ORDER BY rowid",
            threadId,
          ).all<{ id: string; question: string; created: number; plan: string }>()
        ).results.map((t) => ({ ...t, plan: JSON.parse(t.plan) })),
      );
    if (method === "DELETE") {
      await e.DB.batch([
        stmt(e, "DELETE FROM conversations WHERE id=? AND owner=?", threadId, owner),
        audit(e, owner, "conversa_excluida"),
      ]);
      return json({ ok: true });
    }
  }
  const historical = p.match(/^\/turns\/([0-9a-f-]{36})\/reopen$/)?.[1];
  if (historical && method === "POST") {
    await limit(e, "report:" + owner, 50, 60);
    const turn = await stmt(
      e,
      "SELECT t.plan,t.answer,t.evidence_hash,t.source_type,t.source_version FROM turns t JOIN conversations c ON c.id=t.conversation WHERE t.id=? AND c.owner=? AND c.version=? AND c.revision=?",
      historical,
      ...scope,
    ).first<{ plan: string; answer: string | null; evidence_hash: string | null; source_type: "manual" | "powerbi" | null; source_version: string | null }>();
    if (!turn) fail(404, "Resposta indisponível.");
    const provider = await dataProvider(e, model, revision, u, { sourceType: turn.source_type ?? "powerbi", versionId: turn.source_version });
    const report = await provider.query(planSchema.parse(JSON.parse(turn.plan)));
    await checkAccess(e, u, revision, hash);
    const same = turn.evidence_hash === (await evidence(report));
    let commentary =
      same && turn.answer
        ? JSON.parse(turn.answer)
        : {
            summary:
              "Valores consultados na fonte identificada. Faça uma nova pergunta para interpretar este recorte.",
            actions: [],
          };
    const hadVisit = Boolean(commentary.visit);
    // Computed fallback text is rebuilt with current presentation rules; saved evidence stays immutable.
    if (typeof commentary.summary === "string" && commentary.summary.startsWith("Fato verificado:")) commentary = factualCommentary(report);
    else commentary = reviewCommentary(commentary, report);
    // Recompute saved briefings against the pinned source and current ACL; never return cached customer details directly.
    const visit = same && hadVisit ? await prepareVisit(provider, report.plan.filters) : undefined;
    delete commentary.visit;
    await checkAccess(e, u, revision, hash);
    await audit(e, owner, "resposta_reconsultada").run();
    return json({ report, commentary, ...(visit ? { visit } : {}) });
  }
  if (p === "/report" && method === "POST") {
    const t0 = Date.now();
    const plan = planSchema.parse(await body(req));
    await limit(e, "report:" + owner, 50, 60);
    const provider = await dataProvider(e, model, revision, u);
    const cache = edgeCache();
    if (provider.sourceType === "manual" && provider.versionId) {
      await checkAccess(e, u, revision, hash);
      const csvScope = (await activeCsvBatch(e))?.batchId ?? "shadow";
      const cacheKey = cache
        ? await edgeCacheKey("report", [owner, u.scope_version, revision, provider.versionId, csvScope], plan)
        : null;
      if (cache && cacheKey) {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const cachedReport = await cached.json();
          scheduleBackground(ctx, audit(e, owner, "relatorio_consultado", plan.group).run());
          return json(cachedReport, 200, { "X-Cache": "HIT", "Server-Timing": "app;dur=" + (Date.now() - t0) });
        }
      }
      const report = await provider.query(plan);
      await checkAccess(e, u, revision, hash);
      scheduleBackground(
        ctx,
        Promise.all([
          ...(cache && cacheKey
            ? [
                cache
                  .put(
                    cacheKey,
                    new Response(JSON.stringify(report), {
                      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
                    }),
                  )
                  .catch(() => {}),
              ]
            : []),
          audit(e, owner, "relatorio_consultado", plan.group).run().catch(() => {}),
        ]),
      );
      return json(report, 200, { "X-Cache": "MISS", "Server-Timing": "app;dur=" + (Date.now() - t0) });
    }
    const report = await provider.query(plan);
    await checkAccess(e, u, revision, hash);
    scheduleBackground(ctx, audit(e, owner, "relatorio_consultado", plan.group).run());
    return json(report, 200, { "X-Cache": "BYPASS", "Server-Timing": "app;dur=" + (Date.now() - t0) });
  }
  if (p === "/chat" && method === "POST") {
    const t0 = Date.now();
    const v = z
      .object({
        question: z.string().trim().min(2).max(900),
        filters: filtersSchema,
        conversation: z.uuid().nullable(),
      })
      .parse(await body(req));
    await limit(e, "chat:" + owner, 18, 600);
    if (u.role === "operador" || u.update_only) {
      fail(403, "O operador de atualização não possui acesso às análises comerciais.");
    }
    const provider = await dataProvider(e, model, revision, u);
    const id = v.conversation || crypto.randomUUID();
    if (
      v.conversation &&
      !(await stmt(
        e,
        "SELECT id FROM conversations WHERE id=? AND owner=? AND version=? AND revision=?",
        id,
        ...scope,
      ).first())
    )
      fail(404, "Conversa indisponível.");
    const previous = v.conversation
      ? (
          await stmt(
            e,
            "SELECT question,plan FROM turns WHERE conversation=? ORDER BY rowid DESC LIMIT 3",
            id,
          ).all<{ question: string; plan: string }>()
        ).results.reverse()
      : [];
    await checkAccess(e, u, revision, hash);
    const deterministicAvailable =
      provider.sourceType === "manual" && !controlledHmlPolicy(e) && Boolean(provider.semantics.capabilities);
    const intent = deterministicAvailable
      ? routeCommercialIntent(v.question, v.filters, provider.semantics.capabilities, previous)
      : null;
    let plan: Plan;
    let report: Report;
    let commentary: Commentary;
    let visit: VisitBriefing | undefined;
    let engine: "deterministic" | "openai" = "openai";
    if (intent) {
      const qa = await executeDeterministicQA(e, u, provider, intent, v.filters);
      plan = qa.plan;
      report = qa.report;
      commentary = qa.commentary;
      visit = qa.visit;
      engine = "deterministic";
      await checkAccess(e, u, revision, hash);
    } else {
      try {
        await assertAssistantAccess(e, provider, owner);
      } catch (err) {
        if (err instanceof Problem && deterministicAvailable) {
          fail(
            err.status,
            `Análise avançada com OpenAI temporariamente indisponível: ${err.message} Consultas comerciais diretas continuam disponíveis (ex.: faturamento, clientes, representantes, categorias e quedas).`,
          );
        }
        throw err;
      }
      const interpreted = await interpret(e, provider.semantics, v.question, v.filters, previous, owner);
      plan = await resolvePlanEntities(provider, interpreted, v.filters);
      const visitRequested = isVisitRequest(v.question);
      if (visitRequested && !plan.filters.client) fail(422, "Selecione um cliente ou informe seu código/nome para preparar a visita. Cadastros semelhantes exigem a escolha do código correto.");
      report = await provider.query(plan);
      visit = visitRequested ? await prepareVisit(provider, plan.filters) : undefined;
      await checkAccess(e, u, revision, hash);
      await assertAssistantAccess(e, provider, owner);
      commentary = await comment(e, v.question, report, owner).catch(() => ({
        summary:
          "Os indicadores foram consultados na fonte identificada. A interpretação da OpenAI está temporariamente indisponível.",
        actions: [],
      }));
      await checkAccess(e, u, revision, hash);
      await assertAssistantAccess(e, provider, owner);
    }
    const turn = crypto.randomUUID();
    const latencyMs = Date.now() - t0;
    const thread = v.conversation
      ? stmt(e, "UPDATE conversations SET updated=? WHERE id=? AND owner=?", now(), id, owner)
      : stmt(
          e,
          "INSERT INTO conversations(id,owner,version,revision,title,updated) VALUES(?,?,?,?,?,?)",
          id,
          ...scope,
          v.question.slice(0, 85),
          now(),
        );
    await e.DB.batch([
      thread,
      stmt(
        e,
        "INSERT INTO turns(id,conversation,question,plan,created,answer,evidence_hash,source_type,source_version) VALUES(?,?,?,?,?,?,?,?,?)",
        turn,
        id,
        v.question,
        JSON.stringify(plan),
        now(),
        JSON.stringify({ ...commentary, ...(visit ? { visit } : {}) }),
        await evidence(report),
        provider.sourceType,
        provider.versionId,
      ),
      audit(e, owner, "pergunta_consultada", plan.group),
    ]);
    return json({
      id,
      turn,
      report,
      commentary,
      ...(visit ? { visit } : {}),
      meta: { engine, latencyMs, openaiCalls: engine === "deterministic" ? 0 : 2 },
    });
  }
  fail(404, "Recurso desconhecido.");
}
function evidence(report: Report) {
  return digest(JSON.stringify(["commercial-2", report.plan, report.total, report.rows, report.truncated, report.source,
    report.sourceInfo?.versionId, report.comparison, report.warnings]));
}
async function checkAccess(e: Env, u: DbUser, revision: number, hash: string) {
  const ok = await stmt(
    e,
    "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id AND u.version=s.version LEFT JOIN settings c ON c.id=1 WHERE s.hash=? AND u.id=? AND u.active=1 AND u.version=? AND COALESCE(c.revision,0)=? AND s.expires>? AND u.scope_version=? AND u.update_only=?",
    hash,
    u.id,
    u.version,
    revision,
    now(),
    u.scope_version,
    +(u.role === "operador"),
  ).first();
  if (!ok) fail(403, "O acesso mudou durante a consulta. Atualize a página.");
}
function redirectProfile(e: Env, result: string) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: origin(e) + "/perfil?microsoft=" + result,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export default {
  async fetch(req: Request, e: Env, ctx: ExecutionContext) {
    try {
      if (!new URL(req.url).pathname.startsWith("/api/")) return e.ASSETS.fetch(req);
      return withCors(await api(req, e, ctx), e, req);
    } catch (err) {
      if (err instanceof Problem) return withCors(json({ error: err.message }, err.status), e, req);
      if (err instanceof z.ZodError)
        return withCors(
          json(
            { error: "Revise os campos enviados.", fields: err.issues.map((v) => v.path.join(".")) },
            400,
          ),
          e,
          req,
        );
      if (err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name))
        return withCors(json({ error: "O provedor demorou para responder. Tente novamente." }, 504), e, req);
      console.error(
        JSON.stringify({
          event: "request_failed",
          type: err instanceof Error ? err.name : "unknown",
        }),
      );
      const diagnostic: HeadersInit = e.APP_ORIGIN === "https://commercial-insight-hml.araujo-anderson26.workers.dev"
        && e.HML_REAL_DATA_AUTHORIZATION !== undefined ? { "X-Hml-Diagnostic": classifyWorkerError(err), "X-Hml-Diagnostic-Detail": classifyWorkerErrorDetail(err) } : {};
      return withCors(json({ error: "Não foi possível concluir a operação." }, 500, diagnostic), e, req);
    }
  },
  async scheduled(event: ScheduledController, e: Env) {
    await processManualJobs(e);
    if (event.cron !== "17 4 * * *") return;
    const cutoff = now() - 86400 * Math.min(365, Math.max(1, Number(e.RETENTION_DAYS) || 90));
    await e.DB.batch([
      ...["sessions", "oauth_state", "recovery", "throttle"].map((t) =>
        stmt(e, "DELETE FROM " + t + " WHERE expires<=?", now()),
      ),
      stmt(e, "DELETE FROM conversations WHERE updated<?", cutoff),
      stmt(e, "DELETE FROM audit WHERE created<?", cutoff),
      stmt(
        e,
        "DELETE FROM microsoft_tokens WHERE revision<>(SELECT revision FROM settings WHERE id=1)",
      ),
    ]);
  },
  async queue(batch: MessageBatch<ManualJob>, e: Env) {
    await processManualQueue(batch, e);
  },
} satisfies ExportedHandler<Env, ManualJob>;
