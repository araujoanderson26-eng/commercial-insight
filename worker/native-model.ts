import { z } from "zod";
import { metricKeys, monthsBetween, type DataCapabilities, type Filters, type Group, type Metric, type Plan, type Report, type Row } from "../shared/domain";
import { decimalInteger, type ControlFilters, type ManualManifest, type NativeModel } from "../shared/manual";
import type { CustomerDetails } from "../shared/commercial";
import { fail, stmt, type DbUser, type Env } from "./core";

type NativeRole = "sales" | "returns" | "customers" | "calendar" | "regions" | "municipalities" | "latitudes" | "repArea";
type NativeTable = ManualManifest["inventory"]["tables"][number];
type Sql = { sql:string; args:(string|number|null)[] };
export type NativeContext = ControlFilters & { categoriesInclude?:string[]; categoriesExclude?:string[]; macroTable?:string;macroKey?:string;macroValue?:string; name?:string; allowedRegions?:string[]; allowedClients?:string[] };
/** Matches the supported case-insensitive/accent-sensitive text contract while preserving raw/display values. */
export function nativeKey(value:string):string|null {
  const text=value.normalize("NFC").trimEnd();if(text.length===0)return null;
  const upper=text.toLocaleUpperCase("pt-BR");
  if([...upper].length!==[...text].length)throw Error("Texto requer uma regra de collation não suportada pelo contrato relacional.");
  return upper;
}
export const nativeCapabilities = (m:ManualManifest):DataCapabilities => ({
  metrics:["gross","revenue","returns","buyers"],
  groups:["month","client","region","product","category","state","regional",...(m.nativeModel?.regions.manager?["manager" as const]:[])],
  filters:["region","client","product","category","state","regional",...(m.nativeModel?.regions.manager?["manager" as const]:[])],
  labels:{region:"Representante",regional:"Regional",state:"UF",manager:"Gerente",revenue:"Faturamento líquido"},
});

const nativeTables:Record<NativeRole,string>={sales:"ci_native_sales",returns:"ci_native_returns",customers:"ci_native_customers",calendar:"ci_native_calendar",regions:"ci_native_regions",municipalities:"ci_native_municipalities",latitudes:"ci_native_latitudes",repArea:"ci_native_reparea"};
const fields:Record<NativeRole,string[]>={sales:["date","client","product","category","state","municipality","amount"],returns:["date","client","product","category","state","amount"],customers:["client","representative","state"],calendar:["date"],regions:["state","regional","manager"],municipalities:["name"],latitudes:["state"],repArea:["state"]};
export function native(m:ManualManifest):NativeModel { return m.nativeModel ?? fail(409,"Modelo relacional ausente nesta versão."); }
function table(m:ManualManifest,id:string):NativeTable { return m.inventory.tables.find(t=>t.id===id)??fail(400,"Tabela do contrato relacional não encontrada."); }
function binding(m:ManualManifest,role:NativeRole):{table:NativeTable;columns:(number|null)[]} {
  const ref=native(m)[role],t=table(m,ref.table);
  return {table:t,columns:fields[role].map(field=>{
    const name=(ref as Record<string,string|null|undefined>)[field];
    if(name==null&&role==="regions"&&field==="manager")return null;
    const index=t.columns.findIndex(c=>c.name===name);
    if(index<0)fail(400,"Coluna ausente no contrato: "+t.name+" / "+String(name));
    return index;
  })};
}
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function daxColumn(t:string,c:string) {return "(?:'"+escape(t.replaceAll("'","''"))+"'|"+escape(t)+")\\s*\\["+escape(c.replaceAll("]","]]"))+"\\]";}
function matches(expression:string,expected:string) {return new RegExp("^\\s*"+expected+"\\s*$","iu").test(expression);}
function measure(m:ManualManifest,name:string) {
  const list=m.inventory.measures.filter((item):item is {name:string;expression:string}=>typeof item==="object"&&item!==null&&"name"in item&&"expression"in item&&typeof item.name==="string"&&typeof item.expression==="string").filter(item=>item.name===name);
  if(list.length!==1)throw Error("A definição da medida deve existir uma única vez no inventário: "+name);
  return list[0].expression;
}
/** A restricted recipe recognizer, never an evaluator for arbitrary imported DAX/SQL. */
export function validateNativeModel(m:ManualManifest) {
  const n=native(m),ids=new Set<string>();
  for(const role of Object.keys(nativeTables) as NativeRole[]) {
    const b=binding(m,role);if(ids.has(b.table.id))throw Error("Papéis relacionais distintos não podem compartilhar uma tabela neste contrato.");ids.add(b.table.id);
  }
  const gross="SUM\\s*\\(\\s*"+daxColumn(table(m,n.sales.table).name,n.sales.amount)+"\\s*\\)";
  const returned="SUM\\s*\\(\\s*"+daxColumn(table(m,n.returns.table).name,n.returns.amount)+"\\s*\\)";
  const patterns={gross,returns:"(?:IF\\s*\\(\\s*ISBLANK\\s*\\(\\s*"+returned+"\\s*\\)\\s*,\\s*0\\s*,\\s*"+returned+"\\s*\\)|COALESCE\\s*\\(\\s*"+returned+"\\s*,\\s*0\\s*\\))",revenue:"\\["+escape(n.recipes.gross.measure.replaceAll("]","]]"))+"\\]\\s*-\\s*\\["+escape(n.recipes.returns.measure.replaceAll("]","]]"))+"\\]",buyers:"DISTINCTCOUNT\\s*\\(\\s*"+daxColumn(table(m,n.sales.table).name,n.sales.client)+"\\s*\\)"};
  for(const id of ["gross","returns","revenue","buyers"] as const) {
    const recipe=n.recipes[id],expression=measure(m,recipe.measure),metric=m.metrics.find(x=>x.id===id);
    if(expression!==recipe.dax||!matches(expression,patterns[id])||metric?.dax!==expression||metric.originalName!==recipe.measure||metric.kind!=="native"||metric.status!=="validated")throw Error("Receita DAX incompatível ou não comprovada: "+recipe.measure);
    if(id!=="buyers"&&metric.scale!==n.scale)throw Error("Escala monetária divergente do contrato relacional.");
  }
  validateNativeRelations(m);
  const expected=table(m,n.sales.table).rowCount+table(m,n.returns.table).rowCount;
  if(m.projection.rowCount!==expected)throw Error("Contagem da projeção relacional deve corresponder aos dois fatos, sem duplicá-los.");
}
function validateNativeRelations(m:ManualManifest) {
  const n=native(m);
  const relationSchema=z.object({fromTable:z.string(),fromColumn:z.string(),toTable:z.string(),toColumn:z.string(),fromCardinality:z.string(),toCardinality:z.string(),isActive:z.boolean(),crossFilteringBehavior:z.string()}).passthrough();
  const relationships=m.inventory.relationships.map(r=>relationSchema.parse(r)).filter(r=>r.isActive);
  type Endpoint=[string,string];
  const matchesRelation=(from:Endpoint,to:Endpoint,fromCard:string,toCard:string,direction:string)=>relationships.some(r=>r.fromTable===from[0]&&r.fromColumn===from[1]&&r.toTable===to[0]&&r.toColumn===to[1]&&r.fromCardinality.toLowerCase()===fromCard&&r.toCardinality.toLowerCase()===toCard&&r.crossFilteringBehavior.toLowerCase()===direction);
  const require=(from:Endpoint,to:Endpoint,a:string,b:string,direction:string)=>{if(!matchesRelation(from,to,a,b,direction))throw Error("Relacionamento necessário ausente, inativo ou incompatível: "+table(m,from[0]).name+" / "+from[1]+" → "+table(m,to[0]).name+" / "+to[1]);};
  require([n.sales.table,n.sales.date],[n.calendar.table,n.calendar.date],"many","one","onedirection");
  require([n.returns.table,n.returns.date],[n.calendar.table,n.calendar.date],"many","one","onedirection");
  require([n.customers.table,n.customers.client],[n.sales.table,n.sales.client],"many","many","bothdirections");
  require([n.returns.table,n.returns.client],[n.customers.table,n.customers.client],"many","many","onedirection");
  require([n.municipalities.table,n.municipalities.name],[n.sales.table,n.sales.municipality],"many","many","bothdirections");
  require([n.latitudes.table,n.latitudes.state],[n.customers.table,n.customers.state],"many","many","bothdirections");
  require([n.latitudes.table,n.latitudes.state],[n.repArea.table,n.repArea.state],"many","many","bothdirections");
  for(const [role,col]of [["sales",n.sales.state],["returns",n.returns.state],["customers",n.customers.state],["latitudes",n.latitudes.state]] as const)
    require([n[role].table,col],[n.regions.table,n.regions.state],"many","one","onedirection");
  // Reject added active paths into the query graph: the contract is specific, not a general DAX engine.
  const known=new Set([n.sales.table,n.returns.table,n.customers.table,n.calendar.table,n.regions.table,n.municipalities.table,n.latitudes.table,n.repArea.table]);
  const expectedInside=11;
  if(relationships.filter(r=>known.has(r.fromTable)&&known.has(r.toTable)).length!==expectedInside)throw Error("O grafo relacional mudou. Revalide o contrato antes de publicar.");
  const edges=relationships.flatMap(r=>r.crossFilteringBehavior.toLowerCase()==="bothdirections"?[[r.fromTable,r.toTable],[r.toTable,r.fromTable]]:[[r.toTable,r.fromTable]]);
  const reached=new Set([n.sales.table,n.customers.table,n.calendar.table,n.regions.table]);
  for(let changed=true;changed;) {changed=false;for(const [from,to]of edges)if(reached.has(from)&&!reached.has(to)){reached.add(to);changed=true;}}
  if(edges.some(([from,to])=>reached.has(from)&&!known.has(from)&&known.has(to)))throw Error("Uma nova dependência de filtro entra no contrato relacional. Revalide a propagação antes de publicar.");
}

