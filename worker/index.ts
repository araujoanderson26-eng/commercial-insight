import { z } from "zod";
import { configSchema, filtersSchema, planSchema, type Report } from "../shared/domain";
import { passwordHash } from "../shared/password.mjs";
import { assertAssistantAccess, dataProvider, resolvePlanEntities } from "./providers";
import { dataStatus, manualRoute, processManualJobs, processManualQueue, type ManualJob } from "./manual";
import { comment, commentaryGrounded, factualCommentary, interpret } from "./assistant";
import { assistantStatus, isVisitRequest, prepareVisit } from "./commercial";
import { authenticate, authRoute, origin } from "./auth";
import {
  audit,
  body,
  config,
  digest,
  fail,
  json,
  limit,
  now,
  passwordSchema,
  Problem,
  publicUser,
  required,
  stmt,
  userSchema,
  type DbUser,
  type Env,
} from "./core";
import { finish, start, MicrosoftProblem, type CallbackStage } from "./entra";

async function api(req: Request, e: Env, ctx: ExecutionContext) {
  const url = new URL(req.url),
    p = url.pathname.slice(4),
    method = req.method;
  if (
    method !== "GET" &&
    (req.headers.get("origin") !== origin(e) || req.headers.get("sec-fetch-site") === "cross-site")
  )
    fail(403, "Origem da solicitação não autorizada.");
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) fail(405, "Método inválido.");
  if (p.startsWith("/auth/") && method === "POST") return authRoute(e, req, p.slice(6), ctx);
  if (p === "/microsoft/callback" && method === "GET") {
    const diagnostic: CallbackStage = { stage: "session" };
    try {
      const { user, hash } = await authenticate(e, req);
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
  const { user: u, hash } = await authenticate(e, req),
    { model, revision } = await config(e);
  const owner = u.id;
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
        ai: !!e.OPENAI_API_KEY && (data.source === "manual" ? data.allowAI : !!model?.allowAI),
      },
      data: {
        source: data.source,
        ready: data.source === "manual" ? !!data.active : !!model && !!e.MS_CLIENT_SECRET && (model.mode === "application" || !!linked),
        activeVersionId: data.active?.id ?? null,
        extractedAt: data.active?.extractedAt ?? null,
        stale: data.stale,
        capabilities: data.source === "manual" ? data.active?.capabilities : undefined,
      },
    });
  }
  if (p === "/data/status" || p === "/data/options" || p === "/data/search" || p.startsWith("/admin/data")) {
    if ((p === "/data/options" || p === "/data/search") && method === "POST") await limit(e, "options:" + owner, 30, 60);
    const response = await manualRoute(req, e, u, p);
    if (response) {
      if (p === "/data/options" || p === "/data/search") await checkAccess(e, u, revision, hash);
      return response;
    }
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
    if (!commentaryGrounded(commentary, report)) commentary = factualCommentary(report);
    // Recompute saved briefings against the pinned source and current ACL; never return cached customer details directly.
    const visit = same && hadVisit ? await prepareVisit(provider, report.plan.filters) : undefined;
    delete commentary.visit;
    await checkAccess(e, u, revision, hash);
    await audit(e, owner, "resposta_reconsultada").run();
    return json({ report, commentary, ...(visit ? { visit } : {}) });
  }
  if (p === "/report" && method === "POST") {
    const plan = planSchema.parse(await body(req));
    await limit(e, "report:" + owner, 50, 60);
    const provider = await dataProvider(e, model, revision, u);
    const report = await provider.query(plan);
    await checkAccess(e, u, revision, hash);
    await audit(e, owner, "relatorio_consultado", plan.group).run();
    return json(report);
  }
  if (p === "/chat" && method === "POST") {
    const v = z
      .object({
        question: z.string().trim().min(2).max(900),
        filters: filtersSchema,
        conversation: z.uuid().nullable(),
      })
      .parse(await body(req));
    await limit(e, "chat:" + owner, 18, 600);
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
    await assertAssistantAccess(e, provider);
    const interpreted = await interpret(e, provider.semantics, v.question, v.filters, previous);
    const plan = await resolvePlanEntities(provider, interpreted, v.filters);
    const visitRequested = isVisitRequest(v.question);
    if (visitRequested && !plan.filters.client) fail(422, "Selecione um cliente ou informe seu código/nome para preparar a visita. Cadastros semelhantes exigem a escolha do código correto.");
    const report = await provider.query(plan);
    const visit = visitRequested ? await prepareVisit(provider, plan.filters) : undefined;
    await checkAccess(e, u, revision, hash);
    await assertAssistantAccess(e, provider);
    const commentary = await comment(e, v.question, report).catch(() => ({
      summary:
        "Os indicadores foram consultados na fonte identificada. A interpretação da OpenAI está temporariamente indisponível.",
      actions: [],
    }));
    await checkAccess(e, u, revision, hash);
    await assertAssistantAccess(e, provider);
    const turn = crypto.randomUUID();
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
    return json({ id, turn, report, commentary, ...(visit ? { visit } : {}) });
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
      return await api(req, e, ctx);
    } catch (err) {
      if (err instanceof Problem) return json({ error: err.message }, err.status);
      if (err instanceof z.ZodError)
        return json(
          { error: "Revise os campos enviados.", fields: err.issues.map((v) => v.path.join(".")) },
          400,
        );
      if (err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name))
        return json({ error: "O provedor demorou para responder. Tente novamente." }, 504);
      console.error(
        JSON.stringify({
          event: "request_failed",
          type: err instanceof Error ? err.name : "unknown",
        }),
      );
      return json({ error: "Não foi possível concluir a operação." }, 500);
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
