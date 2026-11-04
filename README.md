# Versuchsaufbau: Offene-Posten-Abgleich mit BANKSapi und KI-Assistenten

Für den Expertenartikel auf banksapi.de: Wie einfach baut ein KI-Assistent einer Buchhaltungssoftware
(„Kontor“, Branch `main`, Tag `baseline`) einen automatischen Offene-Posten-Abgleich mit BANKSapi?

## Läufe

| Branch                      | Werkzeug    | Modell            | Effort | Docs MCP |
| --------------------------- | ----------- | ----------------- | ------ | -------- |
| `run/opus-5.5-high-mcp`     | Claude Code | claude-opus-5-5   | high   | ja       |
| `run/opus-5.5-high-ohne-mcp`| Claude Code | claude-opus-5-5   | high   | nein     |
| `run/sonnet-5.5-high-mcp`   | Claude Code | claude-sonnet-5-5 | high   | ja       |
| `run/codex-<modell>-mcp`    | Codex CLI   | Codex-Standard    | high   | ja       |

Alle Läufe bekommen denselben Prompt (`prompt.txt`), einmalig und ohne Rückfragen. Hört ein Lauf vor einem
lauffähigen Stand auf, gibt es genau eine einheitliche Nachfrage: „Teste es und behebe Fehler.“

## Isolation

Jeder Lauf startet mit `./run.sh` in einem frischen Container (`docker/Dockerfile`):

- nur ein frischer Klon des Tags `baseline`, ohne Remote, ohne andere Branches
- leeres Home-Verzeichnis: keine CLAUDE.md/AGENTS.md, keine Memories, keine Plugins oder Skills vom Host
- keine Umgebungsvariablen vom Host, nur der Modell-Login und die Sandbox-Zugangsdaten in `/workspace/.env`
- MCP: ausschließlich `https://banksapi.io/docs-mcp` (`--strict-mcp-config`), im Kontrolllauf gar keiner
- Internet bleibt an (npm, BANKSapi-API); im Kontrolllauf darf das Modell also im Web suchen

Nachweis: Das `init`-Ereignis am Anfang jedes Transkripts listet Tools und MCP-Server. Die Testläufe
`smoke-*` zeigen, was ein frischer Container sieht.

## Bewertung (vor den Läufen festgelegt)

1. Läuft es? `npm install`, `npm test`, `npm run build`, Start ohne Fehler
2. Auth-Ablauf: Client-Token, Nutzer anlegen, User-Token, Tokens nur im Backend
3. Bankverbindung: WEB/Connect Web Component bzw. REG/Protect-Ablauf (451 + Callback) korrekt eingebunden
4. Abgleich: AI/Connect genutzt (Invoice Matching?), Vorschläge nachvollziehbar, Buchung erst nach Bestätigung oder ab sicherer Schwelle
5. Testfälle: exakte Referenz, nur Betrag, Teilzahlung, Sammelzahlung, Skonto, Tippfehler in der Referenz
6. Sicherheit: Zugangsdaten nicht im Frontend, nicht im Repo, nicht im Log
7. Aufwand: Dauer, Kosten/Tokens, Zahl der Nachfragen, Nutzung des Docs MCP

## Starten

```bash
export SECRETS_DIR=…            # claude-oauth.env, workspace.env
./run.sh opus-5.5-high-mcp claude claude-opus-5-5 mit high
./run.sh -f opus-5.5-high-mcp "Teste es und behebe Fehler."
```
