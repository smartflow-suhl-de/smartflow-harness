# Research: Einen eigenen Coding-Agent-Harness bauen

Stand: 26. November 2026. Quellen sind am Ende verlinkt; Zahlen stammen aus den
genannten Studien/Blogs und sind teils selbstreported.

---

## 1. Was ist ein Harness überhaupt?

> „Ein Agent ist ein Modell plus ein Harness: die Laufzeit, die ein LLM über
> einen Loop, Tools, Kontextverwaltung, Sicherheitskontrollen, Orchestrierung
> und Erweiterbarkeitsflächen mit der Welt verbindet.“

Der wichtigste Befund der aktuellen Literatur: **Der Harness, nicht das Modell,
entscheidet, ob ein Coding-Agent gut ist.** Die einschlägige Source-Code-Anatomie
von elf Produktionssystemen (arXiv 2609.00006) zeigt: Mini-SWE-Agent erreicht mit
~100 Zeilen und *einem* Bash-Tool auf SWE-bench Verified Vergleichbares wie
Systeme, die drei Größenordnungen mehr Code haben. Was die Großen unterscheidet,
ist nicht Task-Completion, sondern Sicherheit, Recovery, Kostenkontrolle,
Erweiterbarkeit und Plattform-Flächen.

**Konsequenz für uns:** klein anfangen, linearer Loop, ein Tool. Erst ausbauen,
wenn ein beobachteter Failure-Mode es erzwingt.

---

## 2. Die sieben kanonischen Subsysteme

Jedes der elf untersuchten Systeme (Claude Code, Codex CLI, Gemini CLI, Mistral
Vibe, OpenHands, Aider, Mini-SWE-Agent, Hermes, Pi, OpenCode, OpenClaw) nimmt zu
denselben sieben Subsystemen Stellung — auch wenn die Antwort „absichtlich nicht
vorhanden“ lautet.

| # | Subsystem | Aufgabe | Minimum (beobachtet) | Maximum (beobachtet) |
|---|-----------|---------|----------------------|----------------------|
| 1 | **Agent-Loop** | Inferenz ↔ Aktion, Stop-Bedingungen, Recovery | Mini-SWE-Agent: `while` über ein Bash-Tool | OpenHands: event-sourced Log, parallele Action-Batches |
| 2 | **LLM-Integration** | Provider-Protokolle, Prompt-Bau, Caching, Thinking, Routing | Mini-SWE-Agent: ein LiteLLM-Call, ein Template | Hermes: 5 eigene Transporte, 29 Provider-Profile |
| 3 | **Tools & Actions** | Was der Agent tun kann, v. a. Dateien editieren | Mini-SWE-Agent: nur bash | Claude Code: 43 typisierte Tools, deferred loading |
| 4 | **Memory & Kontext** | Kontextfenster rationieren, Wissen persistieren | Mini-SWE-Agent: unbegrenzte lineare History | Codex: agent-gepflegte Cross-Session-Memory-Pipeline |
| 5 | **Safety & Permissions** | Was läuft, was fragt, was ist verboten; Isolation | Mini-SWE-Agent: Kosten-/Step-Limits | Codex: Policy-Regeln + LLM-Approval-Reviewer + OS-Sandbox (3 Plattformen) |
| 6 | **Orchestrierung** | Sub-Agenten spawnen, andere Agenten anbinden | Aider: keine (bewusst single-agent) | Claude Code: rekursive Komposition; Omnigent: cross-vendor |
| 7 | **Extensibility** | Config, Hooks, Skills, Plugins, MCP | Mini-SWE-Agent: strukturelles Typing | Pi: everything-is-an-extension; Codex: Plugin-Marketplace |

Zwei Querschnittsflächen kommen dazu:

- **Interface-Layer**: TUI, CLI-Flags, IDE-Protokoll (ACP), HTTP-Server, SDK.
- **Session-Substrat**: Transkripte, Persistenz, Resume/Fork — von mehreren
  Subsystemen geteilt.

Unsere Ordnerstruktur bildet genau diese Achsen ab (`src/core`, `src/provider`,
`src/tools`, `src/context`, `src/safety`, `src/session`).

---

## 3. Was es schon gibt (Landschaft 2026)

### Open Source

