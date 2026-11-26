import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installPipeGuards } from "../src/util/pipe.ts";

test("EPIPE exits quietly with 0", () => {
  const stream = new EventEmitter();
  const exits: number[] = [];
  installPipeGuards([stream], (code) => exits.push(code));

  stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.deepEqual(exits, [0]);
});

test("other stream errors are rethrown", () => {
  const stream = new EventEmitter();
  const exits: number[] = [];
  installPipeGuards([stream], (code) => exits.push(code));

  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  assert.throws(() => stream.emit("error", failure), /disk full/);
  assert.deepEqual(exits, []);
});

test("every stream gets guarded", () => {
  const one = new EventEmitter();
  const two = new EventEmitter();
  const exits: number[] = [];
  installPipeGuards([one, two], (code) => exits.push(code));

  two.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
  assert.deepEqual(exits, [0]);
});
