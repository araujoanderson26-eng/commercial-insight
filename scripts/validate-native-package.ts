/** Local-only oracle. Real packages and all generated artifacts stay under .wrangler. */
import {createReadStream,statSync,readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {createInterface} from "node:readline";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {resolve,relative,isAbsolute,dirname} from "node:path";
import {performance} from "node:perf_hooks";
import {manifestSchema,decimalInteger,type ManualManifest} from "../shared/manual";
import type {Env} from "../worker/core";
import {compileNativeGroups,compileNativeOptions,nativeControlResult,nativeValues,nativePartStatements,validateNativeStorage,type NativeContext,type NativeResult} from "../worker/native-model";
import {validateManualManifest} from "../worker/manual";

const root=resolve(".wrangler"),input=resolve(process.argv[2]??".wrangler/native/Panizzon.ci.ndjson");
const dbPath=resolve(process.argv[3]??".wrangler/native-validation-"+Date.now()+".sqlite"),reportPath=resolve(process.argv[4]??".wrangler/native-validation-report.json");
for(const path of [dbPath,reportPath]){const rel=relative(root,path);if(rel.startsWith("..")||isAbsolute(rel))throw Error("Os artefatos locais devem ficar dentro de .wrangler.");}
if(existsSync(dbPath))throw Error("O banco de validação já existe. Escolha outro caminho para preservar a evidência anterior.");
mkdirSync(dirname(dbPath),{recursive:true});mkdirSync(dirname(reportPath),{recursive:true});
const sql=new DatabaseSync(dbPath);sql.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536; PRAGMA foreign_keys=ON");
sql.exec("CREATE TABLE ci_imports(id TEXT PRIMARY KEY); INSERT INTO ci_imports VALUES('local-native'); CREATE TABLE ci_raw_rows(version_id TEXT NOT NULL REFERENCES ci_imports(id),table_id TEXT NOT NULL,row_no INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(version_id,table_id,row_no));");
sql.exec(readFileSync(new URL("../migrations/0005_native_model.sql",import.meta.url),"utf8"));
const prepared=new Map<string,ReturnType<DatabaseSync["prepare"]>>();
const prepare=(text:string)=>{let value=prepared.get(text);if(!value){value=sql.prepare(text);prepared.set(text,value);}return value;};
class Statement {
  constructor(readonly text:string,readonly args:(string|number|null)[]=[]){}
  bind(...args:(string|number|null)[]){return new Statement(this.text,args);}
  async first(){return prepare(this.text).get(...this.args)??null;}
  async all(){return {results:prepare(this.text).all(...this.args)};}
  async run(){return {meta:prepare(this.text).run(...this.args)};}
}
const env={MANUAL_ALLOW_SYNTHETIC:"true",MANUAL_MAX_BYTES:String(512*1024**2),DB:{prepare:(text:string)=>new Statement(text),async batch(statements:Statement[]){sql.exec("BEGIN");try{const results=[];for(const s of statements)results.push(await s.run());sql.exec("COMMIT");return results;}catch(error){sql.exec("ROLLBACK");throw error;}}}} as unknown as Env;
const started=performance.now(),packageHash=createHash("sha256");
const report:{stage?:string;formatVersion?:number;packageBytes:number;sha256?:string;rows:number;parts:number;tables?:number;ingestMs?:number;sqliteBytes?:number;conservativeD1Bytes?:number;minimumCronMinutes?:number;controls:{metric:string;context:string;passed:boolean;ms:number;overBudget:boolean}[];groups:{group:string;groups:number;ms:number;overBudget:boolean;contexts:number}[];options?:{ms:number;overBudget:boolean};ok?:boolean;error?:{stage:string;name:string};totalMs?:number}={packageBytes:statSync(input).size,rows:0,parts:0,controls:[],groups:[]};
const progress=(stage:string,detail:Record<string,string|number|boolean>={})=>{report.stage=stage;report.totalMs=Math.round(performance.now()-started);writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");process.stdout.write(JSON.stringify({event:stage,...detail})+"\n");};
let stage="manifest",manifest:ManualManifest|undefined;
try {
  const stream=createReadStream(input);stream.on("data",chunk=>packageHash.update(chunk));
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  let lineNo=0;const counts=new Map<string,number>(),partCounts=new Map<string,number>();
  for await(const line of lines) {
    lineNo++;
    if(lineNo===1){manifest=manifestSchema.parse(JSON.parse(line.replace(/^\uFEFF/,"")));if(manifest.formatVersion!==2)throw Error("Requer pacote v2.");validateManualManifest(manifest,env);report.formatVersion=2;report.tables=manifest.inventory.tables.length;stage="ingestion";continue;}
    if(!manifest)throw Error("Manifesto ausente.");
    const part=JSON.parse(line) as {kind:string;table:string;part:number;rows:{row:number;values:(string|boolean|null)[]}[]};
    const table=manifest.inventory.tables.find(t=>t.id===part.table),meta=table?.parts.find(p=>p.index===part.part),data=Buffer.from(line+"\n");
    if(part.kind!=="rows"||!table||!meta||!Array.isArray(part.rows)||part.rows.length!==meta.rows||data.length!==meta.bytes||createHash("sha256").update(data).digest("hex")!==meta.sha256)throw Error("Parte incompleta ou checksum divergente.");
    const before=counts.get(table.id)??0;if(part.part!==(partCounts.get(table.id)??0)+1||part.rows.some((r,i)=>r.row!==before+i+1||r.values.length!==table.columns.length))throw Error("Sequência ou largura da linha divergente.");
    const statements=part.rows.map(r=>new Statement("INSERT INTO ci_raw_rows VALUES(?,?,?,?)",["local-native",table.id,r.row,JSON.stringify(r.values)]));
    await env.DB.batch([...statements as unknown as D1PreparedStatement[],...nativePartStatements(env,manifest,"local-native",table.id,part.rows)]);
    counts.set(table.id,before+part.rows.length);partCounts.set(table.id,part.part);report.rows+=part.rows.length;report.parts++;
    if(report.parts%100===0)progress("ingestion",{parts:report.parts,rows:report.rows});
  }
  if(!manifest)throw Error("Pacote vazio.");
  for(const table of manifest.inventory.tables)if((counts.get(table.id)??0)!==table.rowCount||table.sourceRowCount!==table.rowCount||(partCounts.get(table.id)??0)!==table.parts.length)throw Error("Contagem de tabela divergente.");
  await validateNativeStorage(env,manifest,"local-native");
  report.ingestMs=Math.round(performance.now()-started);report.sha256=packageHash.digest("hex");report.minimumCronMinutes=Math.ceil(report.parts/10);
  const pageCount=Number(sql.prepare("PRAGMA page_count").get()!.page_count),pageSize=Number(sql.prepare("PRAGMA page_size").get()!.page_size);
  report.sqliteBytes=pageCount*pageSize;report.conservativeD1Bytes=report.sqliteBytes*2;
  progress("ingestion-complete",{parts:report.parts,rows:report.rows,ms:report.ingestMs});
  stage="controls";
  const controlCache=new Map<string,NativeResult>();
  for(const control of manifest.controls) {
    const began=performance.now(),metric=manifest.metrics.find(m=>m.id===control.metric);if(!metric||metric.status!=="validated")continue;
    const key=JSON.stringify(Object.entries(control.filters).sort(([a],[b])=>a.localeCompare(b)));let result=controlCache.get(key);
    if(!result){progress("control-start",{index:report.controls.length,metric:control.metric,context:control.context});result=(await nativeValues(env,"local-native",[control.filters]))[0];controlCache.set(key,result);}
    const observed=nativeControlResult(manifest,result,control.metric);
    let passed:boolean;
    if(observed.value===null||control.expected===null)passed=observed.value===null&&control.expected===null;
    else if(control.metric==="buyers")passed=observed.value===Number(control.expected);
    else{const difference=BigInt(observed.raw!)-BigInt(decimalInteger(control.expected,metric.scale));passed=(difference<0n?-difference:difference)<=BigInt(decimalInteger(control.tolerance,metric.scale));}
    const ms=Math.round(performance.now()-began);report.controls.push({metric:control.metric,context:control.context,passed,ms,overBudget:ms>30000});
    progress("control-complete",{index:report.controls.length,metric:control.metric,context:control.context,passed,ms,overBudget:ms>30000});
  }
  stage="groups";
  const last=new Date(manifest.projection.to+"T00:00:00Z"),from=new Date(Date.UTC(last.getUTCFullYear()-1,last.getUTCMonth()+1,1)).toISOString().slice(0,10),to=new Date(Date.UTC(last.getUTCFullYear(),last.getUTCMonth()+1,0)).toISOString().slice(0,10);
  const context:NativeContext={from,to},previous:NativeContext={from:(Number(from.slice(0,4))-1)+from.slice(4),to:(Number(to.slice(0,4))-1)+to.slice(4)};
  for(const group of ["client","region","product","category","state","regional",...(manifest.nativeModel!.regions.manager?["manager" as const]:[])] as const) {
    progress("group-start",{group});
    const began=performance.now(),compiled=compileNativeGroups("local-native",[context,previous],group,false,{metric:"revenue",order:"current"}),rows=sql.prepare(compiled.sql).all(...compiled.args);
    const ms=Math.round(performance.now()-began);report.groups.push({group,groups:rows.length,ms,overBudget:ms>30000,contexts:2});progress("group-complete",{group,groups:rows.length,ms,overBudget:ms>30000});
  }
  progress("options-start");const optionsBegan=performance.now(),options=compileNativeOptions("local-native",context,["region","client","product","state","regional",...(manifest.nativeModel!.regions.manager?["manager" as const]:[])]);sql.prepare(options.sql).all(...options.args);
  const optionsMs=Math.round(performance.now()-optionsBegan);report.options={ms:optionsMs,overBudget:optionsMs>30000};progress("options-complete",{ms:optionsMs,overBudget:optionsMs>30000});
  report.ok=report.controls.length>0&&report.controls.every(c=>c.passed);
}catch(error){report.ok=false;report.error={stage,name:error instanceof Error?error.name:"Error"};process.exitCode=1;}
finally{report.totalMs=Math.round(performance.now()-started);writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");sql.close();}
if(!report.ok)process.exitCode=1;
process.stdout.write(JSON.stringify({ok:report.ok,controls:report.controls.length,failedControls:report.controls.filter(c=>!c.passed).length,parts:report.parts,totalMs:report.totalMs,report:relative(resolve(),reportPath)})+"\n");