| Projekt | Sprache/Lizenz | Profil | Für uns interessant wegen |
|---|---|---|---|
| **OpenCode** | TS, MIT | Provider-flexibel (75+), TUI/Desktop/IDE, LSP, MCP, Plan/Build-Agenten, Permissions | Nächstes Vorbild; TypeScript, gleiche Bauentscheidungen |
| **Codex CLI** | Rust, Apache-2.0 | OpenAI-nativ, OS-Sandbox (Seatbelt/Landlock/Windows), Approval-Modi, Starlark-Policy | Beste Safety-Architektur, `execpolicy` als Daten |
| **Gemini CLI** | TS, Apache-2.0 | PLAN/DEFAULT/YOLO, per-Mode-TOML, 50 %-Compaction | Einfachstes sauberes Permission-Modell |
| **Pi** | TS | Minimal, „everything is an extension“, JSONL-Erweiterungen | Beweis, dass Skills + CLI-Tools ohne MCP reichen |
| **Aider** | Python | Git-zentriert, atomare Commits, Repo-Map | Edit-Format `RelativeIndenter`, Git als Sicherheitsnetz |
| **Goose** | Rust | Block-basierte Extensions, MCP-first | Extension-Modell |
| **Cline / Kilo Code** | TS, Apache-2.0/MIT | VS-Code-Extension, Diff-Review | UI-Muster für Diffs |
| **OpenHands** | Python | Event-sourced SDK, StuckDetector, ACP-Backend | Event-Log-Architektur, Kondensation |
| **Mini-SWE-Agent** | Python | ~100 Zeilen, SWE-bench-tauglich | Existenzbeweis für die Untergrenze |
| **Mistral Vibe** | Python | Middleware-Pipeline pro Turn-Policy | Upgrade-Pfad, wenn Policies wachsen |
| **Hermes** | — | Provider-Profile, Skill-Quarantäne, SQLite-Blackboard | Trust-Tiers für Third-Party-Skills |

### Kommerziell / Closed

Claude Code (Anthropic), Cursor (Anysphere), GitHub Copilot CLI, ChatGPT Work —
relevant nicht als Code, sondern als **De-facto-Standards**: Hooks-Vokabular,
Subagent-Dateiformat (Markdown + Frontmatter), `AGENTS.md`, Skills, ACP.

### Was die Landschaft NICHT nutzt (und wir deshalb auch nicht)

Die Studie ist da ungewöhnlich eindeutig: **0 von 11 Produktions-Harnessen**
benutzen LangChain, LangGraph, AutoGen, CrewAI, LlamaIndex, Pydantic AI, Genkit,
Google ADK oder Semantic Kernel. Gemini CLI überspringt sogar Googles eigenes ADK.
Begründung (Anthropic, „Effective Agents“): Frameworks legen Abstraktionen über
Prompts und Responses, die Debugging erschweren. „Use raw SDK calls“ — oder, neu
2026, die Harness-SDKs selbst (Claude Agent SDK, `openai-codex`, `openhands-sdk`).

Ebenso: **0 von 11** bauen Vektor-Retrieval über Code. Code hat deterministische
Struktur (Pfade, LSP, tree-sitter), die sich minütlich ändert — Embeddings sind
sofort stale. Stattdessen: `ripgrep`, `glob`, tree-sitter, LSP-Diagnostics.

---

## 4. Die 18 Design-Empfehlungen (verdichtet)

Aus der Studie, gruppiert nach Subsystem. Das ist die eigentliche Checkliste.

### Loop
1. **Linearer `while`-Loop zuerst.** Middleware-Pipeline erst, wenn ≥3 orthogonale
   Turn-Policies existieren (Step-Limit, Kosten-Cap, Auto-Compaction,
   Kontext-Warnung, Read-only).
2. **Provider-Kopplung bewusst wählen.** Umsetzung: benannte Profile in
   `harness.json` mit `baseUrl`/`model`/`apiKeyEnv`/`headers`, Feld-für-Feld
   über Presets gelegt; Auswahl per `--provider`, `HARNESS_PROVIDER` oder
   `/provider` im REPL. Kein Code-Änderung für einen neuen Endpoint. Eigene Foundation → eng an Home-Provider,
   generischer Fallback-Adapter. Multi-Provider → per-Modell-Metadaten
   (Cache-Breakpoints, Thinking-Tiers, Reasoning-Effort) zentral pflegen.

