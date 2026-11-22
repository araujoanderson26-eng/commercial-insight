import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productionAIModel, productionAIStatus, reserveProductionAI, finishProductionAI, estimateProductionAI, assertProductionAI, productionAIModelPreflight } from '../worker/production-ai-budget';
import { buildInterpretOpenAIRequest, interpret, comment } from '../worker/assistant';
import { Problem, digest, now } from '../worker/core';
import { reserveHmlOpenAI } from '../worker/openai-budget';
import worker from '../worker/index';
import { filters, makeStore, model, plan } from './fixtures';
import { metricKeys, type Report, type Row } from '../shared/domain';

function setup() {
  const s = makeStore();
  s.sql.exec(readFileSync(new URL('../migrations/0010_production_ai_budget.sql', import.meta.url),'utf8'));
  Object.assign(s.env, { APP_ORIGIN:'https://commercial-insight.araujoempresarial.com.br',PRODUCTION_AI_BUDGET:'true',OPENAI_MODEL:productionAIModel });
  for (const [id,role] of [['owner','admin'],['other-admin','admin'],['sales','comercial']])
    s.sql.prepare('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)').run(id,id+'@synthetic.test',id,'unused',role,now());
  s.sql.prepare(`UPDATE ai_production_policy SET enabled=1,administrator_id='owner',organization_id='org-synthetic',project_id='proj_synthetic',
    credit_ceiling_nano_usd=30000000000,credit_verified_at=?,credit_valid_until=?,verification_reference='synthetic-proof-only',pricing_valid_until=? WHERE id=1`)
    .run(now(),now()+3600,now()+3600);
  s.sql.prepare('INSERT INTO settings(id,body,revision) VALUES(1,?,1)').run(JSON.stringify(model));
  const body = () => buildInterpretOpenAIRequest(s.env,model,'Como estamos?',filters,[],'owner');
  const reserve = (actor='owner') => reserveProductionAI(s.env,body(),'plano_comercial',actor);
  return {...s,body,reserve};
}
const good = { status:'completed' as const,model:productionAIModel,usage:{input_tokens:100,output_tokens:40} };
const failsWith = (status:number) => (error:unknown) => error instanceof Problem && error.status===status;

test('metadata preflight binds organization/project, keeps spending disabled and exposes no credential or credit claim',async t=>{
  const s=setup();t.after(()=>s.sql.close());s.sql.exec('UPDATE ai_production_policy SET enabled=0');
  const mocked=t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/models/'+productionAIModel);assert.equal(init?.method,undefined);
    const headers=new Headers(init?.headers);assert.equal(headers.get('OpenAI-Organization'),'org-synthetic');assert.equal(headers.get('OpenAI-Project'),'proj_synthetic');
    return Response.json({id:productionAIModel,private:'DO_NOT_RETURN'});
  });
  await assert.rejects(productionAIModelPreflight(s.env,'other-admin'),failsWith(403));
  const result=await productionAIModelPreflight(s.env,'owner');assert.equal(result.available,true);assert.equal(result.paidRequests,0);
  assert.equal(result.creditBalanceVerified,false);assert.equal(result.autoReloadVerified,false);
  assert.doesNotMatch(JSON.stringify(result),/test-only|DO_NOT_RETURN/);assert.equal(mocked.mock.callCount(),1);
  assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM ai_production_attempts').get()!.n,0);
  assert.equal(s.sql.prepare('SELECT enabled FROM ai_production_policy').get()!.enabled,0);
});
test('metadata preflight rejects missing key/project, provider refusal and oversized response without inference',async t=>{
  const s=setup();t.after(()=>s.sql.close());
  await assert.rejects(productionAIModelPreflight({...s.env,OPENAI_API_KEY:undefined},'owner'),failsWith(409));
  s.sql.exec('UPDATE ai_production_policy SET project_id=NULL');await assert.rejects(productionAIModelPreflight(s.env,'owner'),failsWith(409));
  s.sql.exec("UPDATE ai_production_policy SET project_id='proj_synthetic'");
  let response=()=>Response.json({private:'DO_NOT_RETURN'},{status:403});t.mock.method(globalThis,'fetch',async()=>response());
  assert.deepEqual(await productionAIModelPreflight(s.env,'owner'),{available:false,status:403,scopedRequestAccepted:false,paidRequests:0});
  response=()=>Response.json({id:'other-model'});await assert.rejects(productionAIModelPreflight(s.env,'owner'),failsWith(502));
  response=()=>new Response('x'.repeat(9000));await assert.rejects(productionAIModelPreflight(s.env,'owner'),failsWith(502));
  assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM ai_production_attempts').get()!.n,0);
});

