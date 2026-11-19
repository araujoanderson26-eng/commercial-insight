import {
  change,
  deltaTitle,
  groups,
  metrics,
  pretty,
  type Commentary,
  type Filters,
  type Plan,
  type Report,
} from "../shared/domain";
import type { VisitBriefing } from "../shared/commercial";
import type { ManualManifest } from "../shared/manual";
import { prepareVisit } from "./commercial";
import { activeCsvBatch } from "./csv-importer";
import { stmt, type DbUser, type Env } from "./core";
import type { DeterministicIntent } from "./intent-router";
import { manualContext } from "./manual";
import {
  compileNativeContexts,
  nativeIdentityLabels,
  nativeKey,
  nativePeriod,
  type NativeContext,
} from "./native-model";
import { resolvePlanEntities, type DataProvider } from "./providers";

type EntityCounts = {
  registeredClients: number;
  buyingClients: number;
  registeredReps: number;
  activeReps: number;
  invoiceCount: number | null;
  ticketPerInvoice: number | null;
};

type ChurnedClientRow = {
  client: string;
  name: string;
  prevGross: number;
};

function scopeArrays(u: DbUser): { allowedRegions: string[]; allowedClients: string[] } {
  const national = u.role === "admin" || (u.role === "diretoria" && !!u.national);
  if (national) return { allowedRegions: [], allowedClients: [] };
  return {
    allowedRegions: JSON.parse(u.regions) as string[],
    allowedClients: JSON.parse(u.clients) as string[],
  };
}

function buildNativeCtx(u: DbUser, filters: Filters, m: ManualManifest, offset: number): NativeContext {
  const period = nativePeriod(m, filters);
  const range = offset === 0 ? period.current : period.previous;
  return {
    ...filters,
    ...range,
    ...scopeArrays(u),
  };
}

async function queryEntityCounts(
  e: Env,
  u: DbUser,
  m: ManualManifest,
  version: string,
  filters: Filters,
  netRevenue: number | null,
): Promise<EntityCounts> {
  const ctx = buildNativeCtx(u, filters, m, 0);
  const compiled = compileNativeContexts(version, [ctx], true);
  const tailIdx = compiled.sql.lastIndexOf("\nSELECT c.k,c.name,");
  if (tailIdx < 0) {
    return {
      registeredClients: 0,
      buyingClients: 0,
      registeredReps: 0,
      activeReps: 0,
      invoiceCount: null,
      ticketPerInvoice: null,
    };
  }
  const prefix = compiled.sql.slice(0, tailIdx);

  const countSql =
    prefix +
    ` SELECT
        (SELECT COUNT(DISTINCT b.client) FROM customer0 b JOIN visible_customers v ON v.k=b.k AND v.client IS b.client WHERE b.client IS NOT NULL) AS registered_clients,
        (SELECT COUNT(DISTINCT s.client) FROM visible_sales s WHERE s.k=0 AND s.client IS NOT NULL) AS buying_clients,
        (SELECT COUNT(DISTINCT b.representative) FROM customer0 b WHERE b.k=0 AND b.representative IS NOT NULL) AS registered_reps,
        (SELECT COUNT(DISTINCT b.representative) FROM visible_sales s JOIN customer0 b ON b.k=s.k AND b.client IS s.client WHERE s.k=0 AND b.representative IS NOT NULL) AS active_reps`;

  const row = await stmt(e, countSql, ...compiled.args).first<{
    registered_clients: number;
    buying_clients: number;
    registered_reps: number;
    active_reps: number;
  }>();

  let invoiceCount: number | null = null;
  let ticketPerInvoice: number | null = null;
  const csvActive = await activeCsvBatch(e);
  const acl = scopeArrays(u);
  if (
    csvActive &&
    !acl.allowedRegions.length &&
    !acl.allowedClients.length &&
    !filters.region &&
    !filters.regions?.length &&
    !filters.client &&
    !filters.clients?.length &&
    !filters.product &&
    !filters.products?.length &&
    !filters.state &&
    !filters.states?.length &&
    !filters.regional &&
    !filters.regionals?.length &&
    !filters.manager &&
    !filters.managers?.length &&
    !filters.category &&
    !filters.categoriesInclude?.length &&
    !filters.categoriesExclude?.length
  ) {
    const period = nativePeriod(m, filters);
    const nf = await stmt(
      e,
      "SELECT COUNT(DISTINCT doc_no) AS docs FROM ci_fact_sales WHERE batch_id=? AND date BETWEEN ? AND ? AND doc_no IS NOT NULL AND doc_no<>''",
      csvActive.batchId,
      period.current.from,
      period.current.to,
    ).first<{ docs: number }>();
    if (nf && nf.docs > 0) {
      invoiceCount = nf.docs;
      ticketPerInvoice = netRevenue !== null ? netRevenue / nf.docs : null;
    }
  }

  return {
    registeredClients: row?.registered_clients ?? 0,
    buyingClients: row?.buying_clients ?? 0,
    registeredReps: row?.registered_reps ?? 0,
    activeReps: row?.active_reps ?? 0,
    invoiceCount,
    ticketPerInvoice,
  };
}