### Tools
3. **Mit *nur* bash anfangen.** `read`/`write` erst, wenn Bash-Output-Truncation
   weh tut; `grep`/`glob`, wenn `find`/`rg` in bash unhandlich wird;
   `search_replace`, wenn Full-File-Writes Tokens verbrennen.
4. **Ab ~15 Tools deferred loading.** Claude Code spart ~40 % Initial-Prompt;
   Codex nutzt BM25-geranktes `tool_search`.
5. **Edit-Contract ans Modell-Tier anpassen.** Frontier: exakter
   Unique-Substring. Schwächere/offene Modelle: Fuzzy-Cascade. **Nie
   zeilenbasiert** — Modelle driften bei Zeilennummern stärker als bei Kontext.

### Memory & Kontext
6. **Hierarchische Markdown-Kontextdateien** auto-discovered (Projekt/User/
   Extension) — und die Konventionen der Nachbarn mitlesen (`AGENTS.md`,
   `CLAUDE.md`, `.cursorrules`, `CONTEXT.md`). Top-Level oben in den System-Prompt,
   verschachtelte just-in-time beim Tool-Zugriff.
7. **Threshold-Compaction** bei festem Puffer unter dem Fenster; verbatim Tail
   behalten; **Summary inkrementell mergen** statt neu zusammenfassen; dieselbe
   Routine reaktiv bei Overflow feuern.
8. **Kein RAG über Code.** ripgrep + glob + tree-sitter + LSP.

### Safety
9. **Dev-Tool (semi-trusted): drei Modi** PLAN/DEFAULT/YOLO + Permission-Scope-
   Patterns.
10. **Enterprise/shared/automated: OS-Sandbox** mit Policy-as-Code und Audit-Trail
    (bubblewrap/Landlock auf Linux, Seatbelt auf macOS).
11. **Regeln als Daten/Policy-Dateien**, nicht als imperativer Code. Und: YOLO
    braucht einen **Floor** (Hardline-Patterns, die auch `--yolo` nicht umgeht).

### Orchestrierung
12. **Single-Agent bleiben**, bis ein konkreter breadth-first-Explorationsschritt
    belegbar von paralleler Kontext-Isolation profitiert (Multi-Agent kostet ~15×
    Tokens).
13. **ACP-Server shippen.** Kein Editor-Feature mehr, sondern der Weg, vom Host
    und von Meta-Orchestratoren konsumiert zu werden. Sub-Agenten dagegen
    in-process.

### Extensibility
14. **Skills vor MCP.** Skills = Capability-Templates (Workflows, Prozeduren),
    MCP = externe Integrationen. Third-Party-Skills wie Pakete behandeln:
    Trust-Tiers, Scanning, Quarantäne.

### Anti-Patterns
15. Keine Agent-Frameworks (LangChain & Co.).
16. Kein Vektor-Retrieval für Code.
17. Keine 1:1-Wrapper um jede SaaS-API.
18. Stuck-Detection nicht überengineeren — aber die billigen Caps shippen
    (OpenCode: drei identische Calls → Permission-Ask).

---

## 5. Empfohlene Umsetzung für dieses Repo

**Stack:** TypeScript auf Node ≥24, **ohne Build-Step** (Node strippt Types
nativ seit 22.6/23.6, stabil in 24/26). Kein Bundler, kein Framework.
`node --test` für Tests, `tsc --noEmit` für Typecheck.

**Warum TS/Node:**
- Größtes Ökosystem für LLM-SDKs und MCP (`@modelcontextprotocol/sdk`).
- OpenCode (unser nächstes Vorbild) ist TS → direkt lesbarer Referenzcode.
- Node 26 läuft `.ts` direkt; der Edit-Run-Loop bleibt unter einer Sekunde.

**Warum nicht Rust/Go (vorerst):** Codex (Rust) und OpenDev (Rust) sind schneller
und sandbox-freundlicher, aber der Großteil der Iteration ist Prompt- und
Tool-Design. Das skaliert nicht mit Compile-Zeiten. Wenn später ein Single-Binary
oder echte OS-Sandbox nötig wird, ist der Loop klein genug zum Portieren.

### Bauentscheidungen (bewusst getroffen)

