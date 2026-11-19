import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import worker from "../worker/index";
import { Problem, type DbUser } from "../worker/core";
import { passwordHash } from "../shared/password.mjs";
import { metricKeys, type Report } from "../shared/domain";
import { fixturePackage } from "./manual-fixtures";
import { makeStore } from "./fixtures";
import { manualRoute, manualContext } from "../worker/manual";
import { buildCommentOpenAIRequest, buildInterpretOpenAIRequest, interpret } from "../worker/assistant";
import { controlledHmlModelPreflight, finishHmlOpenAI, reserveHmlOpenAI } from "../worker/openai-budget";
import { assertControlledHmlManifest, assertControlledHmlUser, controlledHmlAdminId, controlledHmlFilters,
  controlledHmlOrigin, controlledHmlPolicy, hmlManifestHash, hmlQuestionHash, type ControlledHmlPolicy } from "../worker/real-hml-policy";

const questions = ["Como está nosso faturamento líquido em 2026 em comparação com o mesmo período de 2025?",
  "Quais clientes apresentaram as maiores quedas de faturamento em relação ao ano anterior?",
  "Prepare uma visita comercial para um cliente autorizado da minha carteira.",
  "Quais produtos explicam a maior parte da queda desse cliente?"];
const period={from:"2026-01",to:"2026-10"};
const baseFilters={...period,region:"",client:"",product:"",state:""};
function store() {
  const value=makeStore();
  for(const file of ["0007_hml_openai_budget","0008_hml_real_authorization","0009_hml_openai_cache_usage"])
    value.sql.exec(readFileSync(new URL("../migrations/"+file+".sql",import.meta.url),"utf8"));
  const real=fixturePackage(undefined,m=>{m.synthetic=false;m.model.id="isolated-real-sample-test";});
  const managerId=randomUUID();
  const policy:ControlledHmlPolicy={runId:"real-hml-test",expiresAt:new Date(Date.now()+3600000).toISOString(),
    packageSha256:real.sha256,manifestSha256:hmlManifestHash(real.manifest),sourceModelId:real.manifest.model.id,
    extractedAt:real.manifest.extractedAt,referenceDate:real.manifest.referenceDate,
    allowedQuestionHashes:questions.map(hmlQuestionHash),allowedClientCodes:["0001"],allowedUserIds:[controlledHmlAdminId,managerId],
    period,scopedFilters:{state:"SP",region:"123 — NOME DO REPRESENTANTE"}};
  Object.assign(value.env,{APP_ORIGIN:controlledHmlOrigin,HML_SYNTHETIC_ONLY:"false",HML_OPENAI_BUDGET_USD:"0.10",
    HML_REAL_DATA_AUTHORIZATION:JSON.stringify(policy),OPENAI_MODEL:"gpt-4.1-mini",MANUAL_ALLOW_SYNTHETIC:"true"});
  const version=randomUUID();
  value.sql.prepare(`INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,manifest,created,updated,published)
    VALUES(?,?,?,?,?,?,?,'published',0,?,1,1,1)`).run(version,controlledHmlAdminId,"Admin","sample.ci.ndjson",real.data.length,real.sha256,"private-test",JSON.stringify(real.manifest));
  value.sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?,allow_ai=1 WHERE id='commercial-main'").run(version);
  return {...value,real,policy,managerId,version};
}
const isDenied=(status:number)=>(error:unknown)=>error instanceof Problem&&error.status===status;

