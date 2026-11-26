# harness — project instructions

This repo is a from-scratch coding-agent harness in TypeScript, run directly by
Node (type stripping, no build step).

## Rules

- No agent frameworks (LangChain, LangGraph, AutoGen, CrewAI, LlamaIndex,
  Pydantic AI, ADK). Raw SDK/fetch calls only.
- No RAG/embeddings over code. Use ripgrep, glob, LSP.
- Add no new tool unless a concrete failure mode motivates it. Order of
  preference: bash → read/write → grep/glob → search_replace.
- Keep the loop linear. Turn policies (limits, compaction, warnings) are small
  functions called from `src/core/loop.ts`, not classes.
- Permissions and safety rules are data (JSON / regex lists), never imperative
  branches scattered through tools.
- Every behaviour change needs a test in `tests/`. Run `npm test` and
  `npm run typecheck` before finishing.
- No new dependency without recording why in `docs/RESEARCH.md`.

## Layout

- `src/core` — loop, messages, session, prompt
- `src/provider` — model adapters (OpenAI-compatible only, for now)
- `src/tools` — tool implementations + registry
- `src/context` — context files, compaction
- `src/safety` — permission engine
- `src/config` — config loading (env > harness.json > defaults)

## Style

- TypeScript strict, `verbatimModuleSyntax`, explicit `.ts` imports.
- No `any`. Prefer narrow types and discriminated unions.
- Small files. One responsibility per module.
- Errors returned to the model must be actionable: say what failed and what to
  do instead.
