/** Build a local, privacy-reduced REAL snapshot for isolated homologation.
 * No HTTP, credentials, user writes or production mutations. Sources open read-only.
 * All financial evidence and identities remain under ignored .wrangler storage.
 * Required options: --source-package --source-db --source-version --source-proof
 * --output-dir --from --to --portfolio-state --portfolio-representative-query.
 */
import {createReadStream,createWriteStream,existsSync,mkdirSync,readFileSync,writeFileSync,statSync} from "node:fs";
import {createInterface} from "node:readline";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {isAbsolute,relative,resolve,join} from "node:path";
import {manifestSchema,type ManualManifest,type ControlFilters} from "../shared/manual";
import type {Plan,Report} from "../shared/domain";
import type {Env,DbUser} from "../worker/core";
import {nativeIdentityLabels,nativeKey,nativePartStatements,nativeValues,nativeControlResult,queryNative,nativeCustomerDetails,validateNativeStorage} from "../worker/native-model";
import {validateManualManifest} from "../worker/manual";
import {hmlManifestHash} from "../worker/real-hml-policy";
import {RawCommercialReference,verifyRawScenarios,type RawReferenceFilters} from "./raw-commercial-reference";

type Cell=string|boolean|null;
type Role="sales"|"returns"|"customers"|"calendar"|"regions"|"municipalities"|"latitudes"|"repArea";
type Oracle={gross:number|null;returns:number;revenue:number;buyers:number|null};
const required=["source-package","source-db","source-version","source-proof","output-dir","from","to","portfolio-state","portfolio-representative-query"];
const optional=["source-expected-sha256"];
const argv=process.argv.slice(2),options:Record<string,string>={};
for(let index=0;index<argv.length;index+=2){const flag=argv[index];if(!flag?.startsWith("--")||!argv[index+1])throw Error("Invalid command options.");options[flag.slice(2)]=argv[index+1];}
for(const key of required)if(!options[key])throw Error("Missing required option: --"+key);
if(Object.keys(options).some(key=>!required.includes(key)&&!optional.includes(key)))throw Error("Unknown command option.");
const sourcePackage=resolve(options["source-package"]),sourceDb=resolve(options["source-db"]),sourceVersion=options["source-version"],output=resolve(options["output-dir"]);
const privateRoot=resolve(".wrangler"),outputRelative=relative(privateRoot,output);
if(!outputRelative||outputRelative.startsWith("..")||isAbsolute(outputRelative))throw Error("Output must remain inside .wrangler.");
if(existsSync(output))throw Error("Output directory already exists; choose a new path to preserve earlier evidence.");
const from=options.from,to=options.to;
if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw Error("Invalid continuous coverage.");
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
async function fileHash(path:string){const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest("hex");}
async function firstLine(path:string){const stream=createReadStream(path),lines=createInterface({input:stream,crlfDelay:Infinity});for await(const line of lines){lines.close();stream.destroy();return line.replace(/^\uFEFF/,"");}throw Error("Empty source package.");}
const header=await firstLine(sourcePackage),original=manifestSchema.parse(JSON.parse(header));
if(original.synthetic||original.formatVersion!==2||!original.nativeModel)throw Error("A validated real native v2 source is required.");
if(from<original.projection.from||to>original.projection.to)throw Error("Selected coverage exceeds the validated source.");
const priorProof=JSON.parse(readFileSync(resolve(options["source-proof"]),"utf8")) as {manifestSha256:string;tableCountsPassed:boolean;completed:boolean;controls:{passed:boolean}[]};
if(priorProof.manifestSha256!==sha(header)||!priorProof.tableCountsPassed||!priorProof.completed||!priorProof.controls.length||priorProof.controls.some(c=>!c.passed))throw Error("Source reconciliation evidence is missing or inconsistent.");
const sourceHashes={package:await fileHash(sourcePackage),database:await fileHash(sourceDb),manifest:sha(header)};
if(options["source-expected-sha256"]&&sourceHashes.package!==options["source-expected-sha256"])throw Error("The local package differs from the authorized production package fingerprint.");
const originalDatabase=new DatabaseSync(sourceDb,{readOnly:true});
if(!originalDatabase.prepare("SELECT 1 FROM ci_imports WHERE id=?").get(sourceVersion))throw Error("The source version does not exist.");
const model=original.nativeModel,scale=model.scale,unit=10n**BigInt(scale);
/** Independent text-decimal parser used only by the raw-source oracle. */
function money(value:unknown):number|null{
  if(value===null)return null;if(typeof value!=="string"||!/^[-]?(0|[1-9]\d*)(\.\d+)?$/.test(value))throw Error("Invalid source decimal.");
  const negative=value.startsWith("-"),[whole,fraction=""]=(negative?value.slice(1):value).split(".");
  if(fraction.length>scale&&/[1-9]/.test(fraction.slice(scale)))throw Error("Source decimal exceeds the declared scale.");
  const exact=BigInt(whole)*unit+BigInt(fraction.slice(0,scale).padEnd(scale,"0")||"0");
  if(exact>BigInt(Number.MAX_SAFE_INTEGER))throw Error("Unsafe source decimal.");return Number(negative?-exact:exact);
}
const decimal=(value:number)=>{if(!Number.isSafeInteger(value))throw Error("Unsafe monetary result.");const absolute=BigInt(value<0?-value:value);return (value<0?"-":"")+(absolute/unit).toString()+(scale?"."+(absolute%unit).toString().padStart(scale,"0"):"");};
const table=(id:string)=>original.inventory.tables.find(item=>item.id===id)??(()=>{throw Error("Missing source table.");})();
const columnIndex=(id:string,name:string)=>{const index=table(id).columns.findIndex(c=>c.name===name);if(index<0)throw Error("Missing source column.");return index;};
const jsonPath=(id:string,name:string)=>"$["+columnIndex(id,name)+"]";
const rawReference=new RawCommercialReference(originalDatabase,original,sourceVersion,{from,to});
const rawOracle=(filters:RawReferenceFilters):Oracle=>rawReference.query(filters);

