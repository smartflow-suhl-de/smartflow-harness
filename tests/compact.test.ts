import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/context/compact.ts";
import type { Message } from "../src/core/types.ts";

test("token estimate grows with content", () => {
  const small: Message[] = [{ role: "user", content: "hi" }];
  const large: Message[] = [{ role: "user", content: "x".repeat(3600) }];
  assert.ok(estimateTokens(large) > estimateTokens(small));
  assert.equal(estimateTokens(large, 3.6), 1000 + Math.ceil(8 / 3.6));
});

test("tool call arguments count toward the budget", () => {
  const withCall: Message[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "bash", args: {}, rawArgs: "y".repeat(1000) }],
    },
  ];
  assert.ok(estimateTokens(withCall) > 250);
});
