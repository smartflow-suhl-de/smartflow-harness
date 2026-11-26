# harness

Ein eigener Coding-Agent-Harness. Klein, lesbar, ohne Framework.

```bash
export HARNESS_API_KEY=sk-...
export HARNESS_MODEL=gpt-4.1-mini      # oder claude-sonnet-4-6 via Gateway
node src/cli.ts "fix the failing test in tests/"
```

```bash
node src/cli.ts            # interaktiv
node src/cli.ts --plan     # read-only (Plan-Modus)
node src/cli.ts --yolo     # keine Rückfragen (Hardline-Floor bleibt)
npm test                   # 17 Tests, node --test
npm run typecheck          # tsc --noEmit
```

Kein Build-Step: Node ≥24 führt `.ts` direkt aus (Type Stripping).

## Was drin ist

| Subsystem | Datei | Stand |
|---|---|---|
| Agent-Loop | `src/core/loop.ts` | linear, Stuck-Detection, Abbruch |
| Provider | `src/provider/openai.ts` | OpenAI-kompatibel (OpenAI, OpenRouter, Groq, Ollama, vLLM …) |
| Tools | `src/tools/` | bash, read, write, edit, glob, grep |
| Kontext | `src/context/` | `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` hierarchisch, Threshold-Compaction |
| Safety | `src/safety/permissions.ts` | plan/default/yolo, Regeln als JSON, Hardline-Floor |
| Sessions | `src/core/session.ts` | append-only JSONL, resume |
| CLI | `src/cli.ts` | REPL + one-shot |

## Warum so gebaut

Die Entscheidungen sind in [`docs/RESEARCH.md`](docs/RESEARCH.md) begründet —
mit Quellen. Kurzfassung:

- **Linearer Loop, ein Tool zuerst.** Mini-SWE-Agent zeigt: ~100 Zeilen reichen
  für SWE-bench-Niveau. Ausbau nur bei beobachtetem Failure-Mode.
- **Eine OpenAI-kompatible Provider-Schicht.** Deckt fast alle Provider ab, ein
  Adapter statt N.
- **Kein RAG über Code.** ripgrep + glob + LSP; Embeddings sind bei Code sofort
  stale.
- **Keine Agent-Frameworks.** 0 von 11 Produktions-Harnessen nutzen LangChain &
  Co. Rohe SDK-Calls, damit Prompts debuggbar bleiben.
- **Permissions als Daten.** Regeln in `harness.json`, last-match-wins, plus
  Hardline-Patterns, die auch `--yolo` nicht umgeht.

## Konfiguration

`harness.json` im Workspace (geheimnisfrei, darf committed werden):

```json
{
  "model": "gpt-4.1-mini",
  "baseUrl": "https://openrouter.ai/api/v1",
  "contextWindow": 128000,
  "mode": "default",
  "maxSteps": 60,
  "rules": [
    { "tool": "bash", "pattern": "^git ", "action": "allow" },
    { "tool": "bash", "pattern": "^git push", "action": "ask" }
  ]
}
```

Secrets nur per Env: `HARNESS_API_KEY`, `HARNESS_BASE_URL`, `HARNESS_MODEL`,
`HARNESS_MODE`, `HARNESS_CONTEXT_WINDOW`, `HARNESS_MAX_STEPS`.

## Projektkontext

Lege eine `AGENTS.md` ins Repo — sie wird automatisch in den System-Prompt
geladen (auch `CLAUDE.md` und `CONTEXT.md`, von der Wurzel bis zum Workspace).

## Aufbau

```
src/
  cli.ts                 REPL, Argumente, Event-Rendering
  core/
    loop.ts              der Agent-Loop
    types.ts             Message, Tool, Event
    session.ts           JSONL-Transkript
    prompt.ts            System-Prompt
  provider/
    provider.ts          Interface
    openai.ts            Chat-Completions-Adapter
  tools/
    bash.ts read.ts write.ts edit.ts glob.ts grep.ts
    registry.ts          Tool-Registry + Definition-Helper
  context/
    files.ts             hierarchische Kontextdateien
    compact.ts           Threshold-Compaction
  safety/
    permissions.ts       Modi, Regeln, Hardline
  config/
    config.ts            Env > harness.json > Defaults
tests/                   node --test
docs/RESEARCH.md         Recherche + Begründungen
```

## Roadmap

M3 LSP-Diagnostics · M4 MCP-Client · M5 Skills · M6 Sub-Agenten ·
M7 ACP-Server · M8 OS-Sandbox. Details in `docs/RESEARCH.md` §6.
