import test from "node:test";
import assert from "node:assert/strict";
import { classifyWorkerError, classifyWorkerErrorDetail } from "../worker/error-diagnostics";
import worker from "../worker/index";
import { makeStore } from "./fixtures";

test("diagnóstico retorna somente enums conhecidos sem SQL, valores ou credenciais",()=>{
  const examples: [string,string][] = [
    ["Cannot perform I/O on behalf of a different request.","io_context_mismatch"],
    ["D1_ERROR: database is locked: SQLITE_BUSY","d1_busy"], ["D1_ERROR: request timed out","d1_timeout"],
    ["D1_ERROR: out of memory: SQLITE_NOMEM","d1_memory"], ["D1_ERROR: response size exceeded limit","d1_response_size"],
    ["D1_ERROR: 429 overloaded","d1_rate_limit"], ["D1_ERROR: no such column: secret: SQLITE_ERROR","d1_sql_error"],
    ["D1_ERROR: internal error 7500","d1_internal"], ["D1_ERROR: unknown condition","d1_unclassified"], ["Other condition","unknown"],
  ];
  for (const [message,expected] of examples) {
    const result=classifyWorkerError(new Error(message+" SELECT private_name WHERE token='PRIVATE_CREDENTIAL'"));
    assert.equal(result,expected);assert.doesNotMatch(result,/SELECT|private_name|PRIVATE_CREDENTIAL/);
  }
});

test("causas aninhadas priorizam erro de contexto I/O sobre envelope D1",()=>{
  assert.equal(classifyWorkerError(new Error("D1_ERROR: internal error",{cause:new Error("Cannot perform I/O on behalf of a different request.")})),"io_context_mismatch");
});

test("detalhe separa pressão de recursos/filas, HTTP429 e cotas explícitas sem retornar mensagens",()=>{
  const examples:[string,string][]=[
    ["overloaded; too many resources consumed within a 10 second window","resource_window"],
    ["overloaded; requests queued for too long","queue_timeout"],
    ["overloaded; too many requests queued","pending_queue"],
    ["overloaded","overloaded"],["too many requests","too_many_requests"],["HTTP 429","http_429"],
    ["free tier daily row read limit","read_quota"],["daily row write limit","write_quota"],
    ["daily quota exceeded","daily_quota"],["rate limit reached","rate_limit"],["unrecognized condition","unknown"],
  ];
  for(const [message,expected] of examples){
    const error=new Error("Outer",{cause:new Error("D1_ERROR: "+message+"; SQL PRIVATE_CREDENTIAL")});
    const actual=classifyWorkerErrorDetail(error);assert.equal(actual,expected);assert.doesNotMatch(actual,/SQL|PRIVATE_CREDENTIAL|overloaded;/);
  }
  assert.equal(classifyWorkerErrorDetail(new Error("daily quota exceeded outside D1")),"daily_quota");
  assert.equal(classifyWorkerErrorDetail(new Error("quota exceeded without a database marker")),"unknown");
});

test("cause circular e getters são tratados sem execução ou loop",()=>{
  const cycle=new Error("D1_ERROR: other");cycle.cause=cycle;
  assert.equal(classifyWorkerError(cycle),"d1_unclassified");
  let reads=0;const getter=Object.defineProperty({},"message",{get(){reads++;throw Error("Do not run");}});
  assert.equal(classifyWorkerError(getter),"unknown");assert.equal(reads,0);
});

test("profundidade máxima oito e entradas nãoError permanecem seguras",()=>{
  let nested:Error=new Error("D1_ERROR: SQL error: SQLITE_ERROR");for(let i=0;i<8;i++)nested=new Error("Envelope",{cause:nested});
  assert.equal(classifyWorkerError(nested),"unknown");
  for(const value of [null,123,{},true])assert.equal(classifyWorkerError(value),"unknown");
});

test("header está restrito à HML real exata e preserva corpo genérico e produção",async t=>{
  const {env,sql}=makeStore();t.after(()=>sql.close());t.mock.method(console,"error",()=>{});
  env.DB.prepare=()=>{throw new Error("D1_ERROR: no such column: PRIVATE_CREDENTIAL: SQLITE_ERROR");};
  const ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
  for(const [origin,authorization,expected] of [
    ["https://commercial-insight-hml.araujo-anderson26.workers.dev","present","d1_sql_error"],
    ["https://commercial-insight-hml.araujo-anderson26.workers.dev",undefined,null],
    ["https://production.example.test","present",null],
  ] as const){
    env.APP_ORIGIN=origin;env.HML_REAL_DATA_AUTHORIZATION=authorization;
    const response=await worker.fetch(new Request(origin+"/api/me",{headers:{Cookie:"__Host-ci="+"a".repeat(64)}}),env,ctx);
    assert.equal(response.status,500);assert.equal(response.headers.get("X-Hml-Diagnostic"),expected);
    assert.equal(response.headers.get("X-Hml-Diagnostic-Detail"),expected===null?null:"unknown");
    assert.deepEqual(await response.json(),{error:"Não foi possível concluir a operação."});
    assert.doesNotMatch(JSON.stringify([...response.headers]),/PRIVATE_CREDENTIAL|SELECT/);
  }
});
