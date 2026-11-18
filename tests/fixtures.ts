import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { configSchema, type Plan, type User } from "../shared/domain";
import type { Env } from "../worker/core";
export const model = configSchema.parse({
  tenant: crypto.randomUUID(),
  application: crypto.randomUUID(),
  workspace: crypto.randomUUID(),
  dataset: crypto.randomUUID(),
  mode: "application",
  factTable: "Vendas",
  columns: Object.fromEntries(
    ["date", "client", "region", "product", "category"].map((k) => [
      k,
      { table: "Dim " + k, column: "Nome" },
    ]),
  ),
  measures: {
    revenue: "Receita líquida",
    margin: "Margem %",
    buyers: "Compradores",
    returns: "Devoluções",
  },
  marginScale: "fraction",
  scopedMeasuresReviewed: true,
  allowAI: true,
});
export const filters = { from: "2026-01", to: "2026-03", region: "", client: "", product: "" };
export const plan: Plan = { filters, metric: "revenue", group: "month", order: "current" };
export const user: User = {
  id: crypto.randomUUID(),
  name: "Gerente de teste",
  role: "gerente",
  email: "gerente@example.test",
  active: true,
  regions: ["Sul"],
  clients: ["Loja A"],
  national: false,
  entraOid: null,
};
export function makeStore() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  for (const file of ["0001_inicial", "0002_respostas", "0003_manual_data", "0004_source_activation"])
    sql.exec(readFileSync(new URL("../migrations/" + file + ".sql", import.meta.url), "utf8"));
  class Prepared {
    constructor(
      readonly text: string,
      readonly params: (string | number | null)[] = [],
    ) {}
    bind(...values: (string | number | null)[]) {
      return new Prepared(this.text, values);
    }
    first() {
      return Promise.resolve(sql.prepare(this.text).get(...this.params) ?? null);
    }
    run() {
      return Promise.resolve({ meta: sql.prepare(this.text).run(...this.params) });
    }
    all() {
      return Promise.resolve({ results: sql.prepare(this.text).all(...this.params) });
    }
  }
  const db = {
    prepare: (text: string) => new Prepared(text),
    async batch(stmts: Prepared[]) {
      sql.exec("BEGIN");
      try {
        const rows = [];
        for (const s of stmts) rows.push(await s.run());
        sql.exec("COMMIT");
        return rows;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: "https://example.test",
    OPENAI_MODEL: "test-model",
    OPENAI_API_KEY: "test-only",
    MS_CLIENT_SECRET: "test-only",
    RESEND_API_KEY: "test-only",
    MAIL_FROM: "test@example.test",
    RETENTION_DAYS: "90",
  } as Env;
  return { sql, env };
}
export function biRows(current = 120) {
  return {
    results: [
      {
        tables: [
          {
            rows: [
              {
                "[kind]": "total",
                "[label]": "Total",
                "[revenue_c]": current,
                "[revenue_p]": 100,
                "[margin_c]": 0.2,
                "[margin_p]": 0.15,
              },
              {
                "[kind]": "entry",
                "[label]": "2026-01",
                "[revenue_c]": current,
                "[revenue_p]": 100,
              },
            ],
          },
        ],
      },
    ],
  };
}
