import { change, metrics, type Metric, type Report } from '../shared/domain';
export type Cell = string | number | null;
export type ExportSheet = {
    name: string;
    rows: Cell[][];
    report?: Report;
};
export const availableMetrics = (r: Report): Metric[] => r.sourceInfo?.capabilities?.metrics ?? (Object.keys(r.total.values) as Metric[]).filter(m => r.total.values[m].current !== null || r.total.values[m].previous !== null);
export const metricLabel = (r: Report, m: Metric) => r.sourceInfo?.capabilities?.labels?.[m] ?? metrics[m].label;
export const dateLabel = (iso: string) => iso.includes('T') && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : iso;
export function filterLabel(r: Report) {
    const labels: Record<string, string> = {
        region: 'Representante',
        regions: 'Representantes',
        regional: 'Regional',
        regionals: 'Regionais',
        state: 'UF',
        states: 'UFs',
        manager: 'Gerente',
        managers: 'Gerentes',
        client: 'Cliente',
        clients: 'Clientes',
        product: 'Produto',
        products: 'Produtos',
        channels: 'Canais',
        segments: 'Segmentos',
        brands: 'Marcas',
        category: 'Categoria',
        categoriesInclude: 'Incluir categorias',
        categoriesExclude: 'Excluir categorias',
        revenueMin: 'Faturamento mín.',
        revenueMax: 'Faturamento máx.',
        ticketMin: 'Ticket mín.',
        ticketMax: 'Ticket máx.',
        variationDirection: 'Variação',
    };
    return Object.entries(r.plan.filters)
        .filter(([k, v]) => {
            if (k === 'from' || k === 'to') return false;
            if (k === 'variationDirection') return v && v !== 'all';
            return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== '';
        })
        .map(([k, v]) => {
            if (k === 'variationDirection') return `${labels[k]}: ${v === 'growth' ? 'Somente crescimento' : 'Somente queda'}`;
            if (typeof v === 'number') return `${labels[k] ?? k}: ${v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
            return (labels[k] ?? k) + ': ' + (Array.isArray(v) ? v.join(', ') : v);
        })
        .join(' · ') || 'Todo o escopo autorizado';
}
export function reportContext(r: Report) {
    return [r.comparison ? `${dateLabel(r.comparison.current.from)} a ${dateLabel(r.comparison.current.to)} × ${dateLabel(r.comparison.previous.from)} a ${dateLabel(r.comparison.previous.to)}` : `${r.plan.filters.from} a ${r.plan.filters.to} · comparação homóloga`, filterLabel(r), `${r.source} · extração ${dateLabel(r.sourceInfo?.extractedAt ?? r.asOf)} · versão ${r.sourceInfo?.versionId ?? 'Consulta online'}`, r.truncated ? `Ranking limitado: ${r.rows.length} registros retornados; total oficial considera todo o recorte autorizado.` : `${r.rows.length} registros retornados; total oficial calculado separadamente.`, ...(r.comparison?.reason ? [r.comparison.reason] : []), ...(r.warnings ?? [])];
}
/** Keep official numbers unchanged. Display-only transforms belong to the writer. */
export function reportSheet(r: Report, name = 'Resultados'): ExportSheet {
    const ms = availableMetrics(r);
    return { name, report: r, rows: [['Código', 'Identificação', ...ms.flatMap(m => [metricLabel(r, m) + ' atual', metricLabel(r, m) + ' anterior', metricLabel(r, m) + ' diferença absoluta', metricLabel(r, m) + (m === 'margin' ? ' variação (p.p.)' : ' variação (%)')])], ...[r.total, ...r.rows].map(row => [row.key ?? '', row.name, ...ms.flatMap(m => { const p = row.values[m]; return [p.current, p.previous, p.current !== null && p.previous !== null ? p.current - p.previous : null, change(p, m)]; })])] };
}