async function queryChurnedClients(
  e: Env,
  u: DbUser,
  m: ManualManifest,
  version: string,
  filters: Filters,
): Promise<{ totalChurned: number; top: ChurnedClientRow[] }> {
  const curCtx = buildNativeCtx(u, filters, m, 0);
  const prevCtx = buildNativeCtx(u, filters, m, -1);
  const compiled = compileNativeContexts(version, [curCtx, prevCtx], true);
  const tailIdx = compiled.sql.lastIndexOf("\nSELECT c.k,c.name,");
  if (tailIdx < 0) return { totalChurned: 0, top: [] };

  const prefix = compiled.sql.slice(0, tailIdx);
  const sql =
    prefix +
    `,by_client AS (
       SELECT client,
         SUM(CASE WHEN k=0 AND amount>0 THEN amount ELSE 0 END) AS curr_pos,
         SUM(CASE WHEN k=1 THEN amount ELSE 0 END) AS prev_gross
       FROM visible_sales
       WHERE client IS NOT NULL
       GROUP BY client
     ),
     churned AS (
       SELECT client, prev_gross FROM by_client WHERE prev_gross>0 AND curr_pos=0
     )
     SELECT client, prev_gross, (SELECT COUNT(*) FROM churned) AS total_churned
     FROM churned
     ORDER BY prev_gross DESC, client ASC
     LIMIT 30`;

  const rows = (
    await stmt(e, sql, ...compiled.args).all<{
      client: string;
      prev_gross: number;
      total_churned: number;
    }>()
  ).results;
  if (!rows.length) return { totalChurned: 0, top: [] };

  const scale = m.nativeModel?.scale ?? 4;
  const labels = await nativeIdentityLabels(
    e,
    m,
    version,
    "client",
    rows.map((r) => r.client),
  );

  return {
    totalChurned: rows[0].total_churned,
    top: rows.map((r) => {
      const display = labels[r.client]?.name ?? labels[nativeKey(r.client) ?? r.client]?.name ?? r.client;
      return {
        client: r.client,
        name: display,
        prevGross: r.prev_gross / 10 ** scale,
      };
    }),
  };
}

function periodContextText(report: Report): string {
  const c = report.comparison;
  const cur = c ? `${c.current.from} a ${c.current.to}` : `${report.plan.filters.from} a ${report.plan.filters.to}`;
  const prev = c ? `${c.previous.from} a ${c.previous.to}` : "período equivalente anterior";
  const srcDate = report.sourceInfo?.referenceDate ? ` · base até ${report.sourceInfo.referenceDate}` : "";
  return `Fonte: ${report.source}${srcDate}. Recorte: ${cur} contra ${prev}.`;
}

