import { z } from "zod";
import { configSchema, type ModelConfig, type User } from "../shared/domain";
export interface Env extends CloudflareBindings {
  MS_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  OPENAI_API_KEY?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MANUAL_ALLOW_SYNTHETIC?: string;
}
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new Problem(status, message);
}
export const now = () => Math.floor(Date.now() / 1000);
export const stmt = (e: Env, sql: string, ...args: (string | number | null)[]) =>
  e.DB.prepare(sql).bind(...args);
export const audit = (e: Env, actor: string | null, action: string, target: string | null = null) =>
  stmt(
    e,
    "INSERT INTO audit(actor,action,target,created) VALUES(?,?,?,?)",
    actor,
    action,
    target,
    now(),
  );
export async function config(e: Env) {
  const s = await stmt(e, "SELECT body,revision FROM settings WHERE id=1").first<{
    body: string;
    revision: number;
  }>();
  return { model: s ? configSchema.parse(JSON.parse(s.body)) : null, revision: s?.revision ?? 0 };
}
export function required(m: ModelConfig | null) {
  return m ?? fail(409, "O administrador precisa configurar o modelo do Power BI em Integrações.");
}
export const json = (v: unknown, status = 200, h: HeadersInit = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...h,
    },
  });
export async function body(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("application/json")) fail(415, "Envie JSON.");
  const reader = req.body?.getReader();
  if (!reader) fail(400, "Corpo vazio.");
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    n += part.value.length;
    if (n > 32768) {
      await reader.cancel();
      fail(413, "Conteúdo muito grande.");
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    fail(400, "JSON inválido.");
  }
}
export async function digest(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}
export function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
export async function limit(e: Env, key: string, max: number, seconds: number) {
  const bucket = Math.floor(now() / seconds);
  const id = await digest(key + "|" + bucket);
  const v = await stmt(
    e,
    "INSERT INTO throttle(key,hits,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits",
    id,
    (bucket + 1) * seconds,
  ).first<{ hits: number }>();
  if (!v || v.hits > max) fail(429, "Limite temporário atingido. Tente novamente mais tarde.");
}
export type DbUser = {
  id: string;
  email: string;
  name: string;
  password: string;
  role: User["role"];
  regions: string;
  clients: string;
  national: number;
  active: number;
  entra_oid: string | null;
  scope_version: number;
  version: number;
  update_only?: number;
};
export function publicUser(r: DbUser): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.update_only ? "operador" : r.role,
    regions: JSON.parse(r.regions),
    clients: JSON.parse(r.clients),
    national: !!r.national,
    active: !!r.active,
    entraOid: r.entra_oid,
  };
}
export const emailSchema = z.email().trim().toLowerCase().max(254);
export const passwordSchema = z.string().min(12, "Use pelo menos 12 caracteres.").max(128);
export const userSchema = z
  .object({
    name: z.string().trim().min(2).max(90),
    email: emailSchema,
    role: z.enum(["admin", "diretoria", "gerente", "comercial", "operador"]),
    national: z.boolean(),
    active: z.boolean(),
    regions: z.array(z.string().trim().min(1).max(140)).max(90),
    clients: z.array(z.string().trim().min(1).max(140)).max(250),
    entraOid: z.uuid().nullable(),
  })
  .strict()
  .refine(
    (u) => !u.national || ["admin", "diretoria"].includes(u.role),
    "Escopo nacional exclusivo da diretoria ou administração.",
  );
