import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const cliPath = resolve("./dist/cli.js");

test("CLI --help displays --acp and --json options", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.match(stdout, /--acp\s+run as an Agent Client Protocol \(ACP\) server on stdio/);
  assert.match(stdout, /--json\s+headless JSON output \(one event per line\)/);
});

test("CLI --json without prompt fails with exit code 1 and error message on stderr", async () => {
  try {
    await execFileAsync(process.execPath, [cliPath, "--json"]);
    assert.fail("Should have failed without prompt");
  } catch (err: any) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--json requires a prompt/);
  }
});
