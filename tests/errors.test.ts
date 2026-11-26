import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, explainProviderError } from "../src/provider/errors.ts";

function err(status: number, body: string) {
  return new ProviderError({ status, body, provider: "ollama", model: "qwen3-coder" });
}

test("a missing model names the model and suggests /model", () => {
  const friendly = explainProviderError(
    err(404, JSON.stringify({ error: { message: "model 'qwen3-coder' not found" } })),
  );
  assert.match(friendly.message, /model "qwen3-coder" is not available/);
  assert.match(friendly.message, /model 'qwen3-coder' not found/);
  assert.equal(friendly.hint, "run /model to pick one from this endpoint");
  assert.equal(friendly.suggestModels, true);
});

test("a 404 without a model hint points at baseUrl", () => {
  const friendly = explainProviderError(err(404, "not found"));
  assert.match(friendly.message, /endpoint not found/);
  assert.match(friendly.hint ?? "", /baseUrl/);
  assert.equal(friendly.suggestModels, false);
});

test("401 and 403 point at /connect", () => {
  for (const status of [401, 403]) {
    const friendly = explainProviderError(err(status, "unauthorized"));
    assert.match(friendly.message, /authentication failed/);
    assert.match(friendly.hint ?? "", /\/connect/);
  }
});

test("429 mentions rate limiting", () => {
  const friendly = explainProviderError(err(429, "slow down"));
  assert.match(friendly.message, /rate limited/);
});

test("server errors stay generic but readable", () => {
  const friendly = explainProviderError(err(503, "upstream down"));
  assert.match(friendly.message, /server error \(HTTP 503\)/);
  assert.match(friendly.message, /upstream down/);
});

test("network failures use status 0 wording", () => {
  const friendly = explainProviderError(err(0, "fetch failed"));
  assert.match(friendly.message, /cannot reach the endpoint/);
  assert.match(friendly.hint ?? "", /server running/);
});

test("non-provider errors pass through untouched", () => {
  const friendly = explainProviderError(new Error("boom"));
  assert.equal(friendly.message, "boom");
  assert.equal(friendly.suggestModels, false);
});

test("JSON bodies are unwrapped, not dumped raw", () => {
  const friendly = explainProviderError(
    err(400, JSON.stringify({ error: { message: "bad request", type: "invalid" } })),
  );
  assert.match(friendly.message, /bad request/);
  assert.doesNotMatch(friendly.message, /"type"/);
});

test("plain-text bodies are shown as a snippet", () => {
  const friendly = explainProviderError(err(400, "plain failure text"));
  assert.match(friendly.message, /plain failure text/);
});