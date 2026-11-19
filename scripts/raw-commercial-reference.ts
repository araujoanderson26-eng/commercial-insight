/** Independent, local SQL reference built only from original ci_raw_rows.
 * It never uses native normalized amounts or the application's query compiler.
 * The temporary database lives in memory and contains only the required fields.
 */
import {DatabaseSync} from "node:sqlite";
import type {ControlFilters,ManualManifest} from "../shared/manual";
import type {Report} from "../shared/domain";
import {nativeKey} from "../worker/native-model";

export type RawReferenceFilters=ControlFilters&{
  allowedRegions?:string[];allowedClients?:string[];
  rowFilter?:{dimension:"client"|"product"|"category"|"state";key:string|null};
};
export type RawReferenceValues={gross:number|null;returns:number;revenue:number;buyers:number|null};
type RawRole="sales"|"returns"|"customers"|"calendar"|"regions";
export function sourceDecimal(value:unknown,scale:number):number|null{
  if(value===null)return null;
  if(typeof value!=="string"||!/^[-]?(0|[1-9]\d*)(\.\d+)?$/.test(value))throw Error("Invalid decimal in raw source.");
  const negative=value.startsWith("-"),[whole,fraction=""]=(negative?value.slice(1):value).split(".");
  if(fraction.length>scale&&/[1-9]/.test(fraction.slice(scale)))throw Error("Raw source precision exceeds the declared scale.");
  const integer=BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.slice(0,scale).padEnd(scale,"0")||"0");
  if(integer>BigInt(Number.MAX_SAFE_INTEGER))throw Error("Raw source exceeds safe integer precision.");
  return Number(negative?-integer:integer);
}
export class RawCommercialReference{
  readonly database=new DatabaseSync(":memory:");
  readonly counts:Record<string,number>={};
  readonly scale:number;
  readonly coverage:{from:string;to:string};
  private cache=new Map<string,RawReferenceValues>();
  constructor(source:DatabaseSync,manifest:ManualManifest,version:string,coverage:{from:string;to:string}){
    const model=manifest.nativeModel;if(!model)throw Error("Native metadata is required for the raw reference.");
    this.scale=model.scale;
    this.coverage={...coverage};
    const columns:Record<RawRole,Record<string,string|null>>={
      sales:{date:model.sales.date,client:model.sales.client,product:model.sales.product,category:model.sales.category,state:model.sales.state,amount:model.sales.amount},
      returns:{date:model.returns.date,client:model.returns.client,state:model.returns.state,amount:model.returns.amount},
      customers:{client:model.customers.client,representative:model.customers.representative,state:model.customers.state},
      calendar:{date:model.calendar.date},regions:{state:model.regions.state,regional:model.regions.regional,manager:model.regions.manager??null},
    };
    for(const role of Object.keys(columns) as RawRole[]){
      const inventory=manifest.inventory.tables.find(t=>t.id===model[role].table);if(!inventory)throw Error("Raw reference table is missing.");
      const fields=Object.keys(columns[role]),indices=fields.map(field=>columns[role][field]===null?-1:inventory.columns.findIndex(c=>c.name===columns[role][field]));
      if(indices.some((index,i)=>index<0&&columns[role][fields[i]]!==null))throw Error("Raw reference column is missing.");
      this.database.exec("CREATE TABLE raw_"+role+"("+fields.map(field=>field+" "+(field==="amount"?"INTEGER":"TEXT")).join(",")+")");
      let rows:(string|number|null)[][]=[],count=0;
      const insert=()=>{if(!rows.length)return;this.database.prepare("INSERT INTO raw_"+role+" VALUES "+rows.map(()=>"("+fields.map(()=>"?").join(",")+")").join(",")).run(...rows.flat());rows=[];};
      this.database.exec("BEGIN");
      try{
        const input=source.prepare("SELECT value FROM ci_raw_rows WHERE version_id=? AND table_id=? ORDER BY row_no").iterate(version,inventory.id);
        for(const row of input){
          const values=JSON.parse(String(row.value)) as (string|boolean|null)[],projected=fields.map((field,index)=>{
            const value=indices[index]<0?null:values[indices[index]];
            if(value===null)return null;if(typeof value!=="string")throw Error("Raw reference field has an incompatible type.");
            return field==="amount"?sourceDecimal(value,model.scale):field==="date"?value.slice(0,10):nativeKey(value);
          });
          if(role==="sales"||role==="returns"){const date=projected[fields.indexOf("date")];if(typeof date!=="string"||date<coverage.from||date>coverage.to)continue;}
          rows.push(projected);count++;if(rows.length>=500)insert();
        }
        insert();this.database.exec("COMMIT");
      }catch(error){this.database.exec("ROLLBACK");throw error;}
      this.counts[role]=count;
    }
    this.database.exec("CREATE INDEX raw_sales_date ON raw_sales(date); CREATE INDEX raw_sales_client ON raw_sales(client,date); CREATE INDEX raw_returns_date ON raw_returns(date); CREATE INDEX raw_customers_client ON raw_customers(client,representative); CREATE INDEX raw_calendar_date ON raw_calendar(date); CREATE INDEX raw_regions_state ON raw_regions(state);");
  }
  query(filters:RawReferenceFilters):RawReferenceValues{
    if(filters.from<this.coverage.from||filters.to>this.coverage.to||filters.from>filters.to)throw Error("The independent query exceeds its raw-source coverage.");
    const keyValue=(value:string|undefined)=>value?nativeKey(value)??"":"";
    const normalized={from:filters.from,to:filters.to,region:keyValue(filters.region),client:keyValue(filters.client),product:keyValue(filters.product),category:keyValue(filters.category),state:keyValue(filters.state),regional:keyValue(filters.regional),manager:keyValue(filters.manager),allowedRegions:(filters.allowedRegions??[]).map(nativeKey),allowedClients:(filters.allowedClients??[]).map(nativeKey),rowFilter:filters.rowFilter?{dimension:filters.rowFilter.dimension,key:filters.rowFilter.key===null?null:nativeKey(filters.rowFilter.key)}:null};
    if(normalized.rowFilter&&!["client","product","category","state"].includes(normalized.rowFilter.dimension))throw Error("Unsupported raw reference row dimension.");
    const key=JSON.stringify(normalized),cached=this.cache.get(key);if(cached)return cached;
    const representative=!!normalized.region||normalized.allowedRegions.length>0;
    const sales=!!normalized.client||!!normalized.product||!!normalized.category||!!normalized.state||normalized.allowedClients.length>0||!!normalized.rowFilter;
    const geography=(alias:string)=>"((c.regional='' AND c.manager='') OR EXISTS(SELECT 1 FROM raw_regions g WHERE g.state IS "+alias+".state AND(c.regional='' OR g.regional=c.regional) AND(c.manager='' OR g.manager=c.manager)))";
    const rowPredicate=normalized.rowFilter?" AND s."+normalized.rowFilter.dimension+" IS json_extract(c.row_filter,'$.key')":"";
    const sql=`WITH input AS(SELECT json(?) AS value),c AS(SELECT json_extract(value,'$.from') AS start,json_extract(value,'$.to') AS finish,json_extract(value,'$.region') AS representative,json_extract(value,'$.client') AS client,json_extract(value,'$.product') AS product,json_extract(value,'$.category') AS category,json_extract(value,'$.state') AS state,json_extract(value,'$.regional') AS regional,json_extract(value,'$.manager') AS manager,json_extract(value,'$.allowedRegions') AS allowed_reps,json_extract(value,'$.allowedClients') AS allowed_clients,json_extract(value,'$.rowFilter') AS row_filter FROM input),
customers AS(SELECT b.client FROM raw_customers b JOIN c WHERE(c.representative='' OR b.representative=c.representative) AND(json_array_length(c.allowed_reps)=0 OR b.representative IN(SELECT value FROM json_each(c.allowed_reps))) AND ${geography("b")}),
sales AS MATERIALIZED(SELECT s.client,s.amount FROM raw_sales s JOIN c WHERE s.date>=c.start AND s.date<=c.finish AND EXISTS(SELECT 1 FROM raw_calendar d WHERE d.date=s.date) AND(c.client='' OR s.client=c.client) AND(c.product='' OR s.product=c.product) AND(c.category='' OR s.category=c.category) AND(c.state='' OR s.state=c.state) AND(json_array_length(c.allowed_clients)=0 OR s.client IN(SELECT value FROM json_each(c.allowed_clients))) AND ${geography("s")}${rowPredicate} ${representative?"AND EXISTS(SELECT 1 FROM customers b WHERE b.client IS s.client)":""}),
return_customers AS(SELECT DISTINCT b.client FROM customers b ${sales?"WHERE EXISTS(SELECT 1 FROM sales s WHERE s.client IS b.client)":""}),
returned AS(SELECT r.amount FROM raw_returns r JOIN c WHERE r.date>=c.start AND r.date<=c.finish AND EXISTS(SELECT 1 FROM raw_calendar d WHERE d.date=r.date) AND ${geography("r")} ${representative||sales?"AND EXISTS(SELECT 1 FROM return_customers b WHERE b.client IS r.client)":""}),
s AS(SELECT SUM(amount) AS gross,CASE WHEN COUNT(*)=0 THEN NULL ELSE COUNT(DISTINCT client)+CASE WHEN COUNT(*)>COUNT(client) THEN 1 ELSE 0 END END AS buyers FROM sales),r AS(SELECT COALESCE(SUM(amount),0) AS returned FROM returned)
SELECT s.gross,r.returned AS returns,COALESCE(s.gross,0)-r.returned AS revenue,s.buyers FROM s CROSS JOIN r`;
    const result={...this.database.prepare(sql).get(key)} as RawReferenceValues;
    for(const value of Object.values(result))if(value!==null&&!Number.isSafeInteger(value))throw Error("Raw reference aggregation exceeds safe integer precision.");
    this.cache.set(key,result);return result;
  }
  purchaseActivity(filters:RawReferenceFilters):{lastPurchase:string|null;purchaseDays:number|null}{
    if(!filters.client||filters.rowFilter)throw Error("Independent daily activity requires one explicit customer.");
    if(filters.from<this.coverage.from||filters.to>this.coverage.to||filters.from>filters.to)return {lastPurchase:null,purchaseDays:null};
    const norm=(value:string|undefined)=>value?nativeKey(value)??"":"";
    const values={...filters,region:norm(filters.region),client:norm(filters.client),product:norm(filters.product),category:norm(filters.category),state:norm(filters.state),regional:norm(filters.regional),manager:norm(filters.manager),allowedRegions:(filters.allowedRegions??[]).map(nativeKey),allowedClients:(filters.allowedClients??[]).map(nativeKey)};
    const geography=(alias:string)=>"((c.regional='' AND c.manager='') OR EXISTS(SELECT 1 FROM raw_regions g WHERE g.state IS "+alias+".state AND(c.regional='' OR g.regional=c.regional) AND(c.manager='' OR g.manager=c.manager)))";
    const sql=`WITH input AS(SELECT json(?) AS value),c AS(SELECT json_extract(value,'$.from') AS start,json_extract(value,'$.to') AS finish,json_extract(value,'$.region') AS representative,json_extract(value,'$.client') AS client,json_extract(value,'$.product') AS product,json_extract(value,'$.category') AS category,json_extract(value,'$.state') AS state,json_extract(value,'$.regional') AS regional,json_extract(value,'$.manager') AS manager,json_extract(value,'$.allowedRegions') AS allowed_reps,json_extract(value,'$.allowedClients') AS allowed_clients FROM input),
days AS(SELECT s.date FROM raw_sales s JOIN c WHERE s.date>=c.start AND s.date<=c.finish AND s.client=c.client AND(c.product='' OR s.product=c.product) AND(c.category='' OR s.category=c.category) AND(c.state='' OR s.state=c.state) AND(json_array_length(c.allowed_clients)=0 OR s.client IN(SELECT value FROM json_each(c.allowed_clients))) AND EXISTS(SELECT 1 FROM raw_calendar d WHERE d.date=s.date) AND ${geography("s")} AND((c.representative='' AND json_array_length(c.allowed_reps)=0) OR EXISTS(SELECT 1 FROM raw_customers b WHERE b.client IS s.client AND(c.representative='' OR b.representative=c.representative) AND(json_array_length(c.allowed_reps)=0 OR b.representative IN(SELECT value FROM json_each(c.allowed_reps))) AND ${geography("b")})) GROUP BY s.date HAVING SUM(s.amount)>0)
SELECT MAX(date) AS lastPurchase,COUNT(*) AS purchaseDays FROM days`;
    return {...this.database.prepare(sql).get(JSON.stringify(values))} as {lastPurchase:string|null;purchaseDays:number};
  }
  close(){this.database.close();}
}