/** Derived rows use exact scaled integers; raw rows are retained unchanged in ci_raw_rows. */
export function nativePartStatements(e:Env,m:ManualManifest,version:string,tableId:string,rows:{row:number;values:(string|boolean|null)[]}[]) {
  if(m.formatVersion!==2)return [];
  const role=(Object.keys(nativeTables) as NativeRole[]).find(key=>native(m)[key].table===tableId);
  if(!role)return [];
  const b=binding(m,role),scale=native(m).scale;
  const values=rows.map(row=>{
    const display:Record<string,string|null>={};
    const projected=b.columns.map((column,index)=>{
    if(column===null){display[fields[role][index]]=null;return null;}
    const value=row.values[column],field=fields[role][index];
    if(value===null){display[field]=null;return null;}
    if(typeof value!=="string")throw Error("Tabela "+b.table.name+", linha "+row.row+", coluna "+b.table.columns[column].name+": tipo incompatível com o contrato.");
    if(field==="amount")return decimalInteger(value,scale);
    if(field==="date") {const day=value.slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day||(!/^\d{4}-\d{2}-\d{2}$/.test(value)&&!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?(?:Z)?$/.test(value)))throw Error("Data relacional inválida ou com horário não nulo; nenhuma truncagem de chave foi aplicada.");display[field]=value;return day;}
    display[field]=value;return nativeKey(value);
  });return [version,row.row,...projected,JSON.stringify(display)];});
  const width=3+fields[role].length,chunk=Math.floor(90/width),statements:D1PreparedStatement[]=[];
  for(let start=0;start<values.length;start+=chunk) {
    const group=values.slice(start,start+chunk);
    statements.push(stmt(e,"INSERT INTO "+nativeTables[role]+"(version_id,row_no,"+fields[role].join(",")+",display) VALUES "+group.map(()=>"("+Array(width).fill("?").join(",")+")").join(",")+" ON CONFLICT DO NOTHING",...group.flat()));
  }
  return statements;
}