const search=options["portfolio-representative-query"].replace(/[\\%_]/g,"\\$&");
const representatives=originalDatabase.prepare("SELECT representative,MIN(json_extract(display,'$.representative')) AS name FROM ci_native_customers WHERE version_id=? AND representative LIKE ? ESCAPE '\\' GROUP BY representative").all(sourceVersion,"%"+search.toLocaleUpperCase("pt-BR")+"%");
if(representatives.length!==1)throw Error("The representative query is missing or ambiguous; no portfolio was selected.");
const representative=String(representatives[0].name),state=options["portfolio-state"].toLocaleUpperCase("pt-BR");
if(!/^[A-Z]{2}$/.test(state))throw Error("A single official state code is required.");
const portfolioRows=originalDatabase.prepare("SELECT s.client,MIN(json_extract(s.display,'$.client')) AS code FROM ci_native_sales s WHERE s.version_id=? AND s.state=? AND s.date>=? AND s.date<=? AND s.client IS NOT NULL AND EXISTS(SELECT 1 FROM ci_native_customers b WHERE b.version_id=s.version_id AND b.client IS s.client AND b.representative=?) GROUP BY s.client ORDER BY s.client").all(sourceVersion,nativeKey(state),from,to,nativeKey(representative));
const portfolioClients=portfolioRows.map(row=>String(row.code));
if(!portfolioClients.length||portfolioClients.length>250)throw Error("The authorized portfolio is empty or exceeds the existing user scope capacity.");