test("autorização real exige origem, modo, participantes, validade e hashes; produção sem flags segue igual",t=>{
  const s=store();t.after(()=>s.sql.close());
  assert.equal(controlledHmlPolicy(s.env)?.runId,s.policy.runId);
  assert.doesNotThrow(()=>assertControlledHmlManifest(s.env,s.real.manifest,s.real.sha256,true));
  assert.throws(()=>assertControlledHmlManifest(s.env,s.real.manifest,"b".repeat(64),true),isDenied(403));
  assert.throws(()=>assertControlledHmlManifest(s.env,{...s.real.manifest,referenceDate:"2026-10-31"},s.real.sha256,true),isDenied(403));
  for(const patch of [{APP_ORIGIN:"https://production.example.test"},{HML_SYNTHETIC_ONLY:"true"},{HML_REAL_DATA_AUTHORIZATION:undefined},
    {HML_REAL_DATA_AUTHORIZATION:JSON.stringify({...s.policy,expiresAt:new Date(Date.now()+2*86400000).toISOString()})}])
    assert.throws(()=>controlledHmlPolicy({...s.env,...patch},true),isDenied(503));
  const expired={...s.env,HML_REAL_DATA_AUTHORIZATION:JSON.stringify({...s.policy,expiresAt:new Date(Date.now()-1000).toISOString()})};
  assert.throws(()=>assertControlledHmlManifest(expired,s.real.manifest,s.real.sha256,true),isDenied(403));
  assert.doesNotThrow(()=>assertControlledHmlManifest(expired,fixturePackage().manifest,"c".repeat(64),true));
  const production=makeStore();try{assert.equal(controlledHmlPolicy(production.env),null);assert.doesNotThrow(()=>assertControlledHmlManifest(production.env,s.real.manifest));}finally{production.sql.close();}
});

test("escopo temporário não modifica usuários e distingue nacional, carteira SP e cliente autorizado",t=>{
  const s=store();t.after(()=>s.sql.close());
  const initial=s.sql.prepare("SELECT * FROM users").all();
  assert.doesNotThrow(()=>assertControlledHmlUser(s.env,controlledHmlAdminId));
  assert.throws(()=>assertControlledHmlUser(s.env,randomUUID()),isDenied(403));
  assert.deepEqual(controlledHmlFilters(s.env,{id:controlledHmlAdminId},baseFilters),baseFilters);
  const scoped=controlledHmlFilters(s.env,{id:s.managerId},baseFilters);
  assert.equal(scoped.state,"SP");assert.equal(scoped.region,s.policy.scopedFilters.region);assert.equal(scoped.client,"");
  assert.throws(()=>controlledHmlFilters(s.env,{id:s.managerId},{...scoped,state:"RJ"}),isDenied(403));
  assert.throws(()=>controlledHmlFilters(s.env,{id:s.managerId},{...scoped,client:"9999"}),isDenied(403));
  assert.deepEqual(s.sql.prepare("SELECT * FROM users").all(),initial);
});

test("pacote não autorizado é recusado antes de criar upload ou alterar a base",async t=>{
  const s=store();t.after(()=>s.sql.close());
  let uploads=0;s.env.BUCKET={createMultipartUpload:async()=>{uploads++;throw Error("Não deve criar upload");}} as unknown as R2Bucket;
  const request=new Request(controlledHmlOrigin+"/api/admin/data/imports",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({filename:"unauthorized.ci.ndjson",bytes:100,sha256:"b".repeat(64)})});
  await assert.rejects(manualRoute(request,s.env,{id:controlledHmlAdminId,role:"admin"} as DbUser,"/admin/data/imports"),isDenied(403));
  assert.equal(uploads,0);assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ci_imports").get()!.n,1);
  s.sql.prepare("UPDATE ci_imports SET manifest=? WHERE id=?").run(JSON.stringify({...s.real.manifest,model:{...s.real.manifest.model,id:"another"}}),s.version);
  await assert.rejects(manualContext(s.env),isDenied(403));
});