export function compileNativeContexts(version:string,contexts:NativeContext[],includeDimensions=false):Sql {
  if(contexts.length<1||contexts.length>10001)throw Error("Quantidade de contextos inválida.");
  const key=(s:string|undefined)=>s?nativeKey(s)??"":"";
  const normalized=contexts.map((c,index)=>({key:index,name:c.name??String(index),from:c.from,to:c.to,region:key(c.region),client:key(c.client),product:key(c.product),macroTable:c.macroTable??"",macroKey:c.macroKey??"",macroValue:c.macroValue??"",macroInclude:(c.categoriesInclude??[]).filter(v=>v.startsWith("Macro Categoria: ")).map(v=>key(v.slice(17))),macroExclude:(c.categoriesExclude??[]).filter(v=>v.startsWith("Macro Categoria: ")).map(v=>key(v.slice(17))),categoriesInclude:(c.categoriesInclude??[]).filter(v=>!v.startsWith("Macro Categoria: ")).map(key),categoriesExclude:(c.categoriesExclude??[]).filter(v=>!v.startsWith("Macro Categoria: ")).map(key),category:key(c.category),state:key(c.state),regional:key(c.regional),manager:key(c.manager),allowedRegions:(c.allowedRegions??[]).map(nativeKey),allowedClients:(c.allowedClients??[]).map(nativeKey)})).map(c=>({...c,hasRepresentative:c.region!==""||c.allowedRegions.length>0?1:0,hasSales:c.macroInclude.length>0||c.macroExclude.length>0||c.categoriesInclude.length>0||c.categoriesExclude.length>0||c.client!==""||c.product!==""||c.category!==""||c.state!==""||c.allowedClients.length>0?1:0}));
  const hasGeo=normalized.some(c=>c.regional!==""||c.manager!==""),hasReps=normalized.some(c=>c.hasRepresentative),hasSales=normalized.some(c=>c.hasSales),hasCustomerPath=hasReps||hasSales;
  const geoClause=(alias:string)=>hasGeo?" AND((c.regional='' AND c.manager='') OR EXISTS(SELECT 1 FROM geo WHERE geo.k=c.k AND geo.state IS "+alias+".state))":"";
  const customerCuts=[...(normalized.some(c=>c.region!=="")?[normalized.every(c=>c.region!=="")?"b.representative=c.representative":"(c.representative='' OR b.representative=c.representative)"]:[]),...(normalized.some(c=>c.allowedRegions.length)?[normalized.every(c=>c.allowedRegions.length)?"b.representative IN(SELECT value FROM json_each(c.allowed_reps))":"(json_array_length(c.allowed_reps)=0 OR b.representative IN(SELECT value FROM json_each(c.allowed_reps)))"]:[])];
  const macroProducts=(_alias:string,field:string)=>"SELECT product FROM macro_products WHERE k=c.k AND product IS NOT NULL AND macro IN(SELECT value FROM json_each(c."+field+"))";
  const salesCuts=[...(normalized.some(c=>c.macroExclude.length)?["(s.product IS NULL OR s.product NOT IN("+macroProducts("s","macro_exclude")+"))"]:[]),...(normalized.some(c=>c.categoriesInclude.length||c.macroInclude.length)?["((json_array_length(c.categories_include)=0 AND json_array_length(c.macro_include)=0) OR s.category IN(SELECT value FROM json_each(c.categories_include)) OR s.product IN("+macroProducts("s","macro_include")+"))"]:[]),...(normalized.some(c=>c.categoriesExclude.length)?["(s.category IS NULL OR s.category NOT IN(SELECT value FROM json_each(c.categories_exclude)))"]:[]),...(["client","product","category","state"] as const).filter(field=>normalized.some(c=>c[field]!=="")).map(field=>normalized.every(c=>c[field]!=="")?"s."+field+"=c."+field:"(c."+field+"='' OR s."+field+"=c."+field+")"),...(normalized.some(c=>c.allowedClients.length)?[normalized.every(c=>c.allowedClients.length)?"s.client IN(SELECT value FROM json_each(c.allowed_clients))":"(json_array_length(c.allowed_clients)=0 OR s.client IN(SELECT value FROM json_each(c.allowed_clients)))"]:[])];
  const visibleSales=hasReps?" JOIN ctx c ON c.k=s.k WHERE "+(normalized.every(c=>c.hasRepresentative)?"":"c.has_representative=0 OR ")+"EXISTS(SELECT 1 FROM customer0 b WHERE b.k=s.k AND b.client IS s.client)":"";
  const salesKeys="SELECT DISTINCT s.k,s.client FROM visible_sales s"+(normalized.every(c=>c.hasSales)?"":" JOIN ctx c ON c.k=s.k WHERE c.has_sales=1");
  const visibleCustomers=hasSales?"SELECT DISTINCT b.k,b.client FROM customer0 b JOIN sales_client_keys s ON s.k=b.k AND s.client IS b.client"+(normalized.every(c=>c.hasSales)?"":" UNION SELECT DISTINCT b.k,b.client FROM customer0 b JOIN ctx c ON c.k=b.k WHERE c.has_sales=0"):"SELECT DISTINCT b.k,b.client FROM customer0 b";
  const returnsCustomer=hasCustomerPath?" AND("+(normalized.every(c=>c.hasRepresentative||c.hasSales)?"":"(c.has_representative=0 AND c.has_sales=0) OR ")+"EXISTS(SELECT 1 FROM visible_customers b WHERE b.k=c.k AND b.client IS r.client))":"";
  const sql=`WITH
ctx AS MATERIALIZED (SELECT CAST(json_extract(value,'$.key') AS INTEGER) AS k,json_extract(value,'$.name') AS name,json_extract(value,'$.from') AS start,json_extract(value,'$.to') AS finish,json_extract(value,'$.region') AS representative,json_extract(value,'$.client') AS client,json_extract(value,'$.product') AS product,json_extract(value,'$.macroTable') AS macro_table,json_extract(value,'$.macroKey') AS macro_key,json_extract(value,'$.macroValue') AS macro_value,json_extract(value,'$.macroInclude') AS macro_include,json_extract(value,'$.macroExclude') AS macro_exclude,json_extract(value,'$.categoriesInclude') AS categories_include,json_extract(value,'$.categoriesExclude') AS categories_exclude,json_extract(value,'$.category') AS category,json_extract(value,'$.state') AS state,json_extract(value,'$.regional') AS regional,json_extract(value,'$.manager') AS manager,json_extract(value,'$.allowedRegions') AS allowed_reps,json_extract(value,'$.allowedClients') AS allowed_clients,json_extract(value,'$.hasRepresentative') AS has_representative,json_extract(value,'$.hasSales') AS has_sales FROM json_each(?)),
sales AS (SELECT * FROM ci_native_sales WHERE version_id=?),
returned AS (SELECT * FROM ci_native_returns WHERE version_id=?),
customers AS (SELECT * FROM ci_native_customers WHERE version_id=?),
regions AS MATERIALIZED (SELECT * FROM ci_native_regions WHERE version_id=?),
municipalities AS (SELECT * FROM ci_native_municipalities WHERE version_id=?),
latitudes AS (SELECT * FROM ci_native_latitudes WHERE version_id=?),
reparea AS (SELECT * FROM ci_native_reparea WHERE version_id=?),
calendar AS (SELECT * FROM ci_native_calendar WHERE version_id=?),
geo AS (SELECT DISTINCT c.k,r.state FROM ctx c JOIN regions r ON (c.regional='' OR r.regional=c.regional) AND(c.manager='' OR r.manager=c.manager)),
customer0 AS (SELECT c.k,b.client,b.representative,b.state,b.display FROM ctx c JOIN customers b ON ${customerCuts.join(" AND ")||"1=1"}${geoClause("b")}),
macro_products AS MATERIALIZED (SELECT c.k,UPPER(RTRIM(CAST(json_extract(p.value,c.macro_key) AS TEXT))) AS product,UPPER(RTRIM(CAST(json_extract(p.value,c.macro_value) AS TEXT))) AS macro FROM ctx c JOIN ci_raw_rows p ON p.version_id=(SELECT version_id FROM sales LIMIT 1) AND p.table_id=c.macro_table),
sales0 AS (SELECT c.k,s.* FROM ctx c JOIN sales s ON s.date>=c.start AND s.date<=c.finish${salesCuts.length?" AND "+salesCuts.join(" AND "):""} WHERE EXISTS(SELECT 1 FROM calendar d WHERE d.date=s.date)${geoClause("s")}),
visible_sales AS (SELECT ${includeDimensions?"s.*":"s.k,s.client,s.amount"} FROM sales0 s${visibleSales}),
sales_client_keys AS MATERIALIZED (${salesKeys}),
visible_customers AS MATERIALIZED (${visibleCustomers}),
visible_returns AS (SELECT c.k,r.row_no,r.client,r.state,r.amount FROM ctx c JOIN returned r ON r.date>=c.start AND r.date<=c.finish WHERE EXISTS(SELECT 1 FROM calendar d WHERE d.date=r.date)${geoClause("r")}${returnsCustomer}${normalized.some(c=>c.macroInclude.length)?" AND (json_array_length(c.macro_include)=0 OR json_array_length(c.categories_include)>0 OR r.product IN("+macroProducts("r","macro_include")+"))":""}${normalized.some(c=>c.macroExclude.length)?" AND (r.product IS NULL OR r.product NOT IN("+macroProducts("r","macro_exclude")+"))":""}),
sale_totals AS (SELECT k,SUM(amount) AS gross,COUNT(*) AS records,CASE WHEN COUNT(*)=0 THEN NULL ELSE COUNT(DISTINCT client)+CASE WHEN COUNT(*)>COUNT(client) THEN 1 ELSE 0 END END AS buyers FROM visible_sales GROUP BY k),
return_totals AS (SELECT k,SUM(amount) AS returned FROM visible_returns GROUP BY k)
SELECT c.k,c.name,s.gross,COALESCE(r.returned,0) AS returns,COALESCE(s.gross,0)-COALESCE(r.returned,0) AS revenue,s.buyers,NULL AS margin,COALESCE(s.records,0) AS records FROM ctx c LEFT JOIN sale_totals s ON s.k=c.k LEFT JOIN return_totals r ON r.k=c.k ORDER BY c.k`;
  return {sql,args:[JSON.stringify(normalized),...Array(8).fill(version)]};
}

