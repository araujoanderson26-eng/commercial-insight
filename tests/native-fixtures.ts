import type {ManualManifest,NativeModel} from "../shared/manual";
import {bytes,hash} from "./manual-fixtures";

type Cell=string|boolean|null;
export type NativeRows=Record<string,Cell[][]>;
export const nativeRows:NativeRows={
  s:[["2025-01-01","0001","P","C","SP","São Paulo","100.0000"],["2026-01-01","0001","P","C","SP","São Paulo","100.0000"],["2026-01-02","0001","Q","D","SP","São Paulo","50.0000"],["2026-01-01","0002","P","C","AM","Manaus","200.0000"]],
  r:[["2025-01-01","0001","Q","D","SP","10"],["2026-01-01","0001","Q","D","SP","10"],["2026-01-02","0001","P","C","SP","5"],["2026-01-01","0002","P","C","AM","20"],["2026-01-01","0003","P","C","SP","999"],["2026-02-01","0001","P","C","SP","7"]],
  c:[["0001","Rep A","SP"],["0001","Rep A","SP"],["0001","Rep B","SP"],["0002","Rep B","AM"],["0003","Rep C","SP"]],
  d:[["2025-01-01"],["2026-01-01"],["2026-01-02"],["2026-02-01"]],
  g:[["SP","Sudeste","G1"],["AM","Norte","G2"],["RJ","Sudeste","G1"]],
  m:[["São Paulo"],["Manaus"]],l:[["SP"],["AM"],["RJ"]],a:[["SP"],["AM"],["RJ"]],z:[],
};
const recipes:NativeModel["recipes"]={
  gross:{measure:"Fat. Bruto",dax:"SUM(Faturamento[Valor mercadorias])",kind:"sum"},
  returns:{measure:"Dev. Fat",dax:"IF(ISBLANK(SUM('DEVOLUÇÃO'[Valor mercadorias])),0,SUM('DEVOLUÇÃO'[Valor mercadorias]))",kind:"sumBlankZero"},
  revenue:{measure:"Fat. Liq.",dax:"[Fat. Bruto]-[Dev. Fat]",kind:"grossMinusReturns"},
  buyers:{measure:"Clientes Atual (ano atual)",dax:"DISTINCTCOUNT(Faturamento[Codigo Cliente])",kind:"distinctClient"},
};
export const nativeModel:NativeModel={
  kind:"panizzon-relational-v1",scale:4,
  sales:{table:"s",date:"Data do doc.",client:"Codigo Cliente",product:"Produto",category:"Categoria",state:"UF",municipality:"Municipio",amount:"Valor mercadorias"},
  returns:{table:"r",date:"Data do lanc.",client:"Cód.PN",product:"Produto",category:"Categoria",state:"UF",amount:"Valor mercadorias"},
  customers:{table:"c",client:"Código Cliente",representative:"Representantes",state:"Estado"},calendar:{table:"d",date:"Date"},
  regions:{table:"g",state:"Sigla",regional:"Regional",manager:"Gerente"},municipalities:{table:"m",name:"MUNICIPIO"},latitudes:{table:"l",state:"UF"},repArea:{table:"a",state:"UF"},recipes,
};
const tables=[
  ["s","Faturamento",["Data do doc.","Codigo Cliente","Produto","Categoria","UF","Municipio","Valor mercadorias"]],
  ["r","DEVOLUÇÃO",["Data do lanc.","Cód.PN","Produto","Categoria","UF","Valor mercadorias"]],
  ["c","Base Clientes",["Código Cliente","Representantes","Estado"]],["d","dCalendario",["Date"]],
  ["g","Base Regionais",["Sigla","Regional","Gerente"]],["m","Base Municipios",["MUNICIPIO"]],["l","Latitudes",["UF"]],["a","RepArea",["UF"]],["z","Medidas",["Coluna1"]],
] as const;
function relation(fromTable:string,fromColumn:string,toTable:string,toColumn:string,fromCardinality="Many",toCardinality="Many",crossFilteringBehavior="BothDirections") {return {fromTable,fromColumn,toTable,toColumn,fromCardinality,toCardinality,crossFilteringBehavior,isActive:true};}
export function nativeFixture(rows:NativeRows=structuredClone(nativeRows),alter?:(m:ManualManifest)=>void) {
  const bodies:Record<string,string>={};
  for(const [id] of tables)if(rows[id].length)bodies[id]=JSON.stringify({kind:"rows",table:id,part:1,rows:rows[id].map((values,i)=>({row:i+1,values}))})+"\n";
  const dims=["date","region","client","product","category","state","regional","manager"] as const;
  const manifest:ManualManifest={kind:"manifest",format:"commercial-insight",formatVersion:2,sourceId:"commercial-main",model:{name:"SINTÉTICO RELACIONAL",id:"synthetic-native-test"},extractedAt:"2026-11-18T12:00:00Z",sourceUpdatedAt:null,referenceDate:"2026-11-18",synthetic:true,stableExtraction:true,
    inventory:{tables:tables.map(([id,name,columns])=>({id,name,columns:columns.map(name=>({name,type:name==="Valor mercadorias"?"Decimal":name.startsWith("Data")||name==="Date"?"DateTime":"String"})),rowCount:rows[id].length,sourceRowCount:rows[id].length,allowEmpty:false,storageMode:"Import",partitions:[],parts:bodies[id]?[{index:1,rows:rows[id].length,bytes:bytes(bodies[id]).length,sha256:hash(bytes(bodies[id]))}]:[],...(id==="z"?{metadataOnly:true}:{})})),
      measures:Object.values(recipes).map(r=>({table:"Medidas",name:r.measure,expression:r.dax})),relationships:[
        relation("s","Data do doc.","d","Date","Many","One","OneDirection"),relation("r","Data do lanc.","d","Date","Many","One","OneDirection"),
        relation("c","Código Cliente","s","Codigo Cliente"),relation("r","Cód.PN","c","Código Cliente","Many","Many","OneDirection"),relation("m","MUNICIPIO","s","Municipio"),
        relation("l","UF","c","Estado"),relation("l","UF","a","UF"),relation("s","UF","g","Sigla","Many","One","OneDirection"),relation("r","UF","g","Sigla","Many","One","OneDirection"),relation("c","Estado","g","Sigla","Many","One","OneDirection"),relation("l","UF","g","Sigla","Many","One","OneDirection"),
      ],dependencies:[],excluded:[{table:"Medidas",reason:"metadata-only: zero business rows, owned measures retained"}]},
    projection:{rowCount:rows.s.length+rows.r.length,from:"2025-01-01",to:"2026-02-01",grain:"Fatos nativos independentes; relações limitadas muitos-para-muitos sem produto cartesiano",dimensions:[...dims],parts:[]},nativeModel:structuredClone(nativeModel),
    metrics:(["gross","revenue","returns","buyers"] as const).map(id=>({id,originalName:recipes[id].measure,dax:recipes[id].dax,unit:id==="buyers"?"count":"money",kind:"native",scale:id==="buyers"?0:4,status:"validated",supportedFilters:[...dims]})),controls:[],
  };
  const cuts=[
    {context:"total",extra:{},values:[450,1051,-601,2]},
    {context:"month",extra:{from:"2026-01-01",to:"2026-01-31"},values:[350,1034,-684,2]},
    {context:"region",extra:{region:"Rep A"},values:[250,32,218,1]},
    {context:"client",extra:{client:"0001"},values:[250,32,218,1]},
    {context:"product",extra:{product:"P"},values:[400,52,348,2]},
    {context:"state",extra:{state:"SP"},values:[250,32,218,1]},
    {context:"category",extra:{category:"C"},values:[400,52,348,2]},
    {context:"regional",extra:{regional:"Sudeste"},values:[250,1031,-781,1]},
    {context:"manager",extra:{manager:"G1"},values:[250,1031,-781,1]},
  ] as const;
  for(const cut of cuts)for(const [index,metric]of (["gross","returns","revenue","buyers"] as const).entries())manifest.controls.push({metric,context:cut.context,filters:{from:manifest.projection.from,to:manifest.projection.to,...cut.extra},expected:String(cut.values[index]),dax:"EVALUATE ROW(\"value\", ["+recipes[metric].measure+"]) /* SYNTHETIC INDEPENDENT EXPECTATION */",referenceDate:manifest.referenceDate,tolerance:"0"});
  alter?.(manifest);
  const text=JSON.stringify(manifest)+"\n"+tables.map(([id])=>bodies[id]??"").join("");
  return {manifest,rows,text,data:bytes(text),sha256:hash(bytes(text))};
}
