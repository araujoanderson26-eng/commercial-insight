import { change, deltaTitle, metrics, pretty, type Filters, type Group, type Plan, type Report } from "../shared/domain";
import type { AssistantStatus, CommercialInsight, VisitBriefing } from "../shared/commercial";
import { fail, type Env } from "./core";
import type { DataProvider } from "./providers";

export function isVisitRequest(question: string) {
  return /\b(?:visita|visitar|visito|visitarei|reunião|reuniao|briefing)\b/iu.test(question);
}

/** No model-generated executable code enters this service. The provider reapplies ACL to every plan. */
export function reportInsights(report: Report): CommercialInsight[] {
  const { metric, filters } = report.plan;
  const pair = report.total.values[metric];
  const period = { from: filters.from, to: filters.to };
  const result: CommercialInsight[] = [];
  if (pair.current !== null && pair.previous !== null) {
    const absolute = pair.current - pair.previous;
    const favorable = absolute === 0 ? null : (absolute > 0) === metrics[metric].up;
    const percent = change(pair, metric);
    result.push({ id: `total:${metric}:${filters.from}:${filters.to}`, kind: "fact",
      severity: favorable === null ? "neutral" : favorable ? "favorable" : "warning",
      title: `${metrics[metric].label}: comparação com o ano anterior`,
      detail: `Atual: ${pretty(pair.current, metric)}. Anterior: ${pretty(pair.previous, metric)}. Diferença: ${pretty(absolute, metric)}. ${deltaTitle(percent, metric)}.`,
      metric, impact: absolute, period,
      action: absolute === 0 ? "Acompanhar o próximo período equivalente." : favorable ? "Identificar e preservar os fatores comerciais que sustentam o resultado." : "Revisar os clientes e produtos com maior contribuição para a perda.",
    });
  }
  if (report.comparison && report.comparison.status !== "outside-coverage") {
    for (const row of report.rows) {
      const gross = row.values.gross;
      const beyondCurrent = report.plan.group === "month" && row.name > report.comparison.current.to.slice(0, 7);
      if (!beyondCurrent && gross.previous !== null && gross.previous > 0 && gross.current === null) {
        result.push({ id: `inactive:${report.plan.group}:${row.key ?? row.name}:${filters.from}:${filters.to}`, kind: "fact", severity: "warning",
          title: `${row.name}: sem venda bruta observada`,
          detail: `Havia ${pretty(gross.previous, "gross")} de faturamento bruto no período equivalente anterior. Não há venda bruta observada no período atual coberto pela base; o indicador atual permanece indisponível, sem percentual de queda.`,
          metric: "gross", impact: gross.previous, period,
          action: "Confirmar com o cliente a interrupção observada e avaliar uma retomada do mix histórico.",
        });
      }
      if (result.length >= 6) break;
    }
  }
  const changes = report.rows.filter(row => row.values[metric].current !== null && row.values[metric].previous !== null)
    .map(row => ({ row, impact: row.values[metric].current! - row.values[metric].previous! }))
    .filter(value => value.impact !== 0)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  for (const { row, impact } of changes.slice(0, 5)) {
    const favorable = (impact > 0) === metrics[metric].up;
    result.push({ id: `${report.plan.group}:${row.name}:${metric}:${filters.from}:${filters.to}`, kind: "fact",
      severity: favorable ? "favorable" : "warning", title: row.name,
      detail: `${metrics[metric].label}: ${pretty(row.values[metric].current, metric)} ante ${pretty(row.values[metric].previous, metric)} no período equivalente; diferença de ${pretty(impact, metric)}.`,
      metric, impact, period,
      action: favorable ? "Confirmar na reunião como sustentar a evolução observada." : "Perguntar ao responsável quais fatores explicam a variação; a base não comprova a causa.",
    });
  }
  return result;
}