test('production ledger is additive, disabled by default and independent of HML tables',async t=>{
  const s=makeStore();t.after(()=>s.sql.close());
  s.sql.exec(readFileSync(new URL('../migrations/0010_production_ai_budget.sql',import.meta.url),'utf8'));
  const row=s.sql.prepare('SELECT enabled,monthly_cap_nano_usd,credit_ceiling_nano_usd FROM ai_production_policy').get()!;
  assert.deepEqual({...row},{enabled:0,monthly_cap_nano_usd:20_000_000_000,credit_ceiling_nano_usd:0});
  assert.equal(s.sql.prepare("SELECT name FROM sqlite_master WHERE name='hml_openai_attempts'").get(),undefined);
});
test('production origin cannot bypass financial policy by removing its flag or migration',async t=>{
  const s=setup();t.after(()=>s.sql.close());
  delete s.env.PRODUCTION_AI_BUDGET;
  assert.equal((await productionAIStatus(s.env,'owner')).reason,'budget_unavailable');
  await assert.rejects(s.reserve(),failsWith(503));
  s.sql.exec('DROP TABLE ai_production_policy');
  await assert.rejects(reserveHmlOpenAI(s.env,s.body(),'plano_comercial','owner'),failsWith(503));
});
test('active authorized commercial users can reserve under active admin policy; operators, inactive and missing actors cannot',async t=>{
  const s=setup();t.after(()=>s.sql.close());
  s.sql.prepare("INSERT INTO users(id,email,name,password,role,created,update_only) VALUES('op','op@synthetic.test','op','unused','comercial',?,1)").run(now());
  for(const actor of ['op','unknown']) {
    await assert.rejects(s.reserve(actor),failsWith(403));
    assert.equal((await productionAIStatus(s.env,actor)).budget,undefined);
  }
  await assert.rejects(reserveProductionAI(s.env,s.body(),'plano_comercial'),failsWith(403));
  // Commercial user (sales) is authorized to use AI without seeing admin-only budget ledger
  assert.equal((await productionAIStatus(s.env,'sales')).ready,true);
  assert.equal((await productionAIStatus(s.env,'sales')).budget,undefined);
  // If authorizing administrator becomes inactive, non-admin or update_only, everyone is blocked
  for(const patch of ["active=0","active=1,role='comercial'","role='admin',update_only=1"]){
    s.sql.exec('UPDATE users SET '+patch+" WHERE id='owner'");
    await assert.rejects(s.reserve('owner'),failsWith(403));
    await assert.rejects(s.reserve('sales'),failsWith(403));
  }
  assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM ai_production_attempts').get()!.n,0);
});
test('unknown, expired or unfunded credits always prevent fetch without requiring daily 24h manual re-verification',async t=>{
  const s=setup();t.after(()=>s.sql.close());let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('must not fetch');});
  // Verification older than 24h remains valid while credit_valid_until and pricing_valid_until are still valid
  s.sql.prepare('UPDATE ai_production_policy SET credit_verified_at=? WHERE id=1').run(now()-86401*5);
  assert.equal((await productionAIStatus(s.env,'owner')).ready,true);
  for(const patch of ['enabled=0','credit_ceiling_nano_usd=0',`credit_valid_until=${now()-1}`,`credit_verified_at=0`,
    `credit_verified_at=${now()+100}`,"organization_id=NULL","project_id=NULL","verification_reference=NULL",`pricing_valid_until=${now()-1}`]){
    s.sql.exec('SAVEPOINT scenario');s.sql.exec('UPDATE ai_production_policy SET '+patch);
    await assert.rejects(interpret(s.env,model,'Como estamos?',filters,[],'owner'),failsWith(503));s.sql.exec('ROLLBACK TO scenario; RELEASE scenario');
  }
  assert.equal(calls,0);assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM ai_production_attempts').get()!.n,0);
});
test('single atomic statement admits only one concurrent provider call',async t=>{
  const s=setup();t.after(()=>s.sql.close());
  const attempts=await Promise.allSettled(Array.from({length:25},()=>s.reserve()));
  const success=attempts.filter(v=>v.status==='fulfilled');assert.equal(success.length,1);
  for(const a of attempts)if(a.status==='rejected')assert.equal(a.reason.status,429);
  assert.equal((await productionAIStatus(s.env,'owner')).reason,'request_in_progress');
  await finishProductionAI(s.env,success[0].value,good);
  assert.equal((await productionAIStatus(s.env,'owner')).ready,true);await s.reserve();
});
test('a full monthly budget blocks next request but does not discard the final paid answer',async t=>{
  const s=setup();t.after(()=>s.sql.close());const cost=estimateProductionAI(s.body()).nanoUsd;
  s.sql.prepare('UPDATE ai_production_policy SET monthly_cap_nano_usd=?').run(cost);
  const r=await s.reserve();await finishProductionAI(s.env,r,good);
  assert.equal((await productionAIStatus(s.env,'owner')).reason,'budget_exhausted');
  await assertProductionAI(s.env,'owner');await assert.rejects(s.reserve(),failsWith(429));
  assert.equal(s.sql.prepare('SELECT SUM(reserved_nano_usd) n FROM ai_production_attempts').get()!.n,cost);
});
test('monthly rollover preserves the lifetime credit ceiling and prior-month unresolved calls',async t=>{
  const s=setup();t.after(()=>s.sql.close());const cost=estimateProductionAI(s.body()).nanoUsd;
  s.sql.prepare(`INSERT INTO ai_production_attempts(id,owner,policy_revision,month,model,purpose,reserved_nano_usd,reserved_input_tokens,output_limit,status,created)
    VALUES('old','owner',1,'2020-01',?,'plano_comercial',?,100,1200,'completed',1)`).run(productionAIModel,30_000_000_000-cost);
  const r=await s.reserve();await finishProductionAI(s.env,r,good);await assert.rejects(s.reserve(),failsWith(429));
  assert.equal((await productionAIStatus(s.env,'owner')).budget!.reservedUsd,cost/1e9);
  s.sql.exec("UPDATE ai_production_attempts SET status='transport_error' WHERE id='old'");
  assert.equal((await productionAIStatus(s.env,'owner')).reason,'budget_exhausted');
});
test('unknown usage, timeout and model/token mismatch retain reservations and fail closed across months',async t=>{
  for(const outcome of [{status:'transport_error' as const},{status:'response_error' as const},
    {status:'http_error' as const,httpStatus:500},
    {status:'completed' as const,model:productionAIModel},{...good,model:'unexpected-model'},
    {...good,usage:{input_tokens:100,output_tokens:1201}}]){
    const s=setup();t.after(()=>s.sql.close());const r=await s.reserve();
    await finishProductionAI(s.env,r,outcome).catch(e=>assert.equal(e.status,503));
    await assert.rejects(s.reserve(),failsWith(429));
    assert.equal(s.sql.prepare('SELECT reserved_nano_usd n FROM ai_production_attempts').get()!.n,r.nanoUsd);
  }
});
test('settlement cannot rewrite a finished attempt or free its financial reservation',async t=>{
  const s=setup();t.after(()=>s.sql.close());const r=await s.reserve();await finishProductionAI(s.env,r,good);
  await finishProductionAI(s.env,r,{...good,usage:{input_tokens:0,output_tokens:0}});
  const row=s.sql.prepare('SELECT * FROM ai_production_attempts').get()!;
  assert.equal(row.input_tokens,100);assert.equal(row.reserved_nano_usd,r.nanoUsd);
  assert.throws(()=>s.sql.exec('DELETE FROM ai_production_attempts'));
  assert.throws(()=>s.sql.exec('UPDATE ai_production_attempts SET reserved_nano_usd=1'));
});
test('alerts at 10, 16 and 20 dollars are atomic, persistent, distinct from billing and deduplicated',async t=>{
  const s=setup();t.after(()=>s.sql.close());
  const insert=s.sql.prepare(`INSERT INTO ai_production_attempts(id,owner,policy_revision,month,model,purpose,reserved_nano_usd,reserved_input_tokens,output_limit,status,created)
    VALUES(?,'owner',1,?,?,'plano_comercial',?,100,1200,'completed',?)`);
  for(const [i,cost] of [10e9,6e9,4e9].entries()) insert.run(String(i),new Date().toISOString().slice(0,7),productionAIModel,cost,now());
  assert.deepEqual((await productionAIStatus(s.env,'owner')).budget!.alerts.map(v=>v.thresholdUsd),[10,16,20]);
  await assert.rejects(s.reserve(),failsWith(429));
  assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM ai_production_alerts').get()!.n,3);
});
test('insufficient remainder blocks before fetch and records a blocked-budget notification',async t=>{
  const s=setup();t.after(()=>s.sql.close());s.sql.exec('UPDATE ai_production_policy SET credit_ceiling_nano_usd=1');
  const mocked=t.mock.method(globalThis,'fetch',async()=>Response.json({}));
  await assert.rejects(interpret(s.env,model,'Como estamos?',filters,[],'owner'),failsWith(429));
  assert.equal(mocked.mock.callCount(),0);
  const alert=(await productionAIStatus(s.env,'owner')).budget!.alerts[0];assert.equal(alert.event,'budget_blocked');
});
test('tools, unpriced models and oversized context cannot introduce unreserved charges',async t=>{
  const s=setup();t.after(()=>s.sql.close());const body=JSON.parse(s.body());
  for(const patch of [{tools:[{type:'web_search'}]},{model:'other-model'},{max_output_tokens:5000},{store:true},{background:true}])
    await assert.rejects(reserveProductionAI(s.env,JSON.stringify({...body,...patch}),'plano_comercial','owner'),failsWith(503));
  await assert.rejects(reserveProductionAI(s.env,JSON.stringify({...body,input:'x'.repeat(150000)}),'plano_comercial','owner'),failsWith(413));
});
test('controlled functional interpretation and grounded narrative account both calls without real API use',async t=>{
  const s=setup();t.after(()=>s.sql.close());let calls=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');const req=JSON.parse(String(init?.body));
    assert.equal(req.store,false);assert.equal(new Headers(init?.headers).get('OpenAI-Project'),'proj_synthetic');
    const text=calls++===0?{supported:true,reason:'',inheritContext:false,...plan}: {summary:'Faturamento líquido de R$ 120,00 ante R$ 100,00.',actions:[]};
    return Response.json({...good,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(text)}]}]});
  });
  assert.deepEqual(await interpret(s.env,model,'Como estamos?',filters,[],'owner'),plan);
  const values=Object.fromEntries(metricKeys.map(k=>[k,{current:k==='revenue'?120:null,previous:k==='revenue'?100:null}])) as Row['values'];
  const report:Report={total:{name:'Total',values},rows:[],plan,source:'Teste sintético',asOf:new Date().toISOString(),truncated:false};
  const result=await comment(s.env,'Como estamos?',report,'owner');assert.match(result.summary,/120/);assert.equal(calls,2);
  const ledger=s.sql.prepare('SELECT COUNT(*) n,SUM(input_tokens) input,SUM(output_tokens) output,SUM(usage_upper_nano_usd) cost FROM ai_production_attempts').get()!;
  assert.equal(ledger.n,2);assert.equal(ledger.input,200);assert.equal(ledger.output,80);assert.equal(ledger.cost,208000);
  assert.doesNotMatch(JSON.stringify(s.sql.prepare('SELECT * FROM ai_production_attempts').all()),/Como estamos|Faturamento|test-only/);
});
test('billing exhaustion disables subsequent calls and stores only allowlisted diagnostics',async t=>{
  const s=setup();t.after(()=>s.sql.close());
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'credit_balance_exhausted',message:'PRIVATE_DO_NOT_STORE'}},{status:429}));
  await assert.rejects(interpret(s.env,model,'Como estamos?',filters,[],'owner'),failsWith(429));
  assert.equal((await productionAIStatus(s.env,'owner')).reason,'policy_disabled');
  assert.doesNotMatch(JSON.stringify(s.sql.prepare('SELECT * FROM ai_production_attempts').all()),/PRIVATE_DO_NOT_STORE/);
});
test('API authorizes active commercial users, hides financial details from non-owners and denies operators',async t=>{
  const s=setup();t.after(()=>s.sql.close());const mocked=t.mock.method(globalThis,'fetch',async()=>{throw Error('no outbound');});
  s.sql.prepare("INSERT INTO users(id,email,name,password,role,created,update_only) VALUES('op','op@synthetic.test','op','unused','comercial',?,1)").run(now());
  for(const actor of ['owner','other-admin','sales','op']){
    const token=crypto.randomUUID().replaceAll('-','').repeat(2);
    s.sql.prepare('INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,?,?)').run(await digest(token),actor,now()+600,now());
    async function request(path:string,method='GET',payload?:unknown){
      return worker.fetch(new Request(s.env.APP_ORIGIN+'/api/'+path,{method,headers:{Origin:s.env.APP_ORIGIN,Cookie:'__Host-ci='+token,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined}),s.env,{waitUntil(){}} as unknown as ExecutionContext);
    }
    if(actor==='op'){
      assert.equal((await request('chat','POST',{question:'Como estamos?',filters,conversation:null})).status,403);
      continue;
    }
    const status=await (await request('assistant/status')).json() as {ready:boolean;budget?:unknown};
    assert.equal(status.ready,true);
    assert.equal(Boolean(status.budget),actor==='owner');
  }
  assert.equal(mocked.mock.callCount(),0);
});
