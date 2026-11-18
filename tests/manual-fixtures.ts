import {createHash} from "node:crypto";
import type {Fact,ManualManifest} from "../shared/manual";
export const testFacts:Fact[]=[
  {row:1,date:"2025-01-01",region:"Sul",client:"0001",product:"P",category:"C",state:"SP",values:{revenue:"10.00"}},
  {row:2,date:"2025-01-01",region:"Norte",client:"0002",product:"Q",category:"C",state:"AM",values:{revenue:"20.00"}},
  {row:3,date:"2026-01-01",region:"Sul",client:"0001",product:"P",category:"C",state:"SP",values:{revenue:"30.00"}},
  {row:4,date:"2026-01-01",region:"Norte",client:"0002",product:"Q",category:"C",state:"AM",values:{revenue:"40.00"}},
];
export const bytes=(s:string)=>new TextEncoder().encode(s);
export const hash=(s:Uint8Array)=>createHash("sha256").update(s).digest("hex");
export function fixturePackage(facts:Fact[]=testFacts,alter?:(m:ManualManifest)=>void) {
  facts=facts.map((f,i)=>({...f,row:i+1}));
  const rows=facts.map(f=>({row:f.row,values:[f.date,f.region,f.client,f.product,f.category,f.state,f.values.revenue]}));
  const raw=JSON.stringify({kind:"rows",table:"f",part:1,rows})+"\n";
  const projection=JSON.stringify({kind:"facts",part:1,rows:facts})+"\n";
  const part=(s:string)=>({index:1,rows:facts.length,bytes:bytes(s).length,sha256:hash(bytes(s))});
  const from=facts.map(f=>f.date).sort()[0],to=facts.map(f=>f.date).sort().at(-1)!;
  const contexts=["total","month","region","client","product","state"] as const;
  const manifest:ManualManifest={
    kind:"manifest",format:"commercial-insight",formatVersion:1,sourceId:"commercial-main",model:{name:"SINTÉTICO DE TESTE",id:"synthetic-import-test"},
    extractedAt:"2026-11-18T12:00:00Z",sourceUpdatedAt:"2026-11-18T11:00:00Z",referenceDate:"2026-11-18",synthetic:true,stableExtraction:true,
    inventory:{tables:[{id:"f",name:"Fatos sintéticos",columns:["date","region","client","product","category","state","revenue"].map(name=>({name,type:name==="revenue"?"Decimal":"String"})),rowCount:facts.length,sourceRowCount:facts.length,allowEmpty:false,storageMode:"Import",partitions:[],parts:[part(raw)]}],measures:[{name:"Receita",expression:"SUM(Fatos[revenue])"}],relationships:[],dependencies:[],excluded:[]},
    projection:{rowCount:facts.length,from,to,grain:"Uma linha por movimento sem deduplicação",dimensions:["date","region","client","product","category","state"],parts:[part(projection)]},
    metrics:[{id:"revenue",originalName:"Receita",dax:"SUM(Fatos[revenue])",unit:"money",kind:"sum",component:"revenue",scale:2,status:"validated",supportedFilters:["date","region","client","product","category","state"]}],
    controls:contexts.map(context=>{
      const filters={from:context==="month"?to.slice(0,7)+"-01":from,to,...(context==="region"?{region:"Sul"}:context==="client"?{client:"0001"}:context==="product"?{product:"P"}:context==="state"?{state:"SP"}:{})};
      const selected=facts.filter(f=>f.date>=filters.from&&f.date<=filters.to&&(!("region" in filters)||f.region===filters.region)&&(!("client" in filters)||f.client===filters.client)&&(!("product" in filters)||f.product===filters.product)&&(!("state" in filters)||f.state===filters.state));
      const total=selected.length?String(selected.reduce((n,f)=>n+Math.round(Number(f.values.revenue)*100),0)/100):null;
      return {metric:"revenue",context,filters,expected:total,dax:"EVALUATE ROW(\"value\", [Receita]) /* TESTE SINTÉTICO "+context+" */",referenceDate:"2026-11-18",tolerance:"0"};
    }),
  };
  alter?.(manifest);
  const text=JSON.stringify(manifest)+"\n"+raw+projection;
  return {manifest,text,data:bytes(text),sha256:hash(bytes(text))};
}
export function fixtureManifest(){return fixturePackage().manifest;}
export function fakeR2() {
  const objects=new Map<string,Uint8Array>(),uploads=new Map<string,{key:string;parts:Map<number,{data:Uint8Array;etag:string}>}>();
  let sequence=0;
  const stream=(data:Uint8Array)=>new ReadableStream<Uint8Array>({start(controller){for(let p=0;p<data.length;p+=65536)controller.enqueue(data.slice(p,p+65536));controller.close();}});
  const upload=(key:string,id:string)=>({
    uploadId:id,key,
    async uploadPart(part:number,body:ReadableStream<Uint8Array>) {
      const data=new Uint8Array(await new Response(body).arrayBuffer()),etag=hash(data);
      const u=uploads.get(id);if(!u)throw new Error("Upload missing");u.parts.set(part,{data,etag});return {partNumber:part,etag};
    },
    async complete(parts:{partNumber:number;etag:string}[]) {
      const u=uploads.get(id);if(!u)throw new Error("Upload missing");
      const arrays=parts.map(p=>{const found=u.parts.get(p.partNumber);if(!found||found.etag!==p.etag)throw new Error("Bad ETag");return found.data;});
      const data=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let position=0;for(const a of arrays){data.set(a,position);position+=a.length;}
      objects.set(key,data);uploads.delete(id);return {size:data.length};
    },
    async abort(){uploads.delete(id);},
  });
  const bucket={
    async createMultipartUpload(key:string){const id=String(++sequence);uploads.set(id,{key,parts:new Map()});return upload(key,id);},
    resumeMultipartUpload:upload,
    async head(key:string){const data=objects.get(key);return data?{size:data.length}:null;},
    async get(key:string,options?:{range:{offset:number;length:number}}){let data=objects.get(key);if(!data)return null;const size=data.length;if(options)data=data.slice(options.range.offset,options.range.offset+options.range.length);const current=data;return {size,body:stream(current),async arrayBuffer(){return current.buffer.slice(current.byteOffset,current.byteOffset+current.byteLength);}};},
  };
  return {bucket:bucket as unknown as R2Bucket,objects,uploads};
}