| Entscheidung | Wahl | Begründung |
|---|---|---|
| Loop | linear, eine Funktion | Empfehlung 1; Middleware später |
| Provider | **eine** OpenAI-kompatible Schicht | deckt OpenAI, OpenRouter, Groq, Mistral, Ollama, vLLM, LM Studio ab |
| Provider-Auswahl | **Profile als Daten** (`providers` in `harness.json`) | neuer Endpoint = neuer JSON-Block; Secrets per `apiKeyEnv`, nie in der Datei |
| UI | **Ink 8 + React 19** statt eigenem Renderer | Claude Code, Gemini CLI und Copilot CLI nutzen Ink; Flexbox-Layout, `useInput`, `usePaste` und testbare Komponenten ersetzen ~700 Zeilen Eigenbau. Kosten: JSX braucht einen Transform, deshalb `tsx` (dev/start) und `tsc` → `dist/` für den Bin |
| Tool-lose Modelle | **einmaliger Retry ohne Tools + Hinweis** | Ollama-Modelle wie `gemma3:4b` lehnen `tools` mit 400 ab; statt jede Runde zu scheitern, läuft der Chat weiter — sichtbar degradiert statt still |
| Fehler-Übersetzung | **Provider-Fehler → Handlung** (`provider/errors.ts`) | 404 „model not found“ ist der häufigste Setup-Fehler; die Meldung nennt Modell, Endpoint-Hinweis und die verfügbaren Modelle statt eines JSON-Bodys |
| Setup-Fluss | **Start ohne Provider, `/connect` im REPL** | ein Harness, der ohne Key aussteigt, ist unbenutzbar; Setup gehört in die Laufzeit, nicht in einen Preflight |
| Tools | bash, read, write, edit, glob, grep | Empfehlung 3, in der beobachteten Reihenfolge |
| Edit | exakt → whitespace-tolerant Cascade | Empfehlung 5; nie zeilenbasiert |
| Kontext | `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` hierarchisch | Empfehlung 6 |
| Compaction | 72 % Threshold, 12 Messages Tail, Merge | Empfehlung 7 |
| Permissions | plan/default/yolo + Regeln als JSON, last-match-wins | Empfehlungen 9 & 11 |
| Hardline-Floor | Regex-Liste, auch in yolo aktiv | Empfehlung 11 |
| Sessions | append-only JSONL | crash-sicher, greppbar, forkbar |
| Stuck-Detection | 3 identische Calls → Stop | Empfehlung 18 |
| Kein RAG, kein Framework | — | Empfehlungen 8, 15, 16 |

### Was NICHT in v0.1 steckt (bewusst)

LSP-Diagnostics, MCP-Client, ACP-Server, Skills, Sub-Agenten, tree-sitter,
OS-Sandbox, TUI, Diff-Preview. Alles davon ist in der Roadmap, aber jedes
davon ist erst dann dran, wenn ein beobachteter Failure-Mode es verlangt.

---

## 6. Der realistische Ausbaupfad

```
M0  Loop + bash + read/write/edit              ← hier stehen wir
M1  Kontextdateien, Compaction, Sessions       ← hier stehen wir
M2  Permissions, Regeln, Hardline, Stuck       ← hier stehen wir
M3  LSP-Diagnostics nach Edits, Diff-Review
M4  MCP-Client (externe Tools), Tool-Suche bei >15 Tools
M5  Skills (Markdown + Frontmatter), Slash-Commands
M6  Sub-Agenten (in-process, eigener Kontext)
M7  ACP-Server (Zed/JetBrains), Headless-JSON-Modus
M8  OS-Sandbox (bubblewrap/Landlock), Audit-Log
```

Jeder Meilenstein ist einzeln nützlich und einzeln testbar. Keiner blockiert den
vorherigen.

---

## Quellen

- Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents —
  arXiv 2609.00006 (Source-Code-Studie über 11 Systeme, 18 Empfehlungen)
- Building Effective AI Coding Agents for the Terminal — arXiv 2603.05344
- Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems —
  arXiv 2604.14228
- Anthropic, *Effective Agents* / *Building Effective Agents* (Loop- und
  Framework-Kritik)
- OpenCode Docs & Architektur-Analysen (opencode.ai/docs, dpsm.github.io/agent-harness-anatomy/opencode)
- Claude Code Docs: Hooks, Subagents, Skills, Context Window, Agent Loop
- OpenAI, *Inside the Codex sandbox*; Codex `execpolicy`
- Agent Client Protocol — agentclientprotocol.com
- MCP TypeScript SDK — github.com/modelcontextprotocol/typescript-sdk
- Node.js Docs, *Modules: TypeScript* (Type Stripping)