test("builders puros minimizam payload real sem alterar código e razão social da interface",t=>{
  const s=store();t.after(()=>s.sql.close());
  const scoped={...baseFilters,...s.policy.scopedFilters,client:"0001"};
  const semantic={allowAI:true,measures:{revenue:"Receita",margin:null,returns:null,buyers:null}};
  const request=buildInterpretOpenAIRequest(s.env,semantic,questions[2],scoped,[],s.managerId);
  assert.doesNotMatch(request,/NOME DO REPRESENTANTE/);assert.match(request,/CARTEIRA_AUTORIZADA/);
  const values=Object.fromEntries(metricKeys.map(key=>[key,{current:key==="revenue"?50:null,previous:null}])) as Report["total"]["values"];
  const report:Report={plan:{metric:"revenue",group:"client",order:"current",filters:scoped},total:{name:"Total",values},
    rows:[{name:"0001 — RAZÃO SOCIAL PRIVADA",values}],source:"ORIGEM PRIVADA",asOf:"2026-11-19T00:00:00Z",truncated:false,
    sourceInfo:{versionId:s.version,extractedAt:s.real.manifest.extractedAt,sourceUpdatedAt:null,referenceDate:s.real.manifest.referenceDate,
      coverage:{from:"2025-01-01",to:"2026-10-31"}}};
  const comment=buildCommentOpenAIRequest(s.env,questions[2],report,s.managerId);
  assert.doesNotMatch(comment,/RAZÃO SOCIAL PRIVADA|NOME DO REPRESENTANTE|ORIGEM PRIVADA/);
  assert.equal(JSON.parse(JSON.parse(comment).input).rows[0].name,"0001");
  assert.equal(report.rows[0].name,"0001 — RAZÃO SOCIAL PRIVADA");
  report.plan.group="product";report.rows[0]={...report.rows[0],key:"PV001",name:"PV001 — DESCRIÇÃO PRIVADA"};
  assert.equal(JSON.parse(JSON.parse(buildCommentOpenAIRequest(s.env,questions[3],report,s.managerId)).input).rows[0].name,"PV001");
  assert.throws(()=>buildInterpretOpenAIRequest(s.env,semantic,"Pergunta com contato não autorizado",scoped,[],s.managerId),isDenied(403));
});

test("ledger real mantém reservas antigas, impõe ordem e no máximo dezoito tentativas cumulativas",async t=>{
  const s=store();t.after(()=>s.sql.close());
  for(let i=0;i<10;i++)s.sql.prepare(`INSERT INTO hml_openai_attempts(id,model,purpose,reserved_nano_usd,reserved_input_tokens,output_limit,status,created)
    VALUES(?,'gpt-4.1-mini','plano_comercial',4135480,1,1200,'completed',1)`).run("old-"+i);
  const firstBody=JSON.stringify({input:JSON.stringify({question:questions[1],filters:{...baseFilters,...s.policy.scopedFilters}})});
  await assert.rejects(reserveHmlOpenAI(s.env,firstBody,"plano_comercial",s.managerId),isDenied(429));
  for(let i=0;i<4;i++){
    const filters=i===0?baseFilters:{...baseFilters,...s.policy.scopedFilters,...(i>=2?{client:"0001"}:{})};
    for(const purpose of ["plano_comercial","leitura_comercial"]){
      const body=JSON.stringify({input:JSON.stringify({question:questions[i],...(purpose==="plano_comercial"?{filters}:{period:filters})})});
      const r=await reserveHmlOpenAI(s.env,body,purpose,i===0?controlledHmlAdminId:s.managerId);
      await finishHmlOpenAI(s.env,r,{status:"completed",model:"gpt-4.1-mini",usage:{input_tokens:100,output_tokens:20}});
    }
  }
  const total=s.sql.prepare("SELECT COUNT(*) AS n,SUM(reserved_nano_usd) AS reserve FROM hml_openai_attempts").get()!;
  assert.equal(total.n,18);assert.ok(Number(total.reserve)<100000000);
  await assert.rejects(reserveHmlOpenAI(s.env,firstBody,"plano_comercial",s.managerId),isDenied(429));
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM hml_openai_attempts WHERE authorization_run_id=?").get(s.policy.runId)!.n,8);
});