export function verifyRawScenarios(reference:RawCommercialReference,reports:Record<string,Report>,scopes:Record<string,{allowedRegions?:string[];allowedClients?:string[]}>){
  const checks:{scenario:string;row:number|null;period:"current"|"previous";metric:string;expected:number|null;actual:number|null;passed:boolean}[]=[];
  let contexts=0;
  const dates=(from:string,to:string,offset:number)=>({from:(Number(from.slice(0,4))+offset)+from.slice(4)+"-01",to:new Date(Date.UTC(Number(to.slice(0,4))+offset,Number(to.slice(5,7)),0)).toISOString().slice(0,10)});
  for(const [scenario,report]of Object.entries(reports))for(const [index,row]of [report.total,...report.rows].entries())for(const [period,offset]of [["current",0],["previous",-1]] as const){
    let bounds=dates(report.plan.filters.from,report.plan.filters.to,offset),rowFilter:RawReferenceFilters["rowFilter"];
    if(index>0){
      if(report.plan.group==="month"){
        if(!/^\d{4}-\d{2}$/.test(row.name))throw Error("Invalid monthly row in independent evidence.");
        bounds=dates(row.name,row.name,offset);
      }else if(["client","product","category","state"].includes(report.plan.group)){
        const key=row.canDrill===false?null:row.key;
        if(key===undefined)throw Error("A dimensional row lacks an unambiguous key for independent reconciliation.");
        rowFilter={dimension:report.plan.group as NonNullable<RawReferenceFilters["rowFilter"]>["dimension"],key};
      }else throw Error("This report grouping requires a separate independent row reference.");
    }
    const result=reference.query({...report.plan.filters,...bounds,...scopes[scenario],...(rowFilter?{rowFilter}:{})});contexts++;
    for(const metric of ["gross","returns","revenue","buyers"] as const){const expected=result[metric]===null?null:result[metric]!/(metric==="buyers"?1:10**reference.scale),actual=row.values[metric][period];checks.push({scenario,row:index===0?null:index-1,period,metric,expected,actual,passed:expected===actual});}
  }
  return {contexts,metricChecks:checks.length,passed:checks.every(check=>check.passed),checks};
}
