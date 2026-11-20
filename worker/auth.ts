import { z } from "zod";
import { passwordHash, passwordOK } from "../shared/password.mjs";
import {
  allowedMobileOrigin,
  audit,
  body,
  digest,
  emailSchema,
  fail,
  json,
  limit,
  now,
  passwordSchema,
  scheduleBackground,
  stmt,
  token,
  type DbUser,
  type Env,
} from "./core";
export function origin(e: Env) {
  const url = new URL(e.APP_ORIGIN);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
    fail(503, "O endereço do aplicativo requer HTTPS.");
  return url.origin;
}
function cookieName(e: Env) {
  return origin(e).startsWith("https:") ? "__Host-ci" : "ci_local";
}
function cookie(e: Env, s: string, age: number) {
  return (
    cookieName(e) +
    "=" +
    s +
    "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" +
    age +
    (origin(e).startsWith("https:") ? "; Secure" : "")
  );
}
export async function authenticate(e: Env, req: Request, ctx?: ExecutionContext) {
  const cookieRaw = req.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((v) => v.startsWith(cookieName(e) + "="))
    ?.split("=")[1];
  const authHeader = req.headers.get("authorization");
  const bearerRaw =
    !cookieRaw && allowedMobileOrigin(e, req.headers.get("origin")) && authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : undefined;
  const raw = cookieRaw || bearerRaw;
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) fail(401, "Entre para continuar.");
  const hash = await digest(raw);
  const user = await stmt(
    e,
    "SELECT u.*,s.expires,s.seen FROM users u JOIN sessions s ON u.id=s.user_id AND u.version=s.version WHERE s.hash=? AND s.expires>? AND s.seen>? AND u.active=1",
    hash,
    now(),
    now() - 3600,
  ).first<DbUser & { expires: number; seen: number }>();
  if (!user) fail(401, "Sua sessão terminou. Entre novamente.");
  if (user.update_only) user.role = "operador";
  if (user.seen < now() - 60) {
    const touch = stmt(e, "UPDATE sessions SET seen=? WHERE hash=?", now(), hash).run();
    if (ctx && typeof ctx.waitUntil === "function") scheduleBackground(ctx, touch);
    else await touch;
  }
  return { user, hash };
}
export async function authRoute(e: Env, req: Request, path: string, ctx: ExecutionContext) {
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  if (path === "login") {
    const { email, password } = z
      .object({ email: emailSchema, password: z.string().min(1).max(128) })
      .parse(await body(req));
    await Promise.all([
      limit(e, "login-ip:" + ip, 40, 900),
      limit(e, "login-email:" + email, 12, 900),
    ]);
    const u = await stmt(e, "SELECT * FROM users WHERE email=?", email).first<DbUser>();
    if (!(await passwordOK(password, u?.password)) || !u?.active) {
      await audit(e, null, "login_negado").run();
      fail(401, "E-mail ou senha incorretos.");
    }
    const id = token(),
      expires = now() + 8 * 3600;
    await e.DB.batch([
      stmt(
        e,
        "INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,?,?,?)",
        await digest(id),
        u.id,
        u.version,
        expires,
        now(),
      ),
      audit(e, u.id, "login"),
    ]);
    const isCapacitorMobile = !!allowedMobileOrigin(e, req.headers.get("origin"))
      && req.headers.get("x-client-platform") === "capacitor";
    return json(isCapacitorMobile ? { ok: true, token: id } : { ok: true }, 200, { "Set-Cookie": cookie(e, id, 8 * 3600) });
  }
  if (path === "forgot") {
    const { email } = z.object({ email: emailSchema }).parse(await body(req));
    if (!e.RESEND_API_KEY || !e.MAIL_FROM)
      fail(503, "Recuperação por e-mail indisponível. Contate o administrador.");
    await Promise.all([
      limit(e, "reset-ip:" + ip, 15, 3600),
      limit(e, "reset-email:" + email, 4, 3600),
    ]);
    scheduleBackground(
      ctx,
      (async () => {
        const u = await stmt(
          e,
          "SELECT * FROM users WHERE email=? AND active=1",
          email,
        ).first<DbUser>();
        if (u) {
          const secret = token();
          const hash = await digest(secret);
          await e.DB.batch([
            stmt(e, "DELETE FROM recovery WHERE user_id=?", u.id),
            stmt(e, "INSERT INTO recovery VALUES(?,?,?,?)", hash, u.id, u.version, now() + 1200),
            audit(e, u.id, "recuperacao_solicitada"),
          ]);
          const link = origin(e) + "/redefinir#" + secret;
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + e.RESEND_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: e.MAIL_FROM,
              to: [email],
              subject: "Redefinir senha • Comercial Insight",
              text:
                "Abra este link em até 20 minutos para definir sua senha.\n\n" +
                link +
                "\n\nSe não solicitou a alteração, ignore este e-mail.",
            }),
            signal: AbortSignal.timeout(12000),
          }).catch(() => null);
          if (!response?.ok) {
            await e.DB.batch([
              stmt(e, "DELETE FROM recovery WHERE hash=?", hash),
              audit(e, u.id, "email_falhou"),
            ]);
          }
        }
      })().catch(() => console.error(JSON.stringify({ event: "recovery_delivery_failed" }))),
    );
    return json({ ok: true });
  }
  if (path === "reset") {
    await limit(e, "recovery:" + ip, 20, 900);
    const v = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: passwordSchema })
      .parse(await body(req));
    const hash = await digest(v.token);
    const owner = await stmt(
      e,
      "SELECT user_id FROM recovery WHERE hash=? AND expires>?",
      hash,
      now(),
    ).first<{ user_id: string }>();
    if (!owner) fail(400, "Link inválido ou expirado.");
    const out = await e.DB.batch([
      stmt(
        e,
        "UPDATE users SET password=?,version=version+1 WHERE active=1 AND EXISTS(SELECT 1 FROM recovery r WHERE r.hash=? AND r.expires>? AND r.user_id=users.id AND r.version=users.version)",
        await passwordHash(v.password),
        hash,
        now(),
      ),
      stmt(e, "DELETE FROM recovery WHERE hash=?", hash),
    ]);
    if (!out[0].meta.changes) fail(400, "Link inválido ou expirado.");
    await audit(e, owner.user_id, "senha_redefinida").run();
    return json({ ok: true });
  }
  const { user, hash } = await authenticate(e, req);
  if (path === "password") {
    await limit(e, "password:" + user.id, 6, 900);
    const v = z
      .object({ current: z.string().max(128), password: passwordSchema })
      .parse(await body(req));
    if (!(await passwordOK(v.current, user.password))) fail(400, "A senha atual está incorreta.");
    const changed = await stmt(
      e,
      "UPDATE users SET password=?,version=version+1 WHERE id=? AND version=?",
      await passwordHash(v.password),
      user.id,
      user.version,
    ).run();
    if (!changed.meta.changes) fail(409, "O cadastro mudou. Entre novamente.");
    await audit(e, user.id, "senha_alterada").run();
  } else if (path === "logout") {
    await stmt(e, "DELETE FROM sessions WHERE hash=?", hash).run();
  } else fail(404, "Recurso desconhecido.");
  return json({ ok: true }, 200, { "Set-Cookie": cookie(e, "", 0) });
}
