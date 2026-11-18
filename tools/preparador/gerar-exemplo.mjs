import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Synthetic fixture only. Never used as an application fallback or a production first load.
const facts = [
  { row: 1, date: '2025-01-10', region: 'Sul', client: '0001', product: 'Produto sintético', category: 'Teste', state: 'RS', values: { revenue: '100.00' } },
  { row: 2, date: '2026-01-10', region: 'Sul', client: '0001', product: 'Produto sintético', category: 'Teste', state: 'RS', values: { revenue: '200.00' } },
  { row: 3, date: '2026-01-11', region: 'Sul', client: '0002', product: 'Produto sintético', category: 'Teste', state: 'RS', values: { revenue: '50.00' } },
];
const columns = [ ['date', 'DateTime'], ['region', 'String'], ['client', 'String'], ['product', 'String'], ['category', 'String'], ['state', 'String'], ['revenue', 'Decimal'] ].map(([name,type])=>({name,type}));
const raw = { kind: 'rows', table: 't-sintetico', part: 1, rows: facts.map(f=>({ row:f.row, values: [f.date, f.region, f.client, f.product, f.category, f.state, f.values.revenue] })) };
const projection = { kind: 'facts', part: 1, rows: facts };
const line = x => JSON.stringify(x)+'\n';
const part = x => ({ index:1, rows:x.rows.length, bytes:Buffer.byteLength(line(x)), sha256:createHash('sha256').update(line(x)).digest('hex') });
const dimensions = ['date','region','client','product','category','state'];
const from = '2025-01-10', to='2026-01-11';
const controls = [
  ['total', {}, '350.00'],
  ['month', {from:'2026-01-01',to:'2026-01-31'}, '250.00'],
  ['region', {region:'Sul'}, '350.00'],
  ['client', {client:'0001'}, '300.00'],
  ['product', {product:'Produto sintético'}, '350.00'],
  ['state', {state:'RS'}, '350.00'],
].map(([context,filters,expected])=>({metric:'revenue',context,filters:{from,to,...filters},expected,dax:`EVALUATE ROW("sintetico", ${expected})`,referenceDate:'2026-11-18',tolerance:'0'}));
const manifest={
  kind:'manifest',format:'commercial-insight',formatVersion:1,sourceId:'commercial-main',
  model:{name:'EXEMPLO SINTÉTICO — APENAS TESTES',id:'synthetic-development-only'},extractedAt:'2026-11-18T12:00:00Z',sourceUpdatedAt:'2026-11-18T11:00:00Z',referenceDate:'2026-11-18',synthetic:true,stableExtraction:true,
  inventory:{tables:[{id:'t-sintetico',name:'Exemplo sintético',columns,rowCount:3,sourceRowCount:3,allowEmpty:false,storageMode:'Import',partitions:[{name:'Sintética',mode:'Import'}],parts:[part(raw)]}],measures:[{name:'Faturamento sintético',expression:"SUM('Exemplo sintético'[revenue])"}],relationships:[],dependencies:[],excluded:[{object:'PBIX real',reason:'Este pacote foi criado somente com dados inventados para testes; não comprova equivalência com Power BI.'}]},
  projection:{rowCount:3,from,to,grain:'Uma linha por fato sintético; nenhuma deduplicação.',dimensions,parts:[part(projection)]},
  metrics:[{id:'revenue',originalName:'Faturamento sintético',dax:"SUM('Exemplo sintético'[revenue])",unit:'money',kind:'sum',component:'revenue',scale:2,status:'validated',supportedFilters:dimensions}, ...['margin','buyers','returns'].map(id=>({id,originalName:id,dax:'',unit:id==='margin'?'percent':id==='buyers'?'count':'money',kind:'unavailable',scale:0,status:'unavailable',reason:'Não implementada neste exemplo sintético.',supportedFilters:dimensions}))],controls,
};
writeFileSync(fileURLToPath(new URL('./exemplo-sintetico.ci.ndjson',import.meta.url)),line(manifest)+line(raw)+line(projection),'utf8');
