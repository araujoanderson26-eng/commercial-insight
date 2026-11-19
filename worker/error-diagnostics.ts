export type WorkerErrorDiagnostic = "io_context_mismatch" | "d1_busy" | "d1_timeout" | "d1_memory"
  | "d1_response_size" | "d1_rate_limit" | "d1_sql_error" | "d1_internal" | "d1_unclassified" | "unknown";
export type WorkerErrorDiagnosticDetail = "resource_window" | "queue_timeout" | "pending_queue" | "overloaded"
  | "too_many_requests" | "http_429" | "read_quota" | "write_quota" | "daily_quota" | "rate_limit" | "unknown";

function diagnosticText(error: unknown) {
  const parts: string[] = [], seen = new WeakSet<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (typeof current === "string") { parts.push(current.slice(0,8192)); break; }
    if (typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    try {
      for (const key of ["message","name"]) {
        const value = Object.getOwnPropertyDescriptor(current,key)?.value;
        if (typeof value === "string") parts.push(value.slice(0,8192));
      }
      current = Object.getOwnPropertyDescriptor(current,"cause")?.value;
    } catch { break; }
  }
  return parts.join("\n");
}

/** Returns only a fixed category. Messages/SQL/stacks/values never leave this module. */
export function classifyWorkerError(error: unknown): WorkerErrorDiagnostic {
  const text = diagnosticText(error);
  if (/cannot perform i\/o on behalf of a different request|i\/o objects?[^\n]{0,180}different request|different request(?:'s)? (?:i\/o )?context/i.test(text)) return "io_context_mismatch";
  if (!/\bD1(?:_ERROR|_EXEC_ERROR|_TYPE_ERROR|Error|Exception)?\b|SQLITE_/i.test(text)) return "unknown";
  if (/SQLITE_(?:BUSY|LOCKED)|database (?:is )?(?:busy|locked)/i.test(text)) return "d1_busy";
  if (/timed? out|timeout|exceeded[^\n]{0,60}(?:time|duration)/i.test(text)) return "d1_timeout";
  if (/SQLITE_NOMEM|out of memory|memory[^\n]{0,40}(?:limit|exhaust|allocat)/i.test(text)) return "d1_memory";
  if (/SQLITE_TOOBIG|response[^\n]{0,50}(?:too large|size[^\n]{0,30}limit)|results?[^\n]{0,30}too large/i.test(text)) return "d1_response_size";
  if (/\b429\b|rate.?limit|too many requests|overloaded|too many[^\n]{0,30}pending/i.test(text)) return "d1_rate_limit";
  if (/SQLITE_(?:ERROR|RANGE|CONSTRAINT|MISMATCH|SCHEMA|MISUSE)|syntax error|no such (?:table|column)|ambiguous column|too many (?:sql variables|terms in compound select|columns)|bind[^\n]{0,40}parameter/i.test(text)) return "d1_sql_error";
  if (/internal (?:error|failure|server error)|\b7500\b/i.test(text)) return "d1_internal";
  return "d1_unclassified";
}

/** Distinguish transient database pressure from an explicit quota error without returning its text. */
export function classifyWorkerErrorDetail(error: unknown): WorkerErrorDiagnosticDetail {
  const text=diagnosticText(error);
  if (!/\bD1(?:_ERROR|_EXEC_ERROR|_TYPE_ERROR|Error|Exception)?\b|SQLITE_/i.test(text)) return "unknown";
  if (/too many resources consumed within (?:a )?10 second window/i.test(text)) return "resource_window";
  if (/requests? queued for too long/i.test(text)) return "queue_timeout";
  if (/too many requests queued|too many[^\n]{0,30}pending|pending[^\n]{0,30}(?:limit|full)|queue[^\n]{0,30}(?:full|capacity)/i.test(text)) return "pending_queue";
  if (/(?:rows? read|read)[^\n]{0,50}(?:quota|limit)|(?:quota|limit)[^\n]{0,50}rows? read/i.test(text)) return "read_quota";
  if (/(?:rows? written|write)[^\n]{0,50}(?:quota|limit)|(?:quota|limit)[^\n]{0,50}rows? written/i.test(text)) return "write_quota";
  if (/daily[^\n]{0,60}(?:quota|limit)/i.test(text)) return "daily_quota";
  if (/\boverloaded\b/i.test(text)) return "overloaded";
  if (/too many requests/i.test(text)) return "too_many_requests";
  if (/\b429\b/i.test(text)) return "http_429";
  if (/rate.?limit/i.test(text)) return "rate_limit";
  return "unknown";
}
