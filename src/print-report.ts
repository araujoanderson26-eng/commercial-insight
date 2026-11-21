import { change, pretty, metrics, type Metric, type Report } from '../shared/domain';
import type { VisitBriefing } from '../shared/commercial';
import { availableMetrics, dateLabel, filterLabel, metricLabel, reportContext } from './export-model';
import { escapeXml as e } from './xlsx-layout';
import { isNativeApp } from './lib/runtime';
import { isUserShareCancel, printOrShareNativeHtml } from './lib/native-files';
const text = (v: string) => e(v);
const pct = (r: Report, m: Metric, row = r.total) => { const p = row.values[m], v = change(p, m); return v === null ? (p.current === null || p.previous === null ? 'Indisponível' : 'Não comparável') : (v > 0 ? '+' : '') + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (m === 'margin' ? ' p.p.' : '%'); };
const tone = (m: Metric, current: number | null, previous: number | null) => current === null || previous === null || current === previous ? '' : (current > previous) === metrics[m].up ? 'good' : 'bad';
const css = `@page{size:A4;margin:19mm 14mm 17mm;@top-left{content:'COMMERCIAL INSIGHT';font:9pt Arial;color:#17304f}@bottom-left{content:'Relatório comercial';font:8pt Arial;color:#64748b}@bottom-right{content:'Página ' counter(page) ' de ' counter(pages);font:8pt Arial;color:#64748b}}@page wide{size:A4 landscape;margin:19mm 14mm 17mm}*{box-sizing:border-box}body{font:11pt/1.45 Arial,sans-serif;color:#24364b;margin:0;background:white}h1,h2,h3,p{margin:0 0 10px}h1{font-size:26pt;line-height:1.12;color:#17304f}h2{font-size:17pt;color:#17304f;break-after:avoid}h3{font-size:11pt;color:#6750d8}.brand{background:#17304f;color:white;padding:16px 22px;margin-bottom:16px;border-radius:4px}.brand h1{color:white}.brand p{color:#d9dfea}.label{text-transform:uppercase;letter-spacing:1.4px;font-size:9pt;color:#6750d8;margin:20px 0 8px}.context{font-size:9pt;overflow-wrap:anywhere;color:#536277}.metadata{border-left:3px solid #6750d8;padding-left:14px;margin:16px 0}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.card{border:1px solid #d9e1eb;background:#f4f6f9;padding:11px 14px;break-inside:avoid}.card strong{display:block;font-size:16pt;color:#17304f;overflow-wrap:anywhere}.card small{display:block;font-size:9pt;margin-top:6px}.good{color:#16704a}.bad{color:#b72b39}.note{font-size:9pt;color:#536277;overflow-wrap:anywhere;margin:10px 0}.overview{break-after:page}.chart-page{break-before:page;break-after:page}.figure{break-inside:avoid;margin:16px 0;padding:16px;border:1px solid #d9e1eb}.figure svg{width:100%;height:auto;display:block}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:10pt;line-height:1.35;margin:10px 0 24px}th{background:#17304f;color:white;padding:10px 8px;text-align:right;vertical-align:middle;overflow-wrap:anywhere}td{padding:9px 8px;border-bottom:1px solid #e5eaf0;text-align:right;vertical-align:top;overflow-wrap:anywhere}th:nth-child(-n+2),td:nth-child(-n+2){text-align:left}tbody tr:nth-child(even){background:#f4f6f9}.total{background:#e8eef5!important;font-weight:bold}thead{display:table-header-group}tr{break-inside:avoid}h2,h3{break-after:avoid}.details{page:wide;break-before:page}.detail{break-inside:auto;margin-bottom:20px}.pauta{break-before:page}.pauta section{break-inside:auto;margin:18px 0}.pauta li{margin-bottom:10px;overflow-wrap:anywhere}a{color:#6750d8}.legend{display:flex;gap:18px;font-size:9pt;margin:10px 0}.dot{display:inline-block;width:9px;height:9px;margin-right:5px}.generation{font-size:9pt;color:#64748b;margin-top:16px}svg text{font-family:Arial,sans-serif}@media screen{body{max-width:1120px;margin:30px auto;padding:0 24px}.details{margin-top:40px}}`;
function graph(r: Report, title: string) {
    const m = r.plan.metric, items = r.rows.slice(0, r.plan.group === 'month' ? 24 : 10);
    if (!items.length || !items.some(v => v.values[m].current !== null || v.values[m].previous !== null))
        return '';
    const width = 640, height = Math.max(210, items.length * 32 + 45), left = 190, right = 110, plot = width - left - right;
    const values = items.flatMap(v => [v.values[m].current, v.values[m].previous]).filter((v): v is number => v !== null);
    const min = Math.min(0, ...values), max = Math.max(0, ...values), range = max - min || 1, x = (v: number) => left + (v - min) / range * plot, zero = x(0);
    const bars = items.map((v, i) => { const y = 22 + i * 32, label = v.key ?? v.name; return `<text x="${left - 10}" y="${y + 11}" text-anchor="end" font-size="10" fill="#24364b">${text(label.length > 27 ? label.slice(0, 26) + '…' : label)}</text>${(['current', 'previous'] as const).map((p, j) => { const value = v.values[m][p]; return value === null ? '' : `<rect x="${Math.min(x(value), zero)}" y="${y + j * 11}" width="${Math.max(0.5, Math.abs(x(value) - zero))}" height="8" rx="2" fill="${j ? '#a6b9d0' : '#6750d8'}"/><text x="${width - right + 12}" y="${y + 8 + j * 11}" font-size="9" fill="${j ? '#536277' : '#17304f'}">${text(pretty(value, m))}</text>`; }).join('')}`; }).join('');
    return `<figure class="figure"><h2>${text(title)}</h2><div class="legend"><span><i class="dot" style="background:#6750d8"></i>Atual</span><span><i class="dot" style="background:#a6b9d0"></i>Ano anterior</span></div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${text(title)}"><line x1="${zero}" y1="12" x2="${zero}" y2="${height - 20}" stroke="#d9e1eb"/>${bars}</svg><figcaption class="note">Unidade: ${metrics[m].unit === 'money' ? 'R$' : metrics[m].unit === 'count' ? 'quantidade' : '%'}. ${r.plan.group === 'month' ? 'Meses retornados pela consulta.' : `Primeiros ${items.length} registros da ordenação exportada.`} Rótulos extensos podem estar abreviados no gráfico; códigos e descrições completos nas tabelas. Não some atribuições de relações muitos-para-muitos.</figcaption></figure>`;
}
function detail(r: Report, title: string) { return `<div class="details">${availableMetrics(r).map(m => `<section class="detail"><h2>${text(title)} · ${text(metricLabel(r, m))}</h2><p class="context">${text(reportContext(r)[0])} · ${text(filterLabel(r))}</p><p class="note">${text(reportContext(r).slice(2).join(' '))}</p><table><colgroup><col style="width:10%"><col style="width:34%">${Array(4).fill('<col style="width:14%">').join('')}</colgroup><thead><tr><th>Código</th><th>Identificação</th><th>Atual${metrics[m].unit === 'money' ? ' (R$)' : ''}</th><th>Ano anterior${metrics[m].unit === 'money' ? ' (R$)' : ''}</th><th>Diferença${metrics[m].unit === 'money' ? ' (R$)' : ''}</th><th>Variação${m === 'margin' ? ' (p.p.)' : ' (%)'}</th></tr></thead><tbody>${[r.total, ...r.rows].map((v, i) => { const p = v.values[m], delta = p.current !== null && p.previous !== null ? p.current - p.previous : null; return `<tr${i === 0 ? ' class="total"' : ''}><td>${text(v.key ?? '')}</td><td>${text(v.name)}</td><td>${text(pretty(p.current, m))}</td><td>${text(pretty(p.previous, m))}</td><td class="${tone(m, p.current, p.previous)}">${text(m === 'margin' && delta !== null ? delta.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' p.p.' : pretty(delta, m))}</td><td class="${tone(m, p.current, p.previous)}">${text(pct(r, m, v))}</td></tr>`; }).join('')}</tbody></table></section>`).join('')}</div>`; }
export function executivePrintHtml(r: Report, visit?: VisitBriefing) {
    const generated = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), scope = visit?.client.name ?? (r.plan.filters.client ? 'Cliente ' + r.plan.filters.client : r.plan.filters.regional ? 'Regional ' + r.plan.filters.regional : r.plan.filters.region ? 'Representante ' + r.plan.filters.region : 'Escopo comercial autorizado');
    const cover = `<section class="overview"><div class="brand"><p>COMMERCIAL INSIGHT</p><h1>Relatório Comercial</h1></div><p class="label">${visit ? 'Preparação de visita' : 'Resumo Executivo'}</p><h2>${text(scope)}</h2><div class="metadata">${reportContext(r).map(v => `<p class="context">${text(v)}</p>`).join('')}</div><div class="cards">${availableMetrics(r).map(m => { const p = r.total.values[m]; return `<article class="card"><h3>${text(metricLabel(r, m))}</h3><strong>${text(pretty(p.current, m))}</strong><small>Ano anterior: ${text(pretty(p.previous, m))}</small><small class="${tone(m, p.current, p.previous)}">${text(pct(r, m))} · diferença ${text(p.current !== null && p.previous !== null && m === 'margin' ? (p.current - p.previous).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' p.p.' : pretty(p.current !== null && p.previous !== null ? p.current - p.previous : null, m))}</small></article>`; }).join('')}</div>${visit ? `<p>${text(visit.summary)}</p>` : ''}<p class="note">Valores ausentes permanecem indisponíveis. Percentuais exigem base anterior positiva; margens são comparadas em pontos percentuais. Os totais oficiais não são reconstruídos pela soma do ranking.</p><p class="generation">Gerado em ${text(generated)} (Brasília). Extração: ${text(dateLabel(r.sourceInfo?.extractedAt ?? r.asOf))}.</p></section>`;
    const reports = visit ? [['Histórico', visit.timeline], ['Mix', visit.products], ['Perdas de mix', visit.productLosses], ...(visit.categories ? [['Categorias', visit.categories]] : [])] as [
        string,
        Report
    ][] : [['Resultados', r]] as [
        string,
        Report
    ][];
    const charts = reports.map(([title, report]) => { const svg = graph(report, title); return svg ? `<section class="chart-page">${svg}<p class="context">${text(reportContext(report).join(' '))}</p></section>` : ''; }).join('');
    const pauta = visit ? `<section class="pauta"><h2>Pauta da visita</h2>${[['Objetivos', visit.objectives], ['Perguntas', visit.questions], ['Próximas ações sugeridas', visit.recommendations], ['Limitações', visit.limitations]].map(([title, list]) => `<section><h3>${text(title as string)}</h3><ul>${(list as string[]).map(v => `<li>${text(v)}</li>`).join('')}</ul></section>`).join('')}</section>` : '';
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commercial Insight · Relatório Comercial</title><style>${css}</style></head><body>${cover}${charts}${reports.map(([title, report]) => detail(report, title)).join('')}${pauta}</body></html>`;
}
export function printReport(r: Report, visit?: VisitBriefing) {
    const html = executivePrintHtml(r, visit);
    if (isNativeApp()) {
        const suffix = visit ? 'visita-' + visit.client.code : r.plan.filters.to;
        void printOrShareNativeHtml({
            html,
            filename: 'commercial-insight-' + suffix,
            jobName: 'Comercial Insight · Relatório Comercial',
        }).catch((err) => {
            if (!isUserShareCancel(err)) {
                window.alert(err instanceof Error ? err.message : 'Não foi possível gerar a visualização em PDF.');
            }
        });
        return;
    }
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
        window.alert('Permita a janela de impressão deste site para gerar o PDF.');
        return;
    }
    popup.opener = null;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    void popup.document.fonts.ready.then(() => { popup.focus(); popup.print(); });
}
