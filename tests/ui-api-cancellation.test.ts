import test from "node:test";
import assert from "node:assert/strict";
import { api, isAbortError } from "../src/ui";

test("UI API preserves fetch cancellation instead of reporting a connection failure", async () => {
  const original = globalThis.fetch, controller = new AbortController(); controller.abort();
  globalThis.fetch = (async () => { throw controller.signal.reason; }) as typeof fetch;
  try { await assert.rejects(api("data/options", "POST", {}, controller.signal), isAbortError); }
  finally { globalThis.fetch = original; }
});

test("UI API preserves cancellation while decoding a response body", async () => {
  const original = globalThis.fetch, controller = new AbortController();
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { controller.abort(); throw controller.signal.reason; } })) as unknown as typeof fetch;
  try { await assert.rejects(api("data/options", "POST", {}, controller.signal), isAbortError); }
  finally { globalThis.fetch = original; }
});
