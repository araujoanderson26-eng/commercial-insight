import { z } from "zod";
import { configSchema, filtersSchema, planSchema, type Report } from "../shared/domain";
import { passwordHash } from "../shared/password.mjs";
import { query } from "./analysis";
import { comment, interpret } from "./assistant";
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
import { finish, start } from "./entra";

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
  const { user: u, hash } = await authenticate(e, req),
    { model, revision } = await config(e);
  const owner = u.id;
  if (p === "/me" && method === "GET") {
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
        ai: !!e.OPENAI_API_KEY && !!model?.allowAI,
      },
    });
  }
  if (p === "/microsoft/start" && method === "POST")
    return json(await start(e, required(model), revision, u, hash));
  if (p === "/microsoft/callback" && method === "GET") {
    try {
      await finish(e, required(model), revision, u, hash, url);
      return redirectProfile(e, "vinculado");
    } catch {
      return redirectProfile(e, "erro");
    }
  }
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
        user.role,
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
            "UPDATE users SET name=?,email=?,role=?,regions=?,clients=?,national=?,active=?,entra_oid=?,password=COALESCE(?,password),version=version+1,scope_version=scope_version+1 WHERE id=? AND (role<>'admin' OR active=0 OR ?=1 OR EXISTS(SELECT 1 FROM users other WHERE other.id<>users.id AND other.active=1 AND other.role='admin'))",
            ...fields,
            pw,
            id,
            +(user.active && user.role === "admin"),
          )
        : stmt(
            e,
            "INSERT INTO users(name,email,role,regions,clients,national,active,entra_oid,password,id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ...fields,
            pw,
            id,
            now(),
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
            "SELECT id,question,created,plan FROM turns WHERE conversation=? ORDER BY rowid",
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
      "SELECT t.plan,t.answer,t.evidence_hash FROM turns t JOIN conversations c ON c.id=t.conversation WHERE t.id=? AND c.owner=? AND c.version=? AND c.revision=?",
      historical,
      ...scope,
    ).first<{ plan: string; answer: string | null; evidence_hash: string | null }>();
    if (!turn) fail(404, "Resposta indisponível.");
    const report = await query(
      e,
      required(model),
      revision,
      u,
      planSchema.parse(JSON.parse(turn.plan)),
    );
    await checkAccess(e, u, revision, hash);
    const same = turn.evidence_hash === (await evidence(report));
    const commentary =
      same && turn.answer
        ? JSON.parse(turn.answer)
        : {
            summary:
              "Consulta atualizada no Power BI. Faça uma nova pergunta para interpretar os valores deste recorte.",
            actions: [],
          };
    await audit(e, owner, "resposta_reconsultada").run();
    return json({ report, commentary });
  }
  if (p === "/report" && method === "POST") {
    const plan = planSchema.parse(await body(req));
    await limit(e, "report:" + owner, 50, 60);
    const report = await query(e, required(model), revision, u, plan);
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
    const m = required(model);
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
    const plan = await interpret(e, m, v.question, v.filters, previous),
      report = await query(e, m, revision, u, plan);
    await checkAccess(e, u, revision, hash);
    const commentary = await comment(e, v.question, report).catch(() => ({
      summary:
        "Os indicadores foram consultados no Power BI. A interpretação da OpenAI está temporariamente indisponível.",
      actions: [],
    }));
    await checkAccess(e, u, revision, hash);
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
        "INSERT INTO turns(id,conversation,question,plan,created,answer,evidence_hash) VALUES(?,?,?,?,?,?,?)",
        turn,
        id,
        v.question,
        JSON.stringify(plan),
        now(),
        JSON.stringify(commentary),
        await evidence(report),
      ),
      audit(e, owner, "pergunta_consultada", plan.group),
    ]);
    return json({ id, turn, report, commentary });
  }
  fail(404, "Recurso desconhecido.");
}
function evidence(report: Report) {
  return digest(JSON.stringify([report.plan, report.total, report.rows, report.truncated]));
}
async function checkAccess(e: Env, u: DbUser, revision: number, hash: string) {
  const ok = await stmt(
    e,
    "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id AND u.version=s.version JOIN settings c ON c.id=1 WHERE s.hash=? AND u.id=? AND u.active=1 AND u.version=? AND c.revision=? AND s.expires>?",
    hash,
    u.id,
    u.version,
    revision,
    now(),
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
  async scheduled(_event: ScheduledController, e: Env) {
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
} satisfies ExportedHandler<Env>;