export type NativeResult={k:number;name:string;gross:number|null;returns:number;revenue:number;buyers:number|null;margin:null;records:number};
export async function nativeValues(e:Env,version:string,contexts:NativeContext[]) {
  const q=compileNativeContexts(version,contexts);const rows=(await stmt(e,q.sql,...q.args).all<NativeResult>()).results;
  for(const row of rows)for(const id of ["gross","returns","revenue","buyers"] as const)if(row[id]!==null&&!Number.isSafeInteger(row[id]))throw Error("Resultado relacional excede a precisão inteira segura.");
  return rows;
}
export async function nativeControl(e:Env,m:ManualManifest,version:string,filters:ControlFilters,id:string) {
  const result=(await nativeValues(e,version,[filters]))[0];
  return nativeControlResult(m,result,id);
}
export function nativeControlResult(m:ManualManifest,result:NativeResult,id:string){
  const raw=result[id as keyof NativeResult];
  if(id==="margin"||raw===null||raw===undefined)return {raw:null,value:null};
  if(typeof raw!=="number")throw Error("Controle relacional inválido.");
  return {raw,value:id==="buyers"?raw:raw/10**native(m).scale};
}
function scope(u:DbUser,p:Plan) {
  if(u.role==="operador"||u.update_only)fail(403,"O operador de atualização não tem acesso às análises comerciais.");
  const regions=z.array(z.string()).parse(JSON.parse(u.regions)),clients=z.array(z.string()).parse(JSON.parse(u.clients));
  const national=u.role==="admin"||(u.role==="diretoria"&&!!u.national);
  if(!national&&((u.role==="gerente"&&!regions.length)||(!regions.length&&!clients.length)))fail(403,"Nenhuma carteira ou regional autorizada.");
  if(!national&&p.filters.region&&regions.length&&!regions.some(x=>nativeKey(x)===nativeKey(p.filters.region)))fail(403,"Seleção fora do seu escopo.");
  if(!national&&p.filters.client&&clients.length&&!clients.some(x=>nativeKey(x)===nativeKey(p.filters.client)))fail(403,"Seleção fora do seu escopo.");
  return {allowedRegions:national?[]:regions,allowedClients:national?[]:clients};
}
function dates(filters:Filters,offset:number) {
  const from=(Number(filters.from.slice(0,4))+offset)+filters.from.slice(4)+"-01";
  const to=new Date(Date.UTC(Number(filters.to.slice(0,4))+offset,Number(filters.to.slice(5,7)),0)).toISOString().slice(0,10);
  return {from,to};
}
/** A partial snapshot compares the same final calendar day, including leap-year clamping. */
export function nativePeriod(m:ManualManifest,filters:Filters):NonNullable<Report["comparison"]> {
  const requested=dates(filters,0),limit=[m.referenceDate,m.projection.to].sort()[0];
  const to=requested.to>limit?limit:requested.to;
  const current={from:requested.from,to};
  const shift=(day:string)=>{
    const year=Number(day.slice(0,4))-1,month=Number(day.slice(5,7)),date=Number(day.slice(8,10));
    return new Date(Date.UTC(year,month-1,Math.min(date,new Date(Date.UTC(year,month,0)).getUTCDate()))).toISOString().slice(0,10);
  };
  const previous={from:shift(current.from),to:shift(current.to)};
  const outside=current.from>current.to||current.from<m.projection.from||previous.from<m.projection.from;
  return {current,previous,status:outside?"outside-coverage":to!==requested.to?"partial":"comparable",...(outside?{reason:"A cobertura da versão não contém integralmente um dos períodos. Valores fora da cobertura ficam indisponíveis."}:to!==requested.to?{reason:"Período incompleto: comparação encerrada no mesmo dia do ano anterior, conforme a última data coberta pela versão."}:{})};
}
function context(u:DbUser,p:Plan,offset:number,m:ManualManifest):NativeContext {
  const period=nativePeriod(m,p.filters);
  const products=m.inventory.tables.find(t=>t.name==="Base Produtos"),ki=products?.columns.findIndex(c=>c.name==="Codigo Item")??-1,vi=products?.columns.findIndex(c=>c.name==="Macro Categoria")??-1;
  const related=products&&[native(m).sales,native(m).returns].every(f=>m.inventory.relationships.some(value=>{if(!value||typeof value!=="object")return false;const r=value as Record<string,unknown>;return r.isActive===true&&r.fromTable===f.table&&r.fromColumn===f.product&&r.toTable===products.id&&r.toColumn==="Codigo Item"&&r.crossFilteringBehavior==="OneDirection";}));
  if([...p.filters.categoriesInclude??[],...p.filters.categoriesExclude??[]].some(v=>v.startsWith("Macro Categoria: "))&&(!products||ki<0||vi<0||!related))fail(422,"Macro Categoria não está disponível nesta fonte.");
  return {...p.filters,macroTable:related?products?.id:undefined,macroKey:ki<0?undefined:"$["+ki+"]",macroValue:vi<0?undefined:"$["+vi+"]",...(offset===0?period.current:period.previous),...scope(u,p)};
}
function pair(name:string,a:NativeResult|undefined,b:NativeResult|undefined,m:ManualManifest):Row {
  const empty:NativeResult={k:0,name,gross:null,returns:0,revenue:0,buyers:null,margin:null,records:0};a??=empty;b??=empty;
  const values=Object.fromEntries(metricKeys.map(id=>[id,{current:a&&id!=="margin"?(a[id]===null?null:id==="buyers"?a[id]:a[id]/10**native(m).scale):null,previous:b&&id!=="margin"?(b[id]===null?null:id==="buyers"?b[id]:b[id]/10**native(m).scale):null}])) as Row["values"];
  return {name,values};
}
function groupedSales(group:Exclude<Group,"month">) {
  let input:string;
  if(["client","product","category","state"].includes(group)) input="SELECT s.k,s.row_no,s.client,s.amount,s."+group+" AS g,json_extract(s.display,'$."+group+"') AS name FROM visible_sales s";
  else if(group==="region") input="SELECT s.k,s.row_no,s.client,s.amount,b.representative AS g,json_extract(b.display,'$.representative') AS name FROM visible_sales s JOIN customer0 b ON b.k=s.k AND b.client IS s.client";
  else if(group==="regional"||group==="manager") input="SELECT s.k,s.row_no,s.client,s.amount,r."+group+" AS g,json_extract(r.display,'$."+group+"') AS name FROM visible_sales s JOIN ctx c ON c.k=s.k LEFT JOIN regions r ON r.state IS s.state WHERE c.has_representative=0 OR EXISTS(SELECT 1 FROM customer0 b LEFT JOIN regions rb ON rb.state IS b.state WHERE b.k=s.k AND b.client IS s.client AND rb."+group+" IS r."+group+")";
  else throw Error("Agrupamento não suportado pelo contrato.");
  return ",g_sales_raw AS ("+input+"),g_sales AS ("+(group==="region"?"SELECT k,g,row_no,client,MAX(amount) AS amount,MIN(name) AS name FROM g_sales_raw GROUP BY k,g,row_no,client":"SELECT k,g,row_no,client,amount,name FROM g_sales_raw")+")";
}
export function compileNativeContextSql(version:string,filters:NativeContext) {return compileNativeContexts(version,[filters]);}
export function compileNativeGroups(version:string,contexts:NativeContext[],group:Exclude<Group,"month">,options=false,rank?:{metric:Exclude<Metric,"margin">;order:Plan["order"]}):Sql {
  const base=compileNativeContexts(version,contexts,true),index=base.sql.lastIndexOf("\nSELECT c.k,c.name,");
  if(index<0)throw Error("Compilador relacional inconsistente.");
  if(options&&group==="region")return {sql:base.sql.slice(0,index)+",g_activity_keys AS MATERIALIZED (SELECT k,client FROM visible_sales UNION SELECT k,client FROM visible_returns),g_region_names AS (SELECT b.representative AS g,json_extract(b.display,'$.representative') AS name FROM customer0 b JOIN g_activity_keys a ON a.k=b.k AND a.client IS b.client) SELECT MIN(name) AS name FROM g_region_names WHERE g IS NOT NULL GROUP BY g ORDER BY MIN(name) LIMIT 251",args:base.args};
  const prefix=base.sql.slice(0,index)+groupedSales(group);
  const geographic=group==="regional"||group==="manager";
  if(options&&group!=="region"&&!geographic)return {sql:prefix+" SELECT MIN(name) AS name FROM g_sales WHERE g IS NOT NULL GROUP BY g ORDER BY MIN(name) LIMIT 251",args:base.args};
  let members:string,returnRows:string;
  if(group==="region"){
    members="SELECT DISTINCT b.k,b.representative AS g,b.client,json_extract(b.display,'$.representative') AS name FROM customer0 b JOIN visible_customers v ON v.k=b.k AND v.client IS b.client";
    returnRows="SELECT gc.k,gc.g,gc.name,r.row_no,r.amount FROM g_clients gc JOIN visible_returns r ON r.k=gc.k AND r.client IS gc.client";
  }else if(geographic){
    members="SELECT DISTINCT b.k,rg."+group+" AS g,b.client,json_extract(rg.display,'$."+group+"') AS name FROM customer0 b JOIN visible_customers v ON v.k=b.k AND v.client IS b.client JOIN ctx c ON c.k=b.k LEFT JOIN regions rg ON rg.state IS b.state WHERE c.has_sales=0 OR EXISTS(SELECT 1 FROM g_sales s WHERE s.k=b.k AND s.g IS rg."+group+" AND s.client IS b.client)";
    returnRows="SELECT r.k,rg."+group+" AS g,json_extract(rg.display,'$."+group+"') AS name,r.row_no,r.amount FROM visible_returns r JOIN ctx c ON c.k=r.k LEFT JOIN regions rg ON rg.state IS r.state WHERE(c.has_representative=0 AND c.has_sales=0) OR EXISTS(SELECT 1 FROM g_clients gc WHERE gc.k=r.k AND gc.g IS rg."+group+" AND gc.client IS r.client)";
  }else{
    members="SELECT DISTINCT s.k,s.g,s.client,s.name FROM g_sales s WHERE EXISTS(SELECT 1 FROM customer0 b WHERE b.k=s.k AND b.client IS s.client)";
    returnRows="SELECT gc.k,gc.g,gc.name,r.row_no,r.amount FROM g_clients gc JOIN visible_returns r ON r.k=gc.k AND r.client IS gc.client";
  }
  let grouped=prefix+",g_clients AS (SELECT k,g,client,MIN(name) AS name FROM ("+members+") GROUP BY k,g,client),g_return_rows AS ("+returnRows+")";
  if(options)return {sql:grouped+" SELECT MIN(name) AS name FROM (SELECT g,name FROM g_sales UNION ALL SELECT g,name FROM g_return_rows) WHERE g IS NOT NULL GROUP BY g ORDER BY MIN(name) LIMIT 251",args:base.args};
  grouped+=",g_totals AS (SELECT k,g,MIN(name) AS name,SUM(amount) AS gross,COUNT(*) AS records,COUNT(DISTINCT client)+CASE WHEN COUNT(*)>COUNT(client) THEN 1 ELSE 0 END AS buyers FROM g_sales GROUP BY k,g),g_returns AS (SELECT k,g,MIN(name) AS name,SUM(amount) AS returned FROM g_return_rows GROUP BY k,g),g_labels AS (SELECT k,g,MIN(name) AS name FROM (SELECT k,g,name FROM g_totals UNION ALL SELECT k,g,name FROM g_returns) GROUP BY k,g),g_values AS (SELECT l.k,l.g,l.name,t.gross,COALESCE(r.returned,0) AS returns,COALESCE(t.gross,0)-COALESCE(r.returned,0) AS revenue,t.buyers,NULL AS margin,COALESCE(t.records,0) AS records FROM g_labels l LEFT JOIN g_totals t ON t.k=l.k AND t.g IS l.g LEFT JOIN g_returns r ON r.k=l.k AND r.g IS l.g)";
  if(rank){
    if(!["gross","returns","revenue","buyers"].includes(rank.metric)||!["current","decline","growth"].includes(rank.order))throw Error("Ordenação relacional inválida.");
    const current="MAX(CASE WHEN k=0 THEN "+rank.metric+" END)",previous="MAX(CASE WHEN k=1 THEN "+rank.metric+" END)",score=rank.order==="current"?"COALESCE("+current+","+(["returns","revenue"].includes(rank.metric)?"0":"-1e300")+")":"COALESCE("+current+",0)-COALESCE("+previous+",0)";
    grouped+=",ranked AS (SELECT g,MIN(name) AS name,"+score+" AS score FROM g_values GROUP BY g ORDER BY score "+(rank.order==="decline"?"ASC":"DESC")+",name LIMIT 31) SELECT v.* FROM g_values v JOIN ranked r ON r.g IS v.g ORDER BY v.k,v.g";
  }else grouped+=" SELECT * FROM g_values ORDER BY k,g";
  return {sql:grouped,args:base.args};
}
/** Display enrichment is limited to keys already returned by an authorized query. It never joins facts. */
function identityBinding(m:ManualManifest,dimension:"client"|"product") {
  const candidates=dimension==="client"
    ?[{table:native(m).customers.table,key:native(m).customers.client,names:["Cliente","Razão Social","Razao Social","Nome do cliente"]}]
    :[{table:m.inventory.tables.find(t=>t.name==="Base Produtos")?.id,key:"Codigo Item",names:["Descrição do item","Descricao do item"]}];
  const source=candidates.find(candidate=>candidate.table&&m.inventory.tables.some(t=>t.id===candidate.table&&t.columns.some(c=>candidate.names.includes(c.name))&&t.columns.some(c=>c.name===candidate.key)));
  if(!source?.table)return null;
  const inventory=table(m,source.table),keyIndex=inventory.columns.findIndex(c=>c.name===source.key),descriptionIndex=inventory.columns.findIndex(c=>source.names.includes(c.name));
  return {table:source.table,keyPath:"$["+keyIndex+"]",descriptionPath:"$["+descriptionIndex+"]"};
}
export async function nativeIdentityLabels(e:Env,m:ManualManifest,version:string,dimension:"client"|"product",keys:string[]) {
  const identities:Record<string,{name:string;description?:string;descriptionConflict?:boolean}>={};
  if(!keys.length)return identities;
  const source=identityBinding(m,dimension);if(!source)return identities;
  const requested=new Map(keys.map(key=>[nativeKey(key),key]));
  // SQLite UPPER safely supports the ASCII commercial codes; non-ASCII codes retain their original label.
  const safeKeys=[...requested.keys()].filter((key):key is string=>key!==null&&/^[\x20-\x7E]+$/.test(key));
  if(!safeKeys.length)return identities;
  const result=(await stmt(e,"SELECT DISTINCT CAST(json_extract(value,?) AS TEXT) AS code,CAST(json_extract(value,?) AS TEXT) AS description FROM ci_raw_rows WHERE version_id=? AND table_id=? AND UPPER(RTRIM(CAST(json_extract(value,?) AS TEXT))) IN(SELECT value FROM json_each(?))",source.keyPath,source.descriptionPath,version,source.table,source.keyPath,JSON.stringify(safeKeys)).all<{code:string;description:string|null}>()).results;
  const descriptions=new Map<string,Set<string>>();
  for(const row of result){const key=requested.get(nativeKey(row.code));if(!key||!row.description?.trim())continue;const set=descriptions.get(key)??new Set<string>();set.add(row.description.trim());descriptions.set(key,set);}
  for(const [key,names]of descriptions){if(names.size===1){const description=[...names][0];identities[key]={name:key+" — "+description,description};}else identities[key]={name:key,descriptionConflict:true};}
  return identities;
}
export async function nativeSearch(e:Env,u:DbUser,filters:Filters,m:ManualManifest,version:string,dimension:"client"|"product"|"category",query:string) {
  if(!["client","product","category"].includes(dimension)||!query.trim()||query.length>100)fail(422,"Informe de 1 a 100 caracteres para a pesquisa.");
  const selected={...filters,client:"",product:"",category:"",categoriesInclude:[],categoriesExclude:[]},base=context(u,{filters:selected,metric:"revenue",group:dimension,order:"current"},0,m);
  if(dimension==="category"&&query.startsWith("Macro Categoria: ")){const q=compileNativeOptions(version,base,["category"]),rows=(await stmt(e,q.sql,...q.args).all<{dimension:string;name:string}>()).results.filter(v=>v.name.toLocaleLowerCase("pt-BR")===query.toLocaleLowerCase("pt-BR"));return{items:rows.map(v=>({key:v.name,name:v.name})),truncated:false};}
  const allowed=compileNativeGroups(version,[{...base,from:m.projection.from,to:[m.referenceDate,m.projection.to].sort()[0]}],dimension,true);
  const source=dimension==="category"?null:identityBinding(m,dimension),pattern="%"+query.trim().replace(/[\\%_]/g,"\\$&")+"%";
  // The scoped membership query is reused; names can never introduce a key outside that membership.
  const prefix=source?"WITH identity_matches AS MATERIALIZED (SELECT UPPER(RTRIM(CAST(json_extract(value,?) AS TEXT))) AS code FROM ci_raw_rows WHERE version_id=? AND table_id=? AND CAST(json_extract(value,?) AS TEXT) LIKE ? ESCAPE '\\') ":"";
  let sql=prefix+"SELECT a.name FROM ("+allowed.sql.replace(/ LIMIT 251$/,"")+") a WHERE a.name LIKE ? ESCAPE '\\'";
  const args:Sql["args"]=[...(source?[source.keyPath,version,source.table,source.descriptionPath,pattern]:[]),...allowed.args,pattern];
  if(source)sql+=" OR UPPER(RTRIM(a.name)) IN(SELECT code FROM identity_matches)";
  sql+=" ORDER BY a.name LIMIT 21";
  const rows=(await stmt(e,sql,...args).all<{name:string}>()).results,keys=rows.slice(0,20).map(row=>row.name),labels=dimension==="category"?{}:await nativeIdentityLabels(e,m,version,dimension,keys);
  return {items:keys.map(key=>({key,name:labels[key]?.name??key})),truncated:rows.length>20};
}
/** Daily activity reuses the same fact visibility and ACL as every financial query. */
export async function nativeCustomerDetails(e:Env,u:DbUser,filters:Filters,m:ManualManifest,version:string):Promise<CustomerDetails> {
  if(!filters.client)fail(422,"Selecione um único cliente para consultar sua atividade diária.");
  const current=context(u,{filters,metric:"revenue",group:"month",order:"current"},0,m);
  const base=compileNativeContexts(version,[current],true),split=base.sql.lastIndexOf("\nSELECT c.k,c.name,");
  if(split<0)throw Error("Compilador relacional inconsistente.");
  const prefix=base.sql.slice(0,split),period={from:current.from,to:current.to};
  const available=period.from<=period.to&&period.from>=m.projection.from&&period.to<=m.projection.to;
  const limitations=["A última compra observada e a frequência usam dias com soma de faturamento bruto positiva no período selecionado. Dias distintos não equivalem a pedidos, notas ou visitas."];
  let lastPurchase:string|null=null,purchaseDays:number|null=null,municipality:string|null=null;
  if(available){
    const activity=await stmt(e,prefix+",purchase_days AS (SELECT date FROM visible_sales GROUP BY date HAVING SUM(amount)>0) SELECT MAX(date) AS lastPurchase,COUNT(*) AS purchaseDays FROM purchase_days",...base.args).first<{lastPurchase:string|null;purchaseDays:number}>();
    lastPurchase=activity?.lastPurchase??null;purchaseDays=activity?.purchaseDays??0;
  }else limitations.push("A atividade diária está indisponível porque o período atual não está integralmente coberto pela versão.");
  const customers=table(m,native(m).customers.table),keyIndex=customers.columns.findIndex(c=>c.name===native(m).customers.client);
  const municipalityIndex=customers.columns.findIndex(c=>["Município","Municipio","Cidade"].includes(c.name));
  if(municipalityIndex<0)limitations.push("O cadastro Base Clientes desta versão não possui coluna de município. O município de documentos de faturamento não foi tratado como endereço cadastral.");
  else {
    const location=await stmt(e,prefix+" SELECT DISTINCT CAST(json_extract(r.value,?) AS TEXT) AS municipality FROM ci_raw_rows r WHERE r.version_id=? AND r.table_id=? AND UPPER(RTRIM(CAST(json_extract(r.value,?) AS TEXT)))=? AND EXISTS(SELECT 1 FROM customer0 b JOIN ctx c ON c.k=b.k WHERE b.client=c.client) LIMIT 3",...base.args,"$["+municipalityIndex+"]",version,customers.id,"$["+keyIndex+"]",nativeKey(filters.client)).all<{municipality:string|null}>();
    const names=new Map<string,string>();
    for(const row of location.results){const name=row.municipality?.trim();if(name){const key=nativeKey(name);if(key)names.set(key,name);}}
    if(names.size===1&&location.results.length<3)municipality=[...names.values()][0];
    else limitations.push(names.size>1||location.results.length===3?"Há municípios cadastrais conflitantes para o código do cliente; nenhum endereço foi escolhido automaticamente.":"Município cadastral não informado para o cliente no escopo autorizado.");
  }
  return {lastPurchase,purchaseDays,municipality,limitations,period};
}
export async function queryNative(e:Env,u:DbUser,p:Plan,m:ManualManifest,version:string):Promise<Report> {
  if(!nativeCapabilities(m).groups.includes(p.group)||!nativeCapabilities(m).metrics.includes(p.metric))fail(422,"Indicador ou agrupamento indisponível nesta versão.");
  if(p.filters.manager&&!native(m).regions.manager)fail(422,"Gerente não está mapeado nesta versão.");
  const current=context(u,p,0,m),previous=context(u,p,-1,m),period=nativePeriod(m,p.filters);
  const total=await nativeValues(e,version,[current,previous]);let rows:Row[]=[];
  if(p.group==="month") {
    const contexts:NativeContext[]=[];const count=monthsBetween(p.filters.from,p.filters.to);
    for(let i=0;i<=count;i++) {
      const date=new Date(Date.UTC(Number(p.filters.from.slice(0,4)),Number(p.filters.from.slice(5))-1+i,1));
      const month=date.toISOString().slice(0,7),monthly=nativePeriod(m,{...p.filters,from:month,to:month});
      for(const offset of [0,-1]) contexts.push({...current,...(offset===0?monthly.current:monthly.previous),name:month});
    }
    const results=await nativeValues(e,version,contexts);for(let i=0;i<results.length;i+=2)rows.push(pair(results[i].name,results[i],results[i+1],m));
  } else {
    const q=compileNativeGroups(version,[current,previous],p.group,false,{metric:p.metric as Exclude<Metric,"margin">,order:p.order}),results=(await stmt(e,q.sql,...q.args).all<NativeResult&{g:string|null}>()).results;
    const keys=new Set(results.map(r=>r.g));
    const byContext=[new Map(results.filter(r=>r.k===0).map(r=>[r.g,r])),new Map(results.filter(r=>r.k===1).map(r=>[r.g,r]))];
    for(const key of keys){const a=byContext[0].get(key),b=byContext[1].get(key),name=a?.name??b?.name??"(Em branco)";rows.push({...pair(name,a,b,m),...(key===null?{canDrill:false}:{key:name})});}
    const score=(r:Row)=>p.order==="current"?(r.values[p.metric].current??-Infinity):(r.values[p.metric].current??0)-(r.values[p.metric].previous??0);
    rows.sort((a,b)=>(p.order==="decline"?1:-1)*(score(a)-score(b))||a.name.localeCompare(b.name,"pt-BR"));
  }
  const result:Report={total:pair("Total",total[0],total[1],m),rows:rows.slice(0,30),plan:p,asOf:new Date().toISOString(),truncated:rows.length>30,source:"Arquivo manual (D1)",comparison:period};
  const available=(range:{from:string;to:string})=>range.from<=range.to&&range.from>=m.projection.from&&range.to<=m.projection.to;
  for(const row of [result.total,...result.rows])for(const metric of metricKeys){
    let currentRange=period.current,previousRange=period.previous;
    if(p.group==="month"&&row!==result.total){const monthly=nativePeriod(m,{...p.filters,from:row.name,to:row.name});currentRange=monthly.current;previousRange=monthly.previous;}
    if(!available(currentRange))row.values[metric].current=null;
    if(!available(previousRange))row.values[metric].previous=null;
  }
  if(p.group!=="month")result.warnings=["Os relacionamentos muitos-para-muitos do Power BI podem atribuir o mesmo cliente ou devolução a mais de um grupo. Não some as linhas para reconstruir o total oficial; ele é calculado separadamente."];
  if(p.group==="client"||p.group==="product"){
    const labels=await nativeIdentityLabels(e,m,version,p.group,result.rows.filter(row=>row.key).map(row=>row.key!));
    for(const row of result.rows){const identity=row.key?labels[row.key]:undefined;if(identity)Object.assign(row,identity);}
  }
  return result;
}
export async function nativeOptions(e:Env,u:DbUser,filters:Filters,m:ManualManifest,version:string) {
  if(filters.manager&&!native(m).regions.manager)fail(422,"Gerente não está mapeado nesta versão.");
  const p:Plan={metric:"revenue",group:"month",order:"current",filters};scope(u,p);
  const base=context(u,p,0,m),values:Record<string,string[]>={},truncated:Record<string,boolean>={};
  const groups=["region","client","product","category","state","regional",...(native(m).regions.manager?["manager" as const]:[])] as const;
  const q=compileNativeOptions(version,base,groups),results=(await stmt(e,q.sql,...q.args).all<{dimension:string;name:string}>()).results;
  for(const group of groups) {
    const visible=results.filter(r=>r.dimension===group).map(r=>r.name);
    values[group]=visible.slice(0,250);truncated[group]=visible.length>250;
  }
  const labels:Record<string,Record<string,string>>={};
  for(const group of ["client","product"] as const){const identities=await nativeIdentityLabels(e,m,version,group,values[group]);labels[group]=Object.fromEntries(Object.entries(identities).map(([key,value])=>[key,value.name]));}
  return {values,labels,sourceVersion:version,truncated};
}
export function compileNativeOptions(version:string,context:NativeContext,groups:readonly Exclude<Group,"month">[]):Sql{
  if(groups.length===0)throw Error("Nenhuma dimensão de opções foi solicitada.");
  const base=compileNativeContexts(version,[context],true),tails:string[]=[],selects:string[]=[];
  // Options need membership and display names, never fact amounts or fact multiplicity.
  // Keep the existing date/ACL graph, then materialize only the necessary distinct tuples.
  // In particular, geographic membership must not re-run correlated joins for every fact.
  const names=(["client","product","category","state"] as const).map(field=>"MIN(json_extract(s.display,'$."+field+"')) AS "+field+"_name").join(",");
  let prefix=base.sql.slice(0,base.sql.indexOf(",\nsale_totals AS"));
  prefix=prefix.replace(/visible_sales AS \(SELECT s\.\* FROM sales0 s([\s\S]*?)\),\nsales_client_keys/,(_,tail:string)=>"visible_sales AS MATERIALIZED (SELECT s.k,s.client,s.product,s.category,s.state,"+names+" FROM sales0 s"+tail+" GROUP BY s.k,s.client,s.product,s.category,s.state),\nsales_client_keys");
  prefix=prefix.replace("visible_returns AS (SELECT c.k,r.row_no,r.client,r.state,r.amount","visible_returns AS MATERIALIZED (SELECT DISTINCT c.k,r.client,r.state");
  prefix+=",o_sales_clients AS MATERIALIZED (SELECT DISTINCT k,client,state FROM visible_sales)";
  for(const [index,group]of groups.entries()){
    const p="o"+index;let values:string;
    if(group==="client"||group==="product"||group==="category"||group==="state"){values="SELECT "+group+" AS g,"+group+"_name AS name FROM visible_sales";
    if(group==="category"&&context.macroTable&&context.macroValue&&context.macroKey)values+=" UNION SELECT DISTINCT 'Macro Categoria: '||CAST(json_extract(p.value,c.macro_value) AS TEXT) AS g,'Macro Categoria: '||CAST(json_extract(p.value,c.macro_value) AS TEXT) AS name FROM ctx c JOIN ci_raw_rows p ON p.version_id=(SELECT version_id FROM sales LIMIT 1) AND p.table_id=c.macro_table WHERE EXISTS(SELECT 1 FROM visible_sales s WHERE s.k=c.k AND s.product=UPPER(RTRIM(CAST(json_extract(p.value,c.macro_key) AS TEXT))))";
    }else if(group==="region"){
      tails.push(","+p+"_activity_keys AS MATERIALIZED (SELECT k,client FROM visible_sales UNION SELECT k,client FROM visible_returns)");
      values="SELECT b.representative AS g,json_extract(b.display,'$.representative') AS name FROM customer0 b JOIN "+p+"_activity_keys a ON a.k=b.k AND a.client IS b.client";
    }else if(group==="regional"||group==="manager"){
      tails.push(","+p+"_sales AS MATERIALIZED (SELECT DISTINCT s.k,s.client,r."+group+" AS g,json_extract(r.display,'$."+group+"') AS name FROM o_sales_clients s JOIN ctx c ON c.k=s.k LEFT JOIN regions r ON r.state IS s.state WHERE c.has_representative=0 OR EXISTS(SELECT 1 FROM customer0 b LEFT JOIN regions rb ON rb.state IS b.state WHERE b.k=s.k AND b.client IS s.client AND rb."+group+" IS r."+group+"))");
      tails.push(","+p+"_clients AS MATERIALIZED (SELECT DISTINCT b.k,rg."+group+" AS g,b.client FROM customer0 b JOIN visible_customers v ON v.k=b.k AND v.client IS b.client JOIN ctx c ON c.k=b.k LEFT JOIN regions rg ON rg.state IS b.state WHERE c.has_sales=0 OR EXISTS(SELECT 1 FROM "+p+"_sales s WHERE s.k=b.k AND s.g IS rg."+group+" AND s.client IS b.client))");
      tails.push(","+p+"_returns AS (SELECT r.k,rg."+group+" AS g,json_extract(rg.display,'$."+group+"') AS name FROM visible_returns r JOIN ctx c ON c.k=r.k LEFT JOIN regions rg ON rg.state IS r.state WHERE(c.has_representative=0 AND c.has_sales=0) OR EXISTS(SELECT 1 FROM "+p+"_clients gc WHERE gc.k=r.k AND gc.g IS rg."+group+" AND gc.client IS r.client))");
      values="SELECT g,name FROM "+p+"_sales UNION ALL SELECT g,name FROM "+p+"_returns";
    }else throw Error("Agrupamento não suportado pelo contrato.");
    selects.push("SELECT '"+group+"' AS dimension,name FROM (SELECT MIN(name) AS name FROM ("+values+") WHERE g IS NOT NULL GROUP BY g ORDER BY MIN(name) LIMIT 251)");
  }
  // D1 limits each compound SELECT to five terms, unlike desktop SQLite's default 500.
  // Nest binary compounds so all dimensions still share this one scoped CTE evaluation.
  const compound=(parts:string[]):string=>parts.length===1?parts[0]:"SELECT * FROM ("+compound(parts.slice(0,Math.ceil(parts.length/2)))+") UNION ALL SELECT * FROM ("+compound(parts.slice(Math.ceil(parts.length/2)))+")";
  return {sql:prefix+tails.join("")+" "+compound(selects),args:base.args};
}
export const nativeStorageTables=Object.values(nativeTables);
export async function validateNativeStorage(e:Env,m:ManualManifest,version:string){
  for(const role of Object.keys(nativeTables) as NativeRole[]){
    const row=await stmt(e,"SELECT COUNT(*) AS n FROM "+nativeTables[role]+" WHERE version_id=?",version).first<{n:number}>();
    if(row?.n!==table(m,native(m)[role].table).rowCount)throw Error("Contagem normalizada divergente: "+role);
  }
  for(const [storage,column]of [["ci_native_regions","state"],["ci_native_calendar","date"]]){
    const duplicate=await stmt(e,"SELECT COUNT(*) AS n FROM "+storage+" WHERE version_id=? GROUP BY "+column+" HAVING COUNT(*)>1 LIMIT 1",version).first<{n:number}>();
    if(duplicate)throw Error("Chave do lado um duplicada após normalização da collation: "+storage);
  }
}
