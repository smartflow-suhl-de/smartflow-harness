import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseSkill, renderSkill, discoverSkills } from "../src/skills/loader.ts";
import { createCompleter } from "../src/ui/commands.ts";

test("parseSkill extracts frontmatter and body", () => {
  const md = `---
name: pr-review
description: Review a pull request for bugs and security
args: [pr-number]
mode: plan
---
You are a senior reviewer.
Please review the changes in PR $ARGUMENTS.
`;

  const skill = parseSkill(md, "/path/to/pr-review.md", "project");
  assert.ok(skill);
  assert.equal(skill.name, "pr-review");
  assert.equal(skill.description, "Review a pull request for bugs and security");
  assert.equal(skill.args, "[pr-number]");
  assert.equal(skill.mode, "plan");
  assert.ok(skill.body.startsWith("You are a senior reviewer."));
});

test("parseSkill falls back to filename when frontmatter is missing name", () => {
  const md = "Just a raw prompt without YAML frontmatter.";
  const skill = parseSkill(md, "/path/to/my-helper.md", "user");
  assert.ok(skill);
  assert.equal(skill.name, "my-helper");
  assert.equal(skill.body, md);
  assert.equal(skill.origin, "user");
});

test("renderSkill substitutes $ARGUMENTS and positional variables", () => {
  const skillA = {
    name: "commit",
    description: "make a commit",
    body: "git commit -m \"$ARGUMENTS\"",
    path: "/test/commit.md",
    origin: "project" as const,
  };
  assert.equal(renderSkill(skillA, "feat: new feature"), "git commit -m \"feat: new feature\"");

  const skillB = {
    name: "compare",
    description: "compare two branches",
    body: "git diff $1...$2",
    path: "/test/compare.md",
    origin: "project" as const,
  };
  assert.equal(renderSkill(skillB, "main feature-x"), "git diff main...feature-x\n\nArguments:\nmain feature-x");
});

test("discoverSkills finds skills in project .skills directory", async () => {
  const tempDir = join(process.cwd(), "temp-skills-test-" + Date.now());
  const skillsDir = join(tempDir, ".skills");
  await mkdir(skillsDir, { recursive: true });

  const skillFile = join(skillsDir, "test-skill.md");
  await writeFile(skillFile, "---\nname: test-skill\ndescription: Test skill description\n---\nHello Skill", "utf8");

  try {
    const skills = await discoverSkills(tempDir);
    assert.ok(skills.some((s) => s.name === "test-skill"));
    const found = skills.find((s) => s.name === "test-skill")!;
    assert.equal(found.description, "Test skill description");
    assert.equal(found.origin, "project");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createCompleter includes skills in slash-command completions", () => {
  const dummySkill = {
    name: "release",
    description: "Prepare and tag a new release",
    args: "[version]",
    body: "release instructions",
    path: "/skills/release.md",
    origin: "project" as const,
  };

  const completer = createCompleter({
    providers: () => ["openai"],
    skills: () => [dummySkill],
  });

  const completions = completer.complete("/rel", 4);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]!.label, "/release");
  assert.equal(completions[0]!.hint, "[version] · Prepare and tag a new release");
});
