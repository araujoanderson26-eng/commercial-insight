import { z } from "zod";
import { metricKeys, monthsBetween, type DataCapabilities, type Filters, type Group, type Metric, type Plan, type Report, type Row } from "../shared/domain";
import { decimalInteger, type ControlFilters, type ManualManifest, type NativeModel } from "../shared/manual";
import { fail, stmt, type DbUser, type Env } from "./core";

type NativeRole = "sales" | "returns" | "customers" | "calendar" | "regions" | "municipalities" | "latitudes" | "repArea";
type NativeTable = ManualManifest["inventory"]["tables"][number];
type Sql = { sql:string; args:(string|number|null)[] };
export type NativeContext = ControlFilters & { name?:string; allowedRegions?:string[]; allowedClients?:string[] };
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
  filters:["region","client","product","state","regional",...(m.nativeModel?.regions.manager?["manager" as const]:[])],
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
  const normalized=contexts.map((c,index)=>({key:index,name:c.name??String(index),from:c.from,to:c.to,region:key(c.region),client:key(c.client),product:key(c.product),category:key(c.category),state:key(c.state),regional:key(c.regional),manager:key(c.manager),allowedRegions:(c.allowedRegions??[]).map(nativeKey),allowedClients:(c.allowedClients??[]).map(nativeKey)})).map(c=>({...c,hasRepresentative:c.region!==""||c.allowedRegions.length>0?1:0,hasSales:c.client!==""||c.product!==""||c.category!==""||c.state!==""||c.allowedClients.length>0?1:0}));
  const hasGeo=normalized.some(c=>c.regional!==""||c.manager!==""),hasReps=normalized.some(c=>c.hasRepresentative),hasSales=normalized.some(c=>c.hasSales),hasCustomerPath=hasReps||hasSales;
  const geoClause=(alias:string)=>hasGeo?" AND((c.regional='' AND c.manager='') OR EXISTS(SELECT 1 FROM geo WHERE geo.k=c.k AND geo.state IS "+alias+".state))":"";
  const customerCuts=[...(normalized.some(c=>c.region!=="")?[normalized.every(c=>c.region!=="")?"b.representative=c.representative":"(c.representative='' OR b.representative=c.representative)"]:[]),...(normalized.some(c=>c.allowedRegions.length)?[normalized.every(c=>c.allowedRegions.length)?"b.representative IN(SELECT value FROM json_each(c.allowed_reps))":"(json_array_length(c.allowed_reps)=0 OR b.representative IN(SELECT value FROM json_each(c.allowed_reps)))"]:[])];
  const salesCuts=[...(["client","product","category","state"] as const).filter(field=>normalized.some(c=>c[field]!=="")).map(field=>normalized.every(c=>c[field]!=="")?"s."+field+"=c."+field:"(c."+field+"='' OR s."+field+"=c."+field+")"),...(normalized.some(c=>c.allowedClients.length)?[normalized.every(c=>c.allowedClients.length)?"s.client IN(SELECT value FROM json_each(c.allowed_clients))":"(json_array_length(c.allowed_clients)=0 OR s.client IN(SELECT value FROM json_each(c.allowed_clients)))"]:[])];
  const visibleSales=hasReps?" JOIN ctx c ON c.k=s.k WHERE "+(normalized.every(c=>c.hasRepresentative)?"":"c.has_representative=0 OR ")+"EXISTS(SELECT 1 FROM customer0 b WHERE b.k=s.k AND b.client IS s.client)":"";
  const salesKeys="SELECT DISTINCT s.k,s.client FROM visible_sales s"+(normalized.every(c=>c.hasSales)?"":" JOIN ctx c ON c.k=s.k WHERE c.has_sales=1");
  const visibleCustomers=hasSales?"SELECT DISTINCT b.k,b.client FROM customer0 b JOIN sales_client_keys s ON s.k=b.k AND s.client IS b.client"+(normalized.every(c=>c.hasSales)?"":" UNION SELECT DISTINCT b.k,b.client FROM customer0 b JOIN ctx c ON c.k=b.k WHERE c.has_sales=0"):"SELECT DISTINCT b.k,b.client FROM customer0 b";
  const returnsCustomer=hasCustomerPath?" AND("+(normalized.every(c=>c.hasRepresentative||c.hasSales)?"":"(c.has_representative=0 AND c.has_sales=0) OR ")+"EXISTS(SELECT 1 FROM visible_customers b WHERE b.k=c.k AND b.client IS r.client))":"";
  const sql=`WITH
ctx AS MATERIALIZED (SELECT CAST(json_extract(value,'$.key') AS INTEGER) AS k,json_extract(value,'$.name') AS name,json_extract(value,'$.from') AS start,json_extract(value,'$.to') AS finish,json_extract(value,'$.region') AS representative,json_extract(value,'$.client') AS client,json_extract(value,'$.product') AS product,json_extract(value,'$.category') AS category,json_extract(value,'$.state') AS state,json_extract(value,'$.regional') AS regional,json_extract(value,'$.manager') AS manager,json_extract(value,'$.allowedRegions') AS allowed_reps,json_extract(value,'$.allowedClients') AS allowed_clients,json_extract(value,'$.hasRepresentative') AS has_representative,json_extract(value,'$.hasSales') AS has_sales FROM json_each(?)),
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
sales0 AS (SELECT c.k,s.* FROM ctx c JOIN sales s ON s.date>=c.start AND s.date<=c.finish${salesCuts.length?" AND "+salesCuts.join(" AND "):""} WHERE EXISTS(SELECT 1 FROM calendar d WHERE d.date=s.date)${geoClause("s")}),
visible_sales AS (SELECT ${includeDimensions?"s.*":"s.k,s.client,s.amount"} FROM sales0 s${visibleSales}),
sales_client_keys AS MATERIALIZED (${salesKeys}),
visible_customers AS MATERIALIZED (${visibleCustomers}),
visible_returns AS (SELECT c.k,r.row_no,r.client,r.state,r.amount FROM ctx c JOIN returned r ON r.date>=c.start AND r.date<=c.finish WHERE EXISTS(SELECT 1 FROM calendar d WHERE d.date=r.date)${geoClause("r")}${returnsCustomer}),
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
function context(u:DbUser,p:Plan,offset:number):NativeContext {return {...p.filters,...dates(p.filters,offset),...scope(u,p)};}
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
export async function queryNative(e:Env,u:DbUser,p:Plan,m:ManualManifest,version:string):Promise<Report> {
  if(!nativeCapabilities(m).groups.includes(p.group)||!nativeCapabilities(m).metrics.includes(p.metric))fail(422,"Indicador ou agrupamento indisponível nesta versão.");
  if(p.filters.manager&&!native(m).regions.manager)fail(422,"Gerente não está mapeado nesta versão.");
  const current=context(u,p,0),previous=context(u,p,-1);
  const total=await nativeValues(e,version,[current,previous]);let rows:Row[]=[];
  if(p.group==="month") {
    const contexts:NativeContext[]=[];const count=monthsBetween(p.filters.from,p.filters.to);
    for(let i=0;i<=count;i++) {
      const date=new Date(Date.UTC(Number(p.filters.from.slice(0,4)),Number(p.filters.from.slice(5))-1+i,1));
      for(const offset of [0,-1]) {const from=new Date(Date.UTC(date.getUTCFullYear()+offset,date.getUTCMonth(),1)).toISOString().slice(0,10),to=new Date(Date.UTC(date.getUTCFullYear()+offset,date.getUTCMonth()+1,0)).toISOString().slice(0,10);contexts.push({...current,from,to,name:date.toISOString().slice(0,7)});}
    }
    const results=await nativeValues(e,version,contexts);for(let i=0;i<results.length;i+=2)rows.push(pair(results[i].name,results[i],results[i+1],m));
  } else {
    const q=compileNativeGroups(version,[current,previous],p.group,false,{metric:p.metric as Exclude<Metric,"margin">,order:p.order}),results=(await stmt(e,q.sql,...q.args).all<NativeResult&{g:string|null}>()).results;
    const keys=new Set(results.map(r=>r.g));
    const byContext=[new Map(results.filter(r=>r.k===0).map(r=>[r.g,r])),new Map(results.filter(r=>r.k===1).map(r=>[r.g,r]))];
    for(const key of keys){const a=byContext[0].get(key),b=byContext[1].get(key);rows.push({...pair(a?.name??b?.name??"(Em branco)",a,b,m),...(key===null?{canDrill:false}:{})});}
    const score=(r:Row)=>p.order==="current"?(r.values[p.metric].current??-Infinity):(r.values[p.metric].current??0)-(r.values[p.metric].previous??0);
    rows.sort((a,b)=>(p.order==="decline"?1:-1)*(score(a)-score(b))||a.name.localeCompare(b.name,"pt-BR"));
  }
  return {total:pair("Total",total[0],total[1],m),rows:rows.slice(0,30),plan:p,asOf:new Date().toISOString(),truncated:rows.length>30,source:"Arquivo manual (D1)"};
}
export async function nativeOptions(e:Env,u:DbUser,filters:Filters,m:ManualManifest,version:string) {
  if(filters.manager&&!native(m).regions.manager)fail(422,"Gerente não está mapeado nesta versão.");
  const p:Plan={metric:"revenue",group:"month",order:"current",filters};scope(u,p);
  const base=context(u,p,0),values:Record<string,string[]>={},truncated:Record<string,boolean>={};
  const groups=["region","client","product","state","regional",...(native(m).regions.manager?["manager" as const]:[])] as const;
  const q=compileNativeOptions(version,base,groups),results=(await stmt(e,q.sql,...q.args).all<{dimension:string;name:string}>()).results;
  for(const group of groups) {
    const visible=results.filter(r=>r.dimension===group).map(r=>r.name);
    values[group]=visible.slice(0,250);truncated[group]=visible.length>250;
  }
  return {values,sourceVersion:version,truncated};
}
export function compileNativeOptions(version:string,context:NativeContext,groups:readonly Exclude<Group,"month">[]):Sql{
  const base=compileNativeContexts(version,[context],true),prefix=base.sql.slice(0,base.sql.lastIndexOf("\nSELECT c.k,c.name,")),tails:string[]=[],selects:string[]=[];
  for(const [index,group]of groups.entries()){
    const compiled=compileNativeGroups(version,[context],group,true),split=compiled.sql.lastIndexOf(" SELECT MIN(name) AS name FROM "),rename=(sql:string)=>sql.replace(/\bg_/g,"o"+index+"_");
    tails.push(rename(compiled.sql.slice(prefix.length,split)));selects.push("SELECT '"+group+"' AS dimension,name FROM ("+rename(compiled.sql.slice(split+1))+")");
  }
  return {sql:(prefix+tails.join("")+" "+selects.join(" UNION ALL ")).replace("visible_sales AS (","visible_sales AS NOT MATERIALIZED ("),args:base.args};
}
export const nativeStorageTables=Object.values(nativeTables);
export async function validateNativeStorage(e:Env,m:ManualManifest,version:string){
  const roles=Object.keys(nativeTables) as NativeRole[],query=roles.map(role=>"SELECT '"+role+"' AS role,COUNT(*) AS n FROM "+nativeTables[role]+" WHERE version_id=?").join(" UNION ALL ");
  const rows=(await stmt(e,query,...roles.map(()=>version)).all<{role:NativeRole;n:number}>()).results;
  for(const row of rows)if(row.n!==table(m,native(m)[row.role].table).rowCount)throw Error("Contagem normalizada divergente: "+row.role);
  for(const [storage,column]of [["ci_native_regions","state"],["ci_native_calendar","date"]]){
    const duplicate=await stmt(e,"SELECT COUNT(*) AS n FROM "+storage+" WHERE version_id=? GROUP BY "+column+" HAVING COUNT(*)>1 LIMIT 1",version).first<{n:number}>();
    if(duplicate)throw Error("Chave do lado um duplicada após normalização da collation: "+storage);
  }
}