mkdirSync(output,{recursive:true});
const bodyPath=join(output,"parts.ndjson"),packagePath=join(output,"real-hml.ci.ndjson"),oraclePath=join(output,"derived.sqlite"),reportPath=join(output,"attestation.private.json");
const bodyOutput=createWriteStream(bodyPath,{flags:"wx"});
const derived=new DatabaseSync(oraclePath);
derived.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; CREATE TABLE ci_imports(id TEXT PRIMARY KEY); INSERT INTO ci_imports VALUES('hml-derived-real'); CREATE TABLE ci_raw_rows(version_id TEXT NOT NULL,table_id TEXT NOT NULL,row_no INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(version_id,table_id,row_no));");
derived.exec(readFileSync(new URL("../migrations/0005_native_model.sql",import.meta.url),"utf8"));
class Statement{
  constructor(readonly database:DatabaseSync,readonly sql:string,readonly args:(string|number|null)[]=[]){}
  bind(...args:(string|number|null)[]){return new Statement(this.database,this.sql,args);}
  async first(){return this.database.prepare(this.sql).get(...this.args)??null;}
  async all(){return {results:this.database.prepare(this.sql).all(...this.args)};}
  async run(){return {meta:this.database.prepare(this.sql).run(...this.args)};}
}
const env={MANUAL_MAX_BYTES:String(512*1024**2),DB:{prepare:(sql:string)=>new Statement(derived,sql),async batch(statements:Statement[]){derived.exec("BEGIN");try{const out=[];for(const statement of statements)out.push(await statement.run());derived.exec("COMMIT");return out;}catch(error){derived.exec("ROLLBACK");throw error;}}}} as unknown as Env;
const sourceEnv={DB:{prepare:(sql:string)=>new Statement(originalDatabase,sql)}} as unknown as Env;
const roles:Role[]=["sales","returns","customers","calendar","regions","municipalities","latitudes","repArea"];
const nativeIds=new Set(roles.map(role=>model[role].table));
const selectedColumns:Record<string,string[]>={};
for(const role of roles){const ref=model[role];selectedColumns[ref.table]=[...new Set(Object.entries(ref).filter(([key,value])=>key!=="table"&&typeof value==="string").map(([,value])=>String(value)))];}
const customerName=table(model.customers.table).columns.find(c=>["Cliente","Razão Social","Razao Social","Nome do cliente"].includes(c.name));
if(customerName)selectedColumns[model.customers.table].push(customerName.name);
const products=original.inventory.tables.find(t=>t.name==="Base Produtos");
if(!products||!products.columns.some(c=>c.name==="Codigo Item")||!products.columns.some(c=>c.name==="Descrição do item"))throw Error("The source has no supported product identity dimension.");
selectedColumns[products.id]=["Codigo Item","Descrição do item"];
const selectedIds=Object.keys(selectedColumns);
const four=["gross","returns","revenue","buyers"] as const;
const measures=original.inventory.measures.filter(item=>typeof item==="object"&&item!==null&&"name"in item&&four.some(metric=>model.recipes[metric].measure===item.name)).map(item=>{
  const m=item as {table?:unknown;name:string;expression:string};return {table:typeof m.table==="string"?m.table:"Medidas",name:m.name,expression:m.expression};
});
const tables:ManualManifest["inventory"]["tables"]=selectedIds.map(id=>{const originalTable=table(id);return {id,name:originalTable.name,columns:selectedColumns[id].map(name=>({name,type:originalTable.columns.find(c=>c.name===name)!.type})),rowCount:0,sourceRowCount:0,allowEmpty:false,storageMode:"Import",partitions:[],parts:[],derivation:{sourceTableRowCount:originalTable.rowCount,selectedCoverage:{from,to},sourceRowOrderPreserved:true,factsAggregated:false,columnsRemoved:originalTable.columns.filter(c=>!selectedColumns[id].includes(c.name)).map(c=>c.name)}};});
const manifest:ManualManifest={kind:"manifest",format:original.format,formatVersion:2,sourceId:original.sourceId,model:{name:"HML REAL — RECORTE LOCAL SEM AGREGAÇÃO",id:"hml-real-"+sourceHashes.package.slice(0,24)},extractedAt:original.extractedAt,sourceUpdatedAt:original.sourceUpdatedAt,referenceDate:original.referenceDate,synthetic:false,stableExtraction:true,
  inventory:{tables,measures,relationships:original.inventory.relationships.filter(item=>typeof item==="object"&&item!==null&&"fromTable"in item&&"toTable"in item&&"isActive"in item&&item.isActive===true&&nativeIds.has(String(item.fromTable))&&nativeIds.has(String(item.toTable))),dependencies:[],excluded:[{type:"local-hml-derivation",sourceHashes,sourceTables:original.inventory.tables.length,sourceRows:original.inventory.tables.reduce((sum,t)=>sum+t.rowCount,0),coverage:{from,to},description:"Real immutable source filtered locally by a continuous date interval. No fact aggregation, monetary rounding, top-N truncation or source mutation. sourceRowCount describes this derivative selection, not the complete Power BI project."},...original.inventory.tables.filter(t=>!selectedIds.includes(t.id)).map(t=>({type:"table-omitted-from-hml",table:t.id,reason:"Outside the supported native commercial contract; excluded to minimize private data."}))]},
  projection:{rowCount:1,from,to,grain:"Local real derivative: original line-level sales and returns within continuous coverage; repeated facts, BLANK keys and complete commercial dimension memberships are preserved. This is not a full project export.",dimensions:original.projection.dimensions,parts:[]},nativeModel:structuredClone(model),metrics:structuredClone(original.metrics.filter(metric=>four.includes(metric.id as typeof four[number])||metric.id==="margin")),controls:[]};