export async function executeDeterministicQA(
  e: Env,
  u: DbUser,
  provider: DataProvider,
  intent: DeterministicIntent,
  activeFilters: Filters,
): Promise<{
  plan: Plan;
  report: Report;
  commentary: Commentary;
  visit?: VisitBriefing;
}> {
  const plan = await resolvePlanEntities(provider, intent.plan, activeFilters);
  const { versionId } = await manualContext(e, provider.versionId ?? undefined);
  const manifestRow = await stmt(e, "SELECT manifest FROM ci_imports WHERE id=?", versionId).first<{
    manifest: string;
  }>();
  const manifest = JSON.parse(manifestRow!.manifest) as ManualManifest;

  const [report, visit] = await Promise.all([
    provider.query(plan),
    intent.visitRequested ? prepareVisit(provider, plan.filters) : Promise.resolve(undefined),
  ]);

  const netCurrent = report.total.values.revenue.current;
  const srcNote = periodContextText(report);

  if (intent.kind === "visit_briefing" && visit) {
    return {
      plan,
      report,
      visit,
      commentary: {
        summary: `${visit.summary} ${srcNote}`,
        actions: visit.recommendations.length
          ? visit.recommendations.slice(0, 3)
          : visit.objectives.slice(0, 3),
      },
    };
  }

  if (
    intent.kind === "customer_counts" ||
    intent.kind === "buyers_period" ||
    intent.kind === "rep_registered_count" ||
    intent.kind === "rep_active_count"
  ) {
    const counts = await queryEntityCounts(e, u, manifest, versionId, plan.filters, netCurrent);
    report.summaryStats = {
      ...report.summaryStats,
      registeredClients: counts.registeredClients,
      registeredReps: counts.registeredReps,
      activeReps: counts.activeReps,
      ...(counts.invoiceCount !== null
        ? { invoiceCount: counts.invoiceCount, ticketPerInvoice: counts.ticketPerInvoice }
        : {}),
    };

    if (intent.kind === "customer_counts") {
      const inactiveRegistered = Math.max(0, counts.registeredClients - counts.buyingClients);
      return {
        plan,
        report,
        commentary: {
          summary: `Existem ${counts.registeredClients.toLocaleString("pt-BR")} clientes distintos cadastrados na Base Clientes dentro do seu escopo autorizado (deduplicados por código). No período selecionado, ${counts.buyingClients.toLocaleString("pt-BR")} clientes registraram compra ativa e ${inactiveRegistered.toLocaleString("pt-BR")} cadastrados estão sem compra no recorte. ${srcNote}`,
          actions: [
            "Trabalhar a reativação dos clientes cadastrados sem compras no período.",
            "Separar a base cadastrada da base compradora ao avaliar cobertura comercial.",
          ],
        },
      };
    }
    if (intent.kind === "buyers_period") {
      const buyersPrev = report.total.values.buyers.previous;
      return {
        plan,
        report,
        commentary: {
          summary: `${counts.buyingClients.toLocaleString("pt-BR")} clientes distintos realizaram compras no período selecionado${buyersPrev !== null ? ` (ante ${buyersPrev.toLocaleString("pt-BR")} no período equivalente anterior)` : ""}, de um total de ${counts.registeredClients.toLocaleString("pt-BR")} cadastrados autorizados. O faturamento líquido atingiu ${pretty(netCurrent, "revenue")}. ${srcNote}`,
          actions: [
            "Comparar a evolução da base compradora por UF ou regional para identificar regiões em retração.",
          ],
        },
      };
    }
    if (intent.kind === "rep_registered_count") {
      return {
        plan,
        report,
        commentary: {
          summary: `Existem ${counts.registeredReps.toLocaleString("pt-BR")} representantes distintos cadastrados na Base Clientes no seu escopo autorizado. Destes, ${counts.activeReps.toLocaleString("pt-BR")} tiveram vendas no período analisado. ${srcNote}`,
          actions: [
            "Verificar os representantes cadastrados sem faturamento no recorte para checar carteiras inativas ou compartilhadas.",
          ],
        },
      };
    }
    return {
      plan,
      report,
      commentary: {
        summary: `${counts.activeReps.toLocaleString("pt-BR")} representantes distintos tiveram vendas no período selecionado, de ${counts.registeredReps.toLocaleString("pt-BR")} representantes cadastrados no escopo autorizado. Faturamento líquido no recorte: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
        actions: [
          "Consultar o ranking de representantes por crescimento para destacar os principais vetores de expansão.",
        ],
      },
    };
  }

  if (intent.kind === "churned_clients") {
    const churn = await queryChurnedClients(e, u, manifest, versionId, plan.filters);
    const preview = churn.top
      .slice(0, 5)
      .map((item) => `${item.name} (${pretty(item.prevGross, "gross")} antes)`)
      .join("; ");
    return {
      plan,
      report,
      commentary: {
        summary:
          churn.totalChurned === 0
            ? `Nenhum cliente comprador do período anterior deixou de comprar no recorte atual. ${srcNote}`
            : `${churn.totalChurned.toLocaleString("pt-BR")} clientes compraram no período homólogo anterior e não registraram faturamento positivo no período atual. Principais por faturamento anterior: ${preview}. ${srcNote}`,
        actions:
          churn.totalChurned > 0
            ? [
                "Priorizar contato comercial com os clientes de maior volume histórico no período anterior.",
                "Exportar ou filtrar o ranking de queda para confirmar se houve substituição de CNPJ ou pausa sazonal.",
              ]
            : ["Manter o acompanhamento mensal de recorrência da carteira."],
      },
    };
  }

  if (intent.kind === "category_mix_share") {
    const totalNet = netCurrent ?? 0;
    const sumRows = report.rows.reduce((acc, row) => acc + Math.max(0, row.values.revenue.current ?? 0), 0);
    const denom = totalNet > 0 ? totalNet : sumRows;
    const topShares = report.rows
      .slice(0, 6)
      .map((row) => {
        const val = row.values.revenue.current ?? 0;
        const share = denom > 0 ? (val / denom) * 100 : 0;
        return `${row.name}: ${pretty(val, "revenue")} (${share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)`;
      })
      .join("; ");
    return {
      plan,
      report,
      commentary: {
        summary: `Participação sobre o faturamento líquido total de ${pretty(netCurrent, "revenue")}: ${topShares || "sem registros no recorte"}. ${report.truncated ? "Exibindo os 30 maiores grupos do ranking." : ""} ${srcNote}`,
        actions: [
          "Alternar para o modo Participação % no gráfico para visualizar o peso de cada categoria.",
          "Usar os filtros de inclusão/exclusão para isolar categorias principais de subprodutos como Granel.",
        ],
      },
    };
  }

  if (intent.kind === "category_filtered" || intent.kind === "metric_summary" || intent.kind === "yoy_growth") {
    const m = plan.metric;
    const p = report.total.values[m];
    const diff = p.current !== null && p.previous !== null ? p.current - p.previous : null;
    const pct = change(p, m);
    const grossPair = report.total.values.gross;
    const retPair = report.total.values.returns;
    const filterDesc = [
      plan.filters.state ? `UF ${plan.filters.state}` : "",
      plan.filters.categoriesInclude?.length
        ? `Incluindo: ${plan.filters.categoriesInclude.join(", ")}`
        : "",
      plan.filters.categoriesExclude?.length
        ? `Excluindo: ${plan.filters.categoriesExclude.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const extraDetail =
      m === "revenue" && grossPair.current !== null
        ? ` Bruto: ${pretty(grossPair.current, "gross")}, devoluções: ${pretty(retPair.current, "returns")}.`
        : "";

    return {
      plan,
      report,
      commentary: {
        summary: `${filterDesc ? `[${filterDesc}] ` : ""}${metrics[m].label}: ${pretty(p.current, m)} ante ${pretty(p.previous, m)} no período equivalente anterior (diferença de ${diff !== null ? (diff > 0 ? "+" : "") + pretty(diff, m) : "—"}; ${deltaTitle(pct, m)}).${extraDetail} ${srcNote}`,
        actions: [
          "Detalhar o recorte por cliente, produto ou UF para identificar os principais contribuintes da variação.",
        ],
      },
    };
  }

  // Rankings: clients in decline, products in growth, reps in growth, etc.
  const rankedList = report.rows
    .slice(0, 5)
    .map((row) => {
      const p = row.values[plan.metric];
      const d = p.current !== null && p.previous !== null ? p.current - p.previous : null;
      return `${row.name}: ${pretty(p.current, plan.metric)} vs ${pretty(p.previous, plan.metric)} (${d !== null ? (d > 0 ? "+" : "") + pretty(d, plan.metric) : "sem base"})`;
    })
    .join("; ");

  const orderLabel =
    plan.order === "decline"
      ? "maiores quedas absolutas"
      : plan.order === "growth"
        ? "maiores crescimentos absolutos"
        : "maiores valores atuais";

  return {
    plan,
    report,
    commentary: {
      summary: `Ranking de ${groups[plan.group]} por ${metrics[plan.metric].label.toLowerCase()} (${orderLabel}): ${rankedList || "nenhum item encontrado no recorte"}. Total oficial do recorte: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
      actions: [
        `Abrir o detalhamento de ${groups[plan.group].toLowerCase()} nos Relatórios para inspecionar os top 30 itens.`,
        "Validar com a equipe comercial os fatores de preço, mix ou frequência para os itens de maior variação.",
      ],
    },
  };
}