test("interpretação real estreita ano genérico ao período autorizado e restaura alias sem mudar indicador",async t=>{
  const s=store();t.after(()=>s.sql.close());
  t.mock.method(globalThis,"fetch",async()=>Response.json({status:"completed",model:"gpt-4.1-mini",usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:20}},
    output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({supported:true,reason:"",inheritContext:false,
      metric:"revenue",group:"month",order:"current",filters:{...baseFilters,to:"2026-12"}})}]}]}));
  const result=await interpret(s.env,{allowAI:true,measures:{revenue:"Receita",margin:null,returns:null,buyers:null}},questions[0],baseFilters,[],controlledHmlAdminId);
  assert.equal(result.filters.to,"2026-10");assert.equal(result.metric,"revenue");assert.equal(result.group,"month");
  const usage=s.sql.prepare("SELECT cached_input_tokens,actual_nano_usd FROM hml_openai_attempts").get()!;
  assert.equal(usage.cached_input_tokens,20);assert.equal(usage.actual_nano_usd,80*400+20*100+50*1600);
});

test("cache inválido na resposta real mantém reserva e recusa metadados em vez de subestimar cobrança",async t=>{
  const s=store();t.after(()=>s.sql.close());
  t.mock.method(globalThis,"fetch",async()=>Response.json({status:"completed",model:"gpt-4.1-mini",
    usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:101}},output:[]}));
  await assert.rejects(interpret(s.env,{allowAI:true,measures:{revenue:"Receita",margin:null,returns:null,buyers:null}},questions[0],baseFilters,[],controlledHmlAdminId),isDenied(502));
  const record=s.sql.prepare("SELECT status,reserved_nano_usd,actual_nano_usd,cached_input_tokens FROM hml_openai_attempts").get()!;
  assert.equal(record.status,"response_error");assert.ok(Number(record.reserved_nano_usd)>0);assert.equal(record.actual_nano_usd,null);assert.equal(record.cached_input_tokens,null);
});

test("pré-checagem usa apenas GET de metadados do modelo e não consome tentativa de inferência",async t=>{
  const s=store();t.after(()=>s.sql.close());
  const mock=t.mock.method(globalThis,"fetch",async(url:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(String(url),"https://api.openai.com/v1/models/gpt-4.1-mini");assert.equal(init?.body,undefined);
    return Response.json({id:"gpt-4.1-mini",object:"model",owned_by:"unneeded"});});
  const result=await controlledHmlModelPreflight(s.env,controlledHmlAdminId);
  assert.equal(result.available,true);assert.equal(result.modelId,"gpt-4.1-mini");assert.equal(mock.mock.callCount(),1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM hml_openai_attempts").get()!.n,0);
  await assert.rejects(controlledHmlModelPreflight(s.env,s.managerId),isDenied(403));
});

test("usuário fora do ensaio mantém login e logout mas não acessa dados reais; registros preservados",async t=>{
  const s=store();t.after(()=>s.sql.close());
  const outsider=randomUUID(),password="Senha exclusiva do ensaio de permissões",hashed=await passwordHash(password);
  s.sql.prepare("INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,1)").run(outsider,"outside@example.test","Usuário anterior",hashed,"comercial");
  const initial=s.sql.prepare("SELECT * FROM users WHERE id=?").get(outsider);
  const pending:Promise<unknown>[]=[];const ctx={waitUntil:(promise:Promise<unknown>)=>pending.push(promise)} as ExecutionContext;
  const req=(path:string,method="GET",value?:unknown,cookie="")=>worker.fetch(new Request(controlledHmlOrigin+"/api/"+path,{method,
    headers:{Origin:controlledHmlOrigin,"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},body:value===undefined?undefined:JSON.stringify(value)}),s.env,ctx);
  const login=await req("auth/login","POST",{email:"outside@example.test",password});assert.equal(login.status,200);
  const cookie=login.headers.get("set-cookie")!.split(";")[0];
  for(const path of ["me","data/status","admin/data","conversations","hml-real/preflight"])
    assert.equal((await req(path,"GET",undefined,cookie)).status,403,path);
  assert.equal((await req("auth/logout","POST",{},cookie)).status,200);
  await Promise.all(pending);
  // Authentication legitimately updates no profile fields; authorization never rewrites roles or scopes.
  assert.deepEqual(s.sql.prepare("SELECT * FROM users WHERE id=?").get(outsider),initial);
});
