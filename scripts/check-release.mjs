import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
const cfg = parse(readFileSync("wrangler.jsonc", "utf8"));
const id = cfg.d1_databases?.find((x) => x.binding === "DB")?.database_id;
if (!id || id === "00000000-0000-4000-8000-000000000000")
  throw Error("Configure o UUID do D1 dedicado em wrangler.jsonc.");
const origin = new URL(cfg.vars.APP_ORIGIN);
if (origin.protocol !== "https:" || origin.origin !== cfg.vars.APP_ORIGIN)
  throw Error("APP_ORIGIN precisa ser a origem HTTPS de produção, sem barra final.");