export function assistantStatus(env: Env, provider: DataProvider): AssistantStatus {
  const enabledForSource = provider.semantics.allowAI;
  const credentialConfigured = Boolean(env.OPENAI_API_KEY);
  const pending: AssistantStatus["pending"] = [
    ...(!enabledForSource ? ["source_disabled" as const] : []),
    ...(!credentialConfigured ? ["credential_missing" as const] : []),
  ];
  const reason = !enabledForSource ? "source_disabled" : !credentialConfigured ? "credential_missing" : "ready";
  return { source: provider.sourceType, enabledForSource, credentialConfigured, model: env.OPENAI_MODEL,
    ready: reason === "ready", reason, pending,
    message: pending.length === 2
      ? "Há duas pendências: habilitar a análise com IA na configuração da fonte e cadastrar OPENAI_API_KEY como secret do Worker."
      : reason === "source_disabled"
      ? "A análise com IA está desabilitada na configuração desta fonte. Um administrador pode habilitá-la em Atualização de dados."
      : reason === "credential_missing"
        ? "A fonte permite IA, mas falta cadastrar OPENAI_API_KEY como secret do Worker."
        : "A fonte permite IA e a credencial está cadastrada. A conexão será validada na próxima pergunta.",
  };
}

export async function prepareVisit(provider: DataProvider, filters: Filters): Promise<VisitBriefing> {
  if (!filters.client) fail(422, "Selecione um cliente pelo código para preparar a visita. Se houver nomes semelhantes, escolha o cadastro correto.");
  if (!provider.semantics.measures.revenue) fail(422, "Faturamento líquido ainda não conciliado para esta fonte.");
  const supported = (group: Group) => !provider.semantics.capabilities || provider.semantics.capabilities.groups.includes(group);
  if (!supported("client") || !supported("product")) fail(422, "Esta fonte não disponibiliza cliente e produto para preparar a visita.");
  const plan = (group: Group, order: Plan["order"] = "current"): Plan => ({ group, metric: "revenue", order, filters: { ...filters } });
  // The first four independent reads share one immutable provider. Keep optional reads in the next batch.
  const [timeline, products, productLosses, identity] = await Promise.all([
    provider.query(plan("month")), provider.query(plan("product")), provider.query(plan("product", "decline")), provider.query(plan("client")),
  ]);
  if (identity.rows.length > 1) fail(422, "O código selecionado identifica mais de um cadastro. Selecione um único cliente.");
  let clientName = identity.rows[0]?.name;
  if (!clientName && provider.search) {
    const found = await provider.search(filters, "client", filters.client);
    const exact = found.items.filter(item => item.key.trim().toLocaleLowerCase("pt-BR") === filters.client.trim().toLocaleLowerCase("pt-BR"));
    if (exact.length === 1) clientName = exact[0].name;
  }
  if (!clientName) fail(422, "O código selecionado não identifica um cliente no histórico autorizado. Ajuste o período ou selecione outro cadastro.");
  const noRecentIdentity = identity.rows.length === 0;
  const optionalGroups = (["category", "region", "state", "regional"] as const).filter(supported);
  const optionalReports = await Promise.all(optionalGroups.map(group => provider.query(plan(group))));
  const optional = Object.fromEntries(optionalGroups.map((group, index) => [group, optionalReports[index]])) as Partial<Record<Group, Report>>;
  const customerDetails = provider.customerDetails ? await provider.customerDetails(filters) : null;
  const salesMetric = provider.semantics.measures.gross ? "gross" : "revenue";
  const purchaseMonths = timeline.rows.filter(row => (row.values[salesMetric].current ?? 0) > 0).map(row => row.name).sort();
  const pair = timeline.total.values.revenue;
  const net = pretty(pair.current, "revenue");
  const percent = change(pair, "revenue");
  const insights = [...reportInsights(timeline).filter(value => value.id.startsWith("total:")).slice(0, 1),
    ...reportInsights(productLosses).filter(value => !value.id.startsWith("total:")).slice(0, 4)];
  const returns = timeline.total.values.returns;
  if (returns.current !== null && returns.previous !== null && returns.current > returns.previous) {
    insights.push({ id: `returns:${filters.client}:${filters.from}:${filters.to}`, kind: "fact", severity: "warning",
      title: "Aumento de devoluções", detail: `${pretty(returns.current, "returns")} ante ${pretty(returns.previous, "returns")} no período equivalente.`,
      metric: "returns", impact: returns.current - returns.previous, period: { from: filters.from, to: filters.to },
      action: "Conferir os documentos de devolução e perguntar os motivos; a base não contém as causas.",
    });
  }
  const limitations = [
    "O briefing usa somente o período, o cliente e o escopo autorizados informados. Não contém preços negociados, estoque, reclamações nem histórico de visitas.",
    customerDetails
      ? "Última compra e frequência usam dias com valor bruto positivo no recorte autorizado. Dias de compra não são quantidade de pedidos ou notas fiscais."
      : "A última compra exata e a frequência por documento não estão disponíveis nesta fonte. A atividade indica meses com valor positivo, não quantidade de pedidos.",
    `${customerDetails?.municipality ? "Município informado pelo cadastro comprovado." : "Município cadastral não disponível na camada de consultas."} Representantes, UFs e regionais correspondem aos vínculos com movimento no recorte; mais de um vínculo exige confirmação.`,
    "Categorias exibem apenas o histórico do próprio cliente. Uma hipótese de ampliação de mix deve ser confirmada na visita.",
  ];
  limitations.push(...(customerDetails?.limitations ?? []));
  limitations.push(...(timeline.warnings ?? []));
  if (timeline.comparison?.reason) limitations.push(timeline.comparison.reason);
  if (noRecentIdentity) limitations.push("Cliente localizado no histórico autorizado, sem movimentos nos períodos consultados. O briefing não presume compras recentes; amplie o período para consultar o histórico anterior disponível.");
  if (salesMetric === "revenue") limitations.push("Sem faturamento bruto conciliado, meses com valor líquido positivo são apenas um sinal de atividade; devoluções podem ocultar compras.");
  if (products.truncated || productLosses.truncated) limitations.push("Rankings de produtos limitados aos 30 primeiros de cada ordenação; mix e perdas podem ser parciais.");
  if (timeline.sourceInfo) limitations.push(`Base extraída em ${timeline.sourceInfo.extractedAt}; posição manual, sem atualização em tempo real.`);
  const losses = productLosses.rows.filter(row => row.values.revenue.current !== null && row.values.revenue.previous !== null && row.values.revenue.current < row.values.revenue.previous);
  const lossNames = losses.slice(0, 3).map(row => row.name);
  return {
    client: { code: filters.client, name: clientName, municipality: customerDetails?.municipality ?? null,
      states: optional.state?.rows.map(row => row.name) ?? [], representatives: optional.region?.rows.map(row => row.name) ?? [],
      regionals: optional.regional?.rows.map(row => row.name) ?? [] },
    filters: { ...filters }, timeline, products, productLosses, categories: optional.category ?? null, insights,
    summary: `${clientName}: ${noRecentIdentity ? "sem movimentos observados nos períodos consultados" : "faturamento líquido de " + net}. Período atual: ${timeline.comparison?.current.from ?? filters.from} a ${timeline.comparison?.current.to ?? filters.to}; anterior: ${timeline.comparison?.previous.from ?? (Number(filters.from.slice(0,4))-1)+filters.from.slice(4)} a ${timeline.comparison?.previous.to ?? (Number(filters.to.slice(0,4))-1)+filters.to.slice(4)}. ${deltaTitle(percent, "revenue")}. As causas das variações devem ser confirmadas na reunião.`,
    objectives: ["Validar com o cliente a evolução de compras e as devoluções do período.", ...(lossNames.length ? [`Revisar a recuperação de mix em: ${lossNames.join("; ")}.`] : ["Revisar a continuidade do mix observado e a programação das próximas compras."])],
    questions: ["Que mudanças na operação ou no consumo ajudam a explicar a evolução observada?", ...(lossNames.length ? [`O que mudou nas compras de ${lossNames.join("; ")}?`] : []), "Quais produtos do histórico podem voltar à programação?", "Quais próximos passos, responsáveis e datas podemos combinar?"],
    recommendations: [...new Set(insights.filter(value => value.severity === "warning").map(value => value.action))].slice(0, 3),
    activity: { lastPurchase: customerDetails?.lastPurchase ?? null, lastPurchaseMonth: purchaseMonths.at(-1) ?? null,
      purchaseDays: customerDetails?.purchaseDays ?? null, monthsWithPurchases: purchaseMonths.length,
      monthsAnalyzed: timeline.rows.length, observedProductCount: products.rows.length, productCountIsPartial: products.truncated },
    limitations, generatedAt: new Date().toISOString(),
  };
}
