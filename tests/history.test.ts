import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyPath, loadHistory, pushHistory, saveHistory } from "../src/ui/history.ts";

async function home() {
  const dir = await mkdtemp(join(tmpdir(), "harness-hist-"));
  return {
    env: { HARNESS_HOME: dir } as NodeJS.ProcessEnv,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("history round-trips, including multi-line entries", async () => {
  const h = await home();
  try {
    await saveHistory(["one", "two\nlines", "/mode plan"], h.env);
    assert.deepEqual(await loadHistory(h.env), ["one", "two\nlines", "/mode plan"]);
  } finally {
    await h.cleanup();
  }
});

test("missing history is an empty list, not an error", async () => {
  const h = await home();
  try {
    assert.deepEqual(await loadHistory(h.env), []);
  } finally {
    await h.cleanup();
  }
});

test("a torn line does not discard the rest of the history", async () => {
  const h = await home();
  try {
    await writeFile(historyPath(h.env), '"first"\n{broken\n"third"\n');
    assert.deepEqual(await loadHistory(h.env), ["first", "third"]);
  } finally {
    await h.cleanup();
  }
});

test("pushHistory skips blanks and consecutive duplicates", () => {
  const entries: string[] = [];
  pushHistory(entries, "a");
  pushHistory(entries, "a");
  pushHistory(entries, "   ");
  pushHistory(entries, "b");
  assert.deepEqual(entries, ["a", "b"]);
});

test("history is capped", async () => {
  const h = await home();
  try {
    const many = Array.from({ length: 700 }, (_, i) => `line ${i}`);
    await saveHistory(many, h.env);
    const loaded = await loadHistory(h.env);
    assert.equal(loaded.length, 500);
    assert.equal(loaded[loaded.length - 1], "line 699");
    const raw = await readFile(historyPath(h.env), "utf8");
    assert.ok(raw.length < 20_000);
  } finally {
    await h.cleanup();
  }
});