const derivationCounts:{id:string;sourceRows:number;selectedRows:number;parts:number;rowMappingSha256:string}[]=[];
for(const selected of tables){
  const originalTable=table(selected.id),indices=selectedColumns[selected.id].map(name=>columnIndex(selected.id,name));
  const factRole=selected.id===model.sales.table?"sales":selected.id===model.returns.table?"returns":null;
  const where=factRole?" AND substr(CAST(json_extract(value,?) AS TEXT),1,10)>=? AND substr(CAST(json_extract(value,?) AS TEXT),1,10)<=?":"";
  const datePath=factRole?jsonPath(selected.id,model[factRole].date):"";
  const args:(string|number|null)[]=[sourceVersion,selected.id,...(factRole?[datePath,from,datePath,to]:[])];
  const inputRows=originalDatabase.prepare("SELECT row_no,value FROM ci_raw_rows WHERE version_id=? AND table_id=?"+where+" ORDER BY row_no").iterate(...args);
  const mapping=createHash("sha256");let count=0,part=0,buffer:{row:number;values:Cell[]}[]=[],estimated=0;
  async function flush(){if(!buffer.length)return;part++;const text=JSON.stringify({kind:"rows",table:selected.id,part,rows:buffer})+"\n",data=Buffer.from(text);if(data.length>1024*1024)throw Error("A minimized part exceeds the supported bound.");selected.parts.push({index:part,rows:buffer.length,bytes:data.length,sha256:sha(data)});if(!bodyOutput.write(data))await once(bodyOutput,"drain");
    await env.DB.batch([...buffer.map(row=>new Statement(derived,"INSERT INTO ci_raw_rows VALUES(?,?,?,?)",["hml-derived-real",selected.id,row.row,JSON.stringify(row.values)])) as unknown as D1PreparedStatement[],...nativePartStatements(env,manifest,"hml-derived-real",selected.id,buffer)]);buffer=[];estimated=0;}
  for(const raw of inputRows){const originalValues=JSON.parse(String(raw.value)) as Cell[],values=indices.map(index=>originalValues[index]);const row={row:count+1,values},bytes=Buffer.byteLength(JSON.stringify(row));if(buffer.length>=1000||estimated+bytes>900000)await flush();count++;buffer.push(row);estimated+=bytes;mapping.update(JSON.stringify({sourceRow:raw.row_no,selectedRow:count,values}));}
  await flush();selected.rowCount=count;selected.sourceRowCount=count;selected.allowEmpty=count===0;derivationCounts.push({id:selected.id,sourceRows:originalTable.rowCount,selectedRows:count,parts:part,rowMappingSha256:mapping.digest("hex")});
  process.stdout.write(JSON.stringify({stage:"local-derivation",tablesCompleted:derivationCounts.length,selectedRows:count})+"\n");
}
bodyOutput.end();await once(bodyOutput,"finish");
manifest.projection.rowCount=tables.filter(t=>t.id===model.sales.table||t.id===model.returns.table).reduce((sum,t)=>sum+t.rowCount,0);
const official=original.controls.filter(c=>c.context==="month"&&c.filters.from>=from&&c.filters.to<=to&&Object.keys(c.filters).every(key=>key==="from"||key==="to"));
manifest.controls=structuredClone(official);
const daxTable=(name:string)=>"'"+name.replaceAll("'","''")+"'";
const daxColumn=(id:string,name:string)=>daxTable(table(id).name)+"["+name.replaceAll("]","]]")+"]";
const daxDate=(date:string)=>"DATE("+date.split("-").map(Number).join(",")+")";
function controlDax(metric:typeof four[number],filters:ControlFilters){const mapped:Record<string,{table:string;column:string}>={region:{table:model.customers.table,column:model.customers.representative},client:{table:model.sales.table,column:model.sales.client},product:{table:model.sales.table,column:model.sales.product},category:{table:model.sales.table,column:model.sales.category},state:{table:model.sales.table,column:model.sales.state},regional:{table:model.regions.table,column:model.regions.regional},...(model.regions.manager?{manager:{table:model.regions.table,column:model.regions.manager}}:{})};
  const cuts=Object.entries(mapped).filter(([field])=>filters[field as keyof ControlFilters]).map(([field,column])=>"KEEPFILTERS(TREATAS({\""+String(filters[field as keyof ControlFilters]).replaceAll('"','""')+"\"},"+daxColumn(column.table,column.column)+"))");
  return "EVALUATE ROW(\"value\",CALCULATE(["+model.recipes[metric].measure.replaceAll("]","]]")+"],DATESBETWEEN("+daxColumn(model.calendar.table,model.calendar.date)+","+daxDate(filters.from)+","+daxDate(filters.to)+")"+(cuts.length?","+cuts.join(","):"")+")) /* DERIVED LOCAL RAW-SOURCE ORACLE; NOT A NEW POWER BI EXECUTION */";
}
const derivedIndices:number[]=[];
function addDerivedControl(context:ManualManifest["controls"][number]["context"],filters:ControlFilters){const expected=rawOracle(filters);for(const metric of four){derivedIndices.push(manifest.controls.length);const value=expected[metric];manifest.controls.push({metric,context,filters:{...filters},expected:value===null?null:metric==="buyers"?String(value):decimal(value),dax:controlDax(metric,filters),referenceDate:manifest.referenceDate,tolerance:"0"});}}
addDerivedControl("total",{from,to});
for(const context of ["region","client","product","state","category","regional",...(model.regions.manager?["manager" as const]:[])] as const){const sourceControl=original.controls.find(c=>c.context===context&&c.filters[context]);if(!sourceControl)throw Error("A source filter control is missing.");addDerivedControl(context,{...sourceControl.filters,from,to});}
validateManualManifest(manifest,env);await validateNativeStorage(env,manifest,"hml-derived-real");
const checks:{index:number;origin:"power-bi-original"|"raw-source-derived";metric:string;context:string;sourcePassed:boolean;derivativePassed:boolean}[]=[];
const expectedCache=new Map<string,Awaited<ReturnType<typeof nativeValues>>[number]>();
for(const [index,control]of manifest.controls.entries()){
  const source=rawOracle(control.filters),sourceValue=source[control.metric as keyof Oracle],expected=control.expected===null?null:control.metric==="buyers"?Number(control.expected):money(control.expected);
  const key=JSON.stringify(control.filters);let row=expectedCache.get(key);if(!row){row=(await nativeValues(env,"hml-derived-real",[control.filters]))[0];expectedCache.set(key,row);}
  const observed=nativeControlResult(manifest,row,control.metric).raw,tolerance=money(control.tolerance)??0;
  const matches=(value:number|null)=>value===null||expected===null?value===expected:Math.abs(value-expected)<=tolerance;
  checks.push({index,origin:index<official.length?"power-bi-original":"raw-source-derived",metric:control.metric,context:control.context,sourcePassed:matches(sourceValue),derivativePassed:matches(observed)});
  if(checks.length%40===0)process.stdout.write(JSON.stringify({stage:"oracle-checks",completed:checks.length})+"\n");
}
if(checks.some(check=>!check.sourcePassed||!check.derivativePassed))throw Error("The derivative failed reconciliation; private partial evidence was preserved.");
const filters={from:to.slice(0,4)+"-01",to:to.slice(0,7),region:representative,client:"",product:"",state};
const previousYear=String(Number(to.slice(0,4))-1);
const periods=[{from:filters.from+"-01",to},{from:previousYear+"-01-01",to:previousYear+to.slice(4)}];
const portfolioContext={region:representative,state,allowedRegions:[representative]};
const candidates=[];
for(const client of portfolioClients){const values=periods.map(period=>rawOracle({...period,...portfolioContext,client}));if(values[1].revenue>0&&values[0].revenue<values[1].revenue&&(values[0].gross??0)>0)candidates.push({client,current:values[0],previous:values[1],difference:values[0].revenue-values[1].revenue});}
candidates.sort((a,b)=>a.difference-b.difference||a.client.localeCompare(b.client));
if(!candidates.length)throw Error("No declining active customer with a positive prior-year base exists in the requested portfolio.");
const chosen=candidates[0],identities=await nativeIdentityLabels(sourceEnv,original,sourceVersion,"client",[chosen.client]);
if(!identities[chosen.client]?.description||identities[chosen.client].descriptionConflict)throw Error("The selected customer has no unique real identity.");
const scopedUser={id:"hml-validation-only",role:"gerente",regions:JSON.stringify([representative]),clients:"[]",national:0} as DbUser;
const plans:Record<string,Plan>={national:{group:"month",metric:"revenue",order:"current",filters:{...filters,region:"",state:""}},portfolioDeclines:{group:"client",metric:"revenue",order:"decline",filters},visit:{group:"month",metric:"revenue",order:"current",filters:{...filters,client:chosen.client}},followupProducts:{group:"product",metric:"revenue",order:"decline",filters:{...filters,client:chosen.client}}};
const nationalUser={...scopedUser,role:"admin",regions:"[]",clients:"[]",national:1} as DbUser;
const fullReports:Record<string,Report>={},sampleReports:Record<string,Report>={};
for(const [name,plan]of Object.entries(plans)){const user=name==="national"?nationalUser:scopedUser;fullReports[name]=await queryNative(sourceEnv,user,plan,original,sourceVersion);sampleReports[name]=await queryNative(env,user,plan,manifest,"hml-derived-real");
  const numerical=(value:unknown)=>{const report=value as Awaited<ReturnType<typeof queryNative>>;return {total:report.total,rows:report.rows,truncated:report.truncated,plan:report.plan};};
  if(JSON.stringify(numerical(fullReports[name]))!==JSON.stringify(numerical(sampleReports[name])))throw Error("A requested scenario differs from its complete reference.");
}
const rawIndependentScenarioChecks=verifyRawScenarios(rawReference,sampleReports,Object.fromEntries(Object.keys(plans).map(name=>[name,name==="national"?{}:{allowedRegions:[representative]}])));
if(!rawIndependentScenarioChecks.passed)throw Error("A report total or row differs from the independent raw-source SQL reference.");
const details=await nativeCustomerDetails(env,scopedUser,plans.visit.filters,manifest,"hml-derived-real");
const rawDailyActivity=rawReference.purchaseActivity({...plans.visit.filters,from:periods[0].from,to:periods[0].to,allowedRegions:[representative]});
if(details.lastPurchase!==rawDailyActivity.lastPurchase||details.purchaseDays!==rawDailyActivity.purchaseDays)throw Error("Daily customer activity differs from the independent raw source.");
const finalOutput=createWriteStream(packagePath,{flags:"wx"});
if(!finalOutput.write(JSON.stringify(manifest)+"\n"))await once(finalOutput,"drain");for await(const chunk of createReadStream(bodyPath))if(!finalOutput.write(chunk))await once(finalOutput,"drain");finalOutput.end();await once(finalOutput,"finish");
const finalSourceHashes={package:await fileHash(sourcePackage),database:await fileHash(sourceDb)};
if(finalSourceHashes.package!==sourceHashes.package||finalSourceHashes.database!==sourceHashes.database)throw Error("A source artifact changed during derivation.");
const packageSha256=await fileHash(packagePath),pageCount=Number(derived.prepare("PRAGMA page_count").get()!.page_count),pageSize=Number(derived.prepare("PRAGMA page_size").get()!.page_size),sqliteBytes=pageCount*pageSize;
const attestation={generatedAt:new Date().toISOString(),source:{paths:{package:sourcePackage,database:sourceDb},readOnly:true,hashes:sourceHashes,productionPackageHashMatched:options["source-expected-sha256"]?true:null,hashesUnchanged:true,reconciliation:{controls:priorProof.controls.length,passed:priorProof.controls.filter(c=>c.passed).length},fullTables:original.inventory.tables.length,fullRows:original.inventory.tables.reduce((sum,t)=>sum+t.rowCount,0)},derivation:{continuousCoverage:{from,to},factsAggregated:false,topNTruncated:false,factDuplicatesPreserved:true,allowlistedColumnsOnly:true,counts:derivationCounts,originalPowerBiControlCount:official.length,derivedControlCount:derivedIndices.length,derivedControlIndices:derivedIndices},package:{path:packagePath,sha256:packageSha256,manifestSha256:hmlManifestHash(manifest),bytes:statSync(packagePath).size,sqlitePath:oraclePath,sqliteBytes,estimatedD1Bytes:sqliteBytes*2},controls:checks,portfolio:{state,representative,observedClientCodes:portfolioClients,matchedRepresentatives:representatives.length,eligibleDecliningActiveClients:candidates.length,selectedCustomer:{code:chosen.client,name:identities[chosen.client].name,legalName:identities[chosen.client].description,reference:chosen},recommendedNewHmlScope:{role:"gerente",national:false,regions:[representative],clients:[]},existingUsersModified:false},scenarios:{plans,completeReference:fullReports,derivative:sampleReports,customerDetails:details},networkRequests:0,uploaded:false};
Object.assign(attestation,{rawIndependentScenarioChecks,rawReferenceCounts:rawReference.counts,rawDailyActivity});
writeFileSync(reportPath,JSON.stringify(attestation,null,2)+"\n");
writeFileSync(join(output,"manifest.private.json"),JSON.stringify(manifest,null,2)+"\n");
rawReference.close();originalDatabase.close();derived.close();
process.stdout.write(JSON.stringify({ok:true,readOnlySources:true,uploaded:false,networkRequests:0,sourceControls:priorProof.controls.length,originalPowerBiControls:official.length,derivedControls:derivedIndices.length,controlsPassed:checks.length,tables:tables.length,factRows:manifest.projection.rowCount,rows:tables.reduce((sum,t)=>sum+t.rowCount,0),packageBytes:statSync(packagePath).size,packageSha256,sqliteBytes,estimatedD1Bytes:sqliteBytes*2,portfolioClients:portfolioClients.length,eligibleDecliningActiveClients:candidates.length,report:relative(resolve(),reportPath)})+"\n");
