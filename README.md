# harness

Ein eigener Coding-Agent-Harness. Klein, lesbar, ohne Framework.

```bash
npm install
npm link                     # einmalig: macht `harness` global verfügbar

harness init                 # Projekt einrichten: harness.json + AGENTS.md
harness                      # interaktiv, startet auch ohne Key
harness "fix the failing test in tests/"
```

Ohne `npm link` gehen dieselben Befehle über `npm start --`:

```bash
npm start -- init
npm start
npm start -- "fix the failing test in tests/"
```

Im Prompt richtet `/connect` den Provider ein (Key, Test, speichern).

```bash
harness --plan              # read-only (Plan-Modus)
harness --yolo              # keine Rückfragen (Hardline-Floor bleibt)
harness --provider local    # anderes Profil
harness --list-providers    # verfügbare Provider
harness --config            # aufgelöste Konfiguration

npm test                     # 170 Tests (baut vorher)
npm run typecheck            # tsc --noEmit
npm run build                # dist/ für den harness-Bin
```

## Was drin ist

| Subsystem | Datei | Stand |
|---|---|---|
| Agent-Loop | `src/core/loop.ts` | linear, Stuck-Detection, Abbruch |
| Provider | `src/provider/openai.ts` | OpenAI-kompatibel (OpenAI, OpenRouter, Groq, Ollama, vLLM …) |
| Tools | `src/tools/` | bash, read, write, edit, glob, grep |
| Kontext | `src/context/` | `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` hierarchisch, Threshold-Compaction |
| Safety | `src/safety/permissions.ts` | plan/default/yolo, Regeln als JSON, Hardline-Floor |
| Sandbox | `src/safety/sandbox.ts` | bash in bubblewrap: Schreiben nur im Workspace, kein Netz, ehrlicher Fallback |
| Audit-Log | `src/safety/audit.ts` | NDJSON, 0600, Argumente nur als Hash, Rotation bei 10 MiB |
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

## Projekt einrichten

`harness init` macht ein Repo bereit — in einem Durchlauf, ohne den Harness
vorher zu konfigurieren:

1. Provider wählen (bestehendes Profil, Preset oder eigener Endpoint inkl. Key-Test)
2. Modell aus der Liste des Endpoints (nummeriert, nicht getippt)
3. Permission-Modus (`default`, `plan`, `yolo`)
4. schreibt `harness.json` im Projekt, `AGENTS.md` und `.harness/` in `.gitignore`

```bash
harness init
harness init --provider ollama
```

Details:

- **`AGENTS.md`** wird aus dem erkannten Stack gefüllt: `package.json`-Skripte
  mit erkanntem Package-Manager (`pnpm`/`npm`), sonst `pytest`, `cargo`, `go test`.
  Eine vorhandene Datei wird **nie** überschrieben.
- **`harness.json`** wird gemergt, nicht ersetzt — bestehende Regeln und
  Einstellungen bleiben. Der Key geht in den Credentials-Store, nicht in die Datei.
- **`.gitignore`** bekommt `.harness/`, ohne Duplikat; fehlt die Datei, wird sie
  angelegt.
- Abbruch (Ctrl+C) schreibt nichts.

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

### Günstige Tool-Modelle (Ollama, geprüft)

| Modell | Größe | Befund |
|---|---|---|
| `qwen3:0.6b` | 523 MB | **kleinstes, das Tools wirklich aufruft** (in diesem Harness verifiziert) |
| `qwen3:1.7b` | 1.4 GB | gleiche Familie, mehr Reserve |
| `qwen3:4b` | 2.5 GB | 256K Kontext, bester kleiner Tool-Caller |
| `gemma3:4b` | 3.3 GB | ✗ keine Tool-Capability (nur `completion`, `vision`) |
| `qwen2.5-coder:0.5b/1.5b` | 398 MB / 986 MB | ✗ meldet `tools`, schreibt den Aufruf aber als Text |

```bash
ollama pull qwen3:0.6b
/model            # listet Modelle, tool-fähige zuerst
```

`/model` markiert jetzt jede Zeile: `tools`, `no tools` oder `tool calls as text`
(aus Ollamas nativem `/api/show`). Beim Start, nach `/connect` und nach jeder
Wahl warnt der Harness, wenn das Modell nicht handeln kann — statt es erst beim
ersten 400er zu merken.

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

### Sandbox und Audit-Log

```json
{
  "sandbox": {
    "mode": "auto",
    "network": false,
    "writablePaths": ["/tmp/build-cache"]
  },
  "audit": { "path": "~/.config/harness/audit.jsonl", "disabled": false }
}
```

`mode` ist `auto` (Default: bwrap nutzen, wenn es läuft), `bwrap` (verlangt
Sandbox) oder `off`. In der Sandbox sind Systempfade read-only, der Workspace
und `writablePaths` beschreibbar, das Netz ist zu und `$HOME` zeigt auf `/tmp`.
In der Sandbox gilt eine feste `PATH`, ein leeres Environment (`--clearenv` — die
API-Keys des Hosts bleiben draußen) und der Workspace als einziger Schreibort;
`writablePaths` innerhalb von Systemverzeichnissen werden ignoriert.

Kann bwrap auf dem Host nicht starten (Container ohne Mount-Rechte), greift in
`auto` ein zweiter Backend: ein User-Namespace über `unshare(1)` isoliert Netz,
PIDs, IPC und das Environment — die Dateisicht bleibt geteilt, weil dafür
Mount-Rechte nötig wären. Ist auch das nicht möglich, läuft der Befehl
unsandboxed weiter, mit Grund in Ausgabe, Banner und Audit-Log. In `bwrap` wird
der Befehl stattdessen verweigert. `unshareFallback: false` schaltet den
zweiten Backend ab.

Das Audit-Log schreibt eine NDJSON-Zeile pro Tool-Aufruf (Entscheidung, Dauer,
Exit, Sandbox-Modus); Argumente stehen nur als SHA-256-Hash drin, Shell-Kommandos werden um Tokens
und Keys bereinigt. Env:
`HARNESS_SANDBOX=off`, `HARNESS_AUDIT=off`.

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
M7 ACP-Server · M8 OS-Sandbox + Audit-Log. Details in `docs/RESEARCH.md` §6.

## Lizenz

Apache-2.0 — siehe [LICENSE](LICENSE). Copyright 2026 SmartFlow Suhl.

Die Lizenz erlaubt kommerzielle Nutzung, Änderungen und Weitergabe, verlangt
den Copyright-Hinweis und enthält einen ausdrücklichen Patent-Grant. Sie ist
kompatibel mit dem Apache-2.0-Fork von OpenBot im selben Konto.
