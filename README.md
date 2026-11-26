# harness

Ein eigener Coding-Agent-Harness. Klein, lesbar, ohne Framework.

```bash
npm start                    # startet immer — auch ohne Key
# oder nach dem Build:
npm run build && node dist/cli.js
```

Im Prompt: `/connect` richtet den Provider ein (Key, Test, speichern).

Danach läuft es ohne Neustart:

```bash
npm start -- "fix the failing test in tests/"
```

```bash
npm start                        # interaktiv: Tab-Menü, History
npm start -- --plan              # read-only (Plan-Modus)
npm start -- --yolo              # keine Rückfragen (Hardline-Floor bleibt)
npm start -- --provider local    # anderes Profil
npm start -- --list-providers    # verfügbare Provider
npm start -- --config            # aufgelöste Konfiguration
npm test                         # 79 Tests
npm run typecheck                # tsc --noEmit
npm run build                    # dist/ für den harness-Bin
```

Die UI ist [Ink](https://github.com/vadimdemedes/ink) (React fürs Terminal).
`npm start` führt die `.tsx` über `tsx` direkt aus; `npm run build` erzeugt
`dist/` für den installierbaren `harness`-Bin.

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
| UI | `src/ui/app.tsx`, `prompt-input.tsx` | Ink/React: Completion-Menü, History, Statuszeile |
| UI-Brücke | `src/ui/store.ts` | externer Store, den der Agent-Loop imperativ füttert |
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

Im REPL: `/connect ollama` richtet ein Profil ein und prüft dabei, ob das
Preset-Modell wirklich existiert.

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

Die Oberfläche ist eine Ink-App: Transkript im Scrollback (`<Static>`), darunter
Eingabe, Menü und Statuszeile. Der Agent-Loop bleibt imperativ und schiebt
Events in einen externen Store — React rendert nur.

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
`/model`) und Provider-Namen.

`/model` ohne Argument holt die Modellliste vom Endpoint (`GET /models`) und
öffnet eine Auswahl. Die Wahl wird dort gespeichert, wo das Modell herkommt:
im Projekt-`harness.json`, wenn es das Profil definiert, sonst in der
User-Config. Ein falsches Modell ist damit ein Zwei-Tasten-Fix.

Fehler kommen übersetzt an, nicht als roher JSON-Body:

```
error: ollama: model "qwen3-coder" is not available — model 'qwen3-coder' not found
  run /model to pick one from this endpoint
  available: llama3.2, qwen2.5-coder, mistral
```

### Modelle ohne Tool-Support

Kleine lokale Modelle (z. B. `gemma3:4b`) unterstützen teils keine Tool-Calls.
Der Harness merkt das am ersten 400er, wiederholt die Anfrage ohne Tools und
sagt einmal:

```
note: model "gemma3:4b" does not support tool calls — continuing without tools
      (no file edits or shell commands). Use /model to pick a tool-capable model.
```

Der Agent antwortet dann wie ein Chat-Assistent, ohne Dateien oder Shell — und
ohne jede Runde erneut zu scheitern. Das Menü öffnet mit `tab`, `↑`/`↓` bewegen die
Auswahl, `⏎` übernimmt. Die History liegt in
`~/.config/harness/history` (bzw. `$HARNESS_HOME/history`) und überlebt
Neustarts. Eingaben für Keys werden als `•` gerendert und nie gespeichert.

`ctrl+c` beendet sauber mit Exit-Code 0 — kein Stacktrace, auch mitten in
`/connect`. Läuft gerade ein Tool, bricht `ctrl+c` den Lauf ab.

Bei nicht-interaktiver Eingabe (Pipe, CI) fällt die UI auf zeilenbasierte
Ausgabe zurück, damit `printf '/exit\n' | harness` weiter funktioniert.

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
  ui/
    app.tsx              Ink-Wurzel: Static-Transkript, Prompt, Status
    prompt-input.tsx     Eingabezeile, Cursor, Completion-Menü
    store.ts             externer Store (useSyncExternalStore)
    connect.ts           /connect-Dialog
    plain-ui.ts          Fallback ohne TTY
  config/
    config.ts            Dateien laden/mergen, Env > Projekt > User
    providers.ts         Profile auflösen, Presets, Validierung
tests/                   node --test
docs/RESEARCH.md         Recherche + Begründungen
```

## Roadmap

M3 LSP-Diagnostics · M4 MCP-Client · M5 Skills · M6 Sub-Agenten ·
M7 ACP-Server · M8 OS-Sandbox. Details in `docs/RESEARCH.md` §6.
