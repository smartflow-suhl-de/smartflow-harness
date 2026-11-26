# harness

Ein eigener Coding-Agent-Harness. Klein, lesbar, ohne Framework.

```bash
node src/cli.ts              # startet immer — auch ohne Key
/connect                     # Provider einrichten: Key, Test, speichern
```

Danach läuft es ohne Neustart:

```bash
node src/cli.ts "fix the failing test in tests/"
```

```bash
node src/cli.ts                  # interaktiv: tab, history, menü
node src/cli.ts --plan           # read-only (Plan-Modus)
node src/cli.ts --yolo           # keine Rückfragen (Hardline-Floor bleibt)
node src/cli.ts --provider local # anderes Profil
node src/cli.ts --list-providers # verfügbare Provider
node src/cli.ts --config         # aufgelöste Konfiguration
npm test                         # 45 Tests, node --test
npm run typecheck                # tsc --noEmit
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
| Provider-Profile | `src/config/providers.ts` | Presets + eigene Endpoints, Env/Datei/CLI |
| `/connect` | `src/ui/connect.ts` | Provider einrichten ohne Neustart, Key-Test, Persistenz |
| Eingabe | `src/ui/` | Raw-Mode-Editor: Completion-Menü, History, Wort-/Zeilen-Tasten |
| CLI | `src/cli.ts` | REPL + one-shot |

## Warum so gebaut

Die Entscheidungen sind in [`docs/RESEARCH.md`](docs/RESEARCH.md) begründet —
mit Quellen. Kurzfassung:

- **Linearer Loop, ein Tool zuerst.** Mini-SWE-Agent zeigt: ~100 Zeilen reichen
  für SWE-bench-Niveau. Ausbau nur bei beobachtetem Failure-Mode.
- **Eine OpenAI-kompatible Provider-Schicht.** Deckt fast alle Provider ab, ein
  Adapter statt N. Provider sind Daten (Profile), nicht Code — neuer Endpoint
  heißt neuer JSON-Block, kein Build.
- **Kein RAG über Code.** ripgrep + glob + LSP; Embeddings sind bei Code sofort
  stale.
- **Keine Agent-Frameworks.** 0 von 11 Produktions-Harnessen nutzen LangChain &
  Co. Rohe SDK-Calls, damit Prompts debuggbar bleiben.
- **Permissions als Daten.** Regeln in `harness.json`, last-match-wins, plus
  Hardline-Patterns, die auch `--yolo` nicht umgeht.

## Provider

**Der Harness startet immer**, auch ohne Key. Fehlt einer, zeigt die Statuszeile
`not connected` und `/connect` richtet alles ein — ohne Neustart.

```
/connect                      # Provider wählen, Key eingeben, testen
/connect openrouter           # bekanntes Profil, fragt nur das Fehlende
/connect https://llm.x/v1 lokal   # eigener Endpoint mit Namen
```

`/connect` prüft den Endpoint per `GET /models` (kostenlos), listet die
verfügbaren Modelle und speichert:

- Profil in `~/.config/harness/harness.json` (oder `$HARNESS_HOME`)
- Key in `~/.config/harness/credentials.json`, Modus `0600`

Reihenfolge der Key-Quelle: `HARNESS_API_KEY` > `apiKeyEnv`-Variable >
Credentials-Store > `apiKey` in der Datei. Lokale Endpoints brauchen keinen Key;
antworten sie mit 401, fragt `/connect` reaktiv nach.

Jeder OpenAI-kompatible Endpoint ist ein Profil — kein Code nötig.
Profile stehen in `harness.json`, entweder im Projekt oder global unter
`~/.config/harness/harness.json` (Projekt gewinnt, Feld für Feld).

```json
{
  "provider": "my-gateway",
  "providers": {
    "my-gateway": {
      "baseUrl": "https://llm.example.com/v1",
      "model": "qwen3-coder",
      "apiKeyEnv": "GATEWAY_API_KEY",
      "contextWindow": 131072,
      "headers": { "X-Org": "cabroe" }
    },
    "local": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "qwen3-coder",
      "contextWindow": 32768
    }
  }
}
```

```bash
node src/cli.ts --provider my-gateway "refactor src/tools"
HARNESS_PROVIDER=local node src/cli.ts      # oder per Env
```

Im REPL: `/provider` zeigt alle, `/provider local` wechselt live.

Eingebaute Presets (nur Defaults, überschreibbar): `openai`, `openrouter`,
`groq`, `mistral`, `ollama`, `lmstudio`.

Felder eines Profils:

| Feld | Bedeutung |
|---|---|
| `baseUrl` | OpenAI-kompatibler Endpoint (Pflicht) |
| `model` | Modell-ID beim Provider |
| `apiKeyEnv` | Env-Variable mit dem Key — **bevorzugt** |
| `apiKey` | Key inline (nur für Wegwerf-Setups) |
| `contextWindow` | Fenster in Tokens, steuert Compaction |
| `headers` | Extra-Header, z. B. Org oder Gateway-Routing |
| `description` | Freitext, erscheint in `--list-providers` |

Secrets bleiben aus der Datei: `apiKeyEnv` benennen, Key per Env setzen.
Lokale Endpoints (127.0.0.1/localhost) brauchen keinen Key.

### Auflösungsreihenfolge

1. `--provider` (CLI)
2. `HARNESS_*`-Env (`HARNESS_MODEL`, `HARNESS_BASE_URL`, `HARNESS_API_KEY`, `HARNESS_CONTEXT_WINDOW`)
3. `providers.<name>` in `harness.json`
4. eingebautes Preset
5. alte flache Felder (`model`, `baseUrl`) — bleiben gültig

### Manuell statt `/connect`

Profile lassen sich auch direkt schreiben — nützlich für Repos und CI:

```json
{
  "provider": "my-gateway",
  "providers": {
    "my-gateway": {
      "baseUrl": "https://llm.example.com/v1",
      "model": "qwen3-coder",
      "apiKeyEnv": "GATEWAY_API_KEY"
    }
  }
}
```

## Bedienung

Der Prompt ist ein echter Zeileneditor, kein `readline`-Fallback.

| Taste | Wirkung |
|---|---|
| `tab` / `shift+tab` | vervollständigen, im Menü blättern |
| `↑` / `↓` | History (oder im Menü navigieren) |
| `←` `→`, `ctrl+b` `ctrl+f` | Cursor zeichenweise |
| `alt+b` / `alt+f` | Cursor wortweise (auch `ctrl+←/→`) |
| `ctrl+a` / `ctrl+e`, `home` / `end` | Zeilenanfang / -ende |
| `ctrl+w` | Wort vor dem Cursor löschen |
| `ctrl+u` / `ctrl+k` | bis Anfang / Ende löschen |
| `ctrl+y` | zuletzt Gelöschtes einfügen |
| `ctrl+l` | Bildschirm leeren |
| `ctrl+j` | neue Zeile (mehrzeilig) |
| `ctrl+c` | Zeile leeren; auf leerer Zeile: beenden |
| `ctrl+d` | auf leerer Zeile: beenden |

Vervollständigt werden Slash-Befehle, deren Argumente (`/mode`, `/connect`,
`/model`) und Provider-Namen. Die History liegt in
`~/.config/harness/history` (bzw. `$HARNESS_HOME/history`) und überlebt
Neustarts. Eingaben für Keys werden als `•` gerendert und nie gespeichert.

`ctrl+c` beendet sauber mit Exit-Code 0 — kein Stacktrace, auch mitten in
`/connect`.

## Konfiguration

```json
{
  "mode": "default",
  "maxSteps": 60,
  "rules": [
    { "tool": "bash", "pattern": "^(ls|cat|git status)", "action": "allow" },
    { "tool": "bash", "pattern": "^git push", "action": "ask" }
  ]
}
```

Weitere Env-Variablen: `HARNESS_MODE`, `HARNESS_MAX_STEPS`.

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
    config.ts            Dateien laden/mergen, Env > Projekt > User
    providers.ts         Profile auflösen, Presets, Validierung
tests/                   node --test
docs/RESEARCH.md         Recherche + Begründungen
```

## Roadmap

M3 LSP-Diagnostics · M4 MCP-Client · M5 Skills · M6 Sub-Agenten ·
M7 ACP-Server · M8 OS-Sandbox. Details in `docs/RESEARCH.md` §6.
