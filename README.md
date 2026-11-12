# Kontor: bank reconciliation built by an AI assistant with BANKSapi

Kontor is a small demo accounting app with customers, invoices and open items (German UI).
In its starting state it has no bank connection: incoming payments are entered by hand.

We gave AI coding assistants a single prompt of three sentences and asked them to add automatic
reconciliation of open items with the incoming payments on the bank account, using BANKSapi.
This repository contains the starting point, the prompt, the harness and the result of every run.

Background article (German): [BANKSapi ist AI-ready: Offene-Posten-Abgleich per Prompt](https://banksapi.de/offene-posten-abgleich-ki-banksapi/)

## The prompt

> Unsere Buchhaltungssoftware soll offene Posten automatisch mit den Zahlungseingängen auf dem Bankkonto abgleichen.
> Setze das mit BANKSapi um: Bankverbindung über die WEB/Connect Web Components, Zuordnung der Zahlungen mit AI/Connect.
> Die Zugangsdaten für unseren BANKSapi-Testmandanten stehen in .env.

English: *"Our accounting software should automatically reconcile open items with the incoming payments on the bank
account. Build this with BANKSapi: bank connection via the WEB/Connect web components, matching of payments with
AI/Connect. The credentials for our BANKSapi test tenant are in .env."*

## Results

Every run started from the tag `baseline` in a fresh container, with no memories or settings from the host and with
the same prompt. No run needed a follow-up question or a fix.

| Branch | Assistant | Model | BANKSapi Docs MCP | Duration | Cost |
| --- | --- | --- | --- | --- | --- |
| [`run/opus-5.5-high-mcp`](../../tree/run/opus-5.5-high-mcp) | Claude Code | Claude Opus 5.5 | yes | 12 min | $4.60 |
| [`run/opus-5.5-high-ohne-mcp`](../../tree/run/opus-5.5-high-ohne-mcp) | Claude Code | Claude Opus 5.5 | no | 20 min | $6.34 |
| [`run/sonnet-5.5-high-mcp`](../../tree/run/sonnet-5.5-high-mcp) | Claude Code | Claude Sonnet 5.5 | yes | 6 min | $1.37 |
| [`run/codex-gpt-6.1-sol-high-mcp`](../../tree/run/codex-gpt-6.1-sol-high-mcp) | OpenAI Codex | gpt-6.1-sol (default) | available, not used | 20 min | ChatGPT plan |

All four results:

- pass their own tests and build without errors
- connect the bank through a WEB/Connect web component with REG/Protect, so bank credentials and TAN stay with BANKSapi
- fetch the transactions with BANKS/Connect and match them with AI/Connect Invoice Matching
- book the same 3 payments automatically and leave the 3 unpaid invoices open, without any double booking

The three Claude results propose the other 5 payments for review (Skonto, partial payment, a collective transfer
covering two invoices, a payment without reference). The Codex result flags the collective transfer for manual
review only and cannot book it in its UI.

**Less than 400 lines of BANKSapi code.** In the Opus run, everything specific to BANKSapi is the client for
BANKS/Connect and AI/Connect ([`server/banksapi.ts`](../../blob/run/opus-5.5-high-mcp/server/banksapi.ts)) and the
embedded web component ([`src/components/RegProtect.tsx`](../../blob/run/opus-5.5-high-mcp/src/components/RegProtect.tsx)):
373 lines without blank lines and comments.

## Branches

| Branch / tag | Content |
| --- | --- |
| `main` | Kontor with the current sample data and this README |
| tag `baseline` | Exactly what the assistants received |
| `run/*` | The result of each run, as committed by the harness |
| `experiment` | Harness (`docker/Dockerfile`, `run.sh`), prompt and evaluation with screenshots (German) |

Each `run/*` branch has one extra commit on top of the result, *"Sample data: match the demo account (added after
the run)"*. It is not part of the AI run. It updates `server/seed.ts` so the sample invoices match the
`demo_buchhaltung` account of the BANKSapi Demo Provider, which dates its payments from the first of the current
month.

## Try it yourself

1. Request a free BANKSapi test access: <https://banksapi.de/testzugang/>
2. Run one of the results:

   ```bash
   git checkout run/opus-5.5-high-mcp
   cp .env.example .env    # add BANKSAPI_TENANT and BANKSAPI_BASIC_AUTH of your test tenant
   npm install
   npm run seed            # sample data
   npm run dev             # UI on http://localhost:5173
   ```

   Open *Bankabgleich*, connect the bank *Demo Provider* with the login `demo_buchhaltung` / `demo` and start the
   reconciliation. The README on each run branch describes that result in detail (German).
3. Or repeat the experiment with your own assistant: check out the tag `baseline`, put your test tenant credentials
   into `.env`, connect the assistant to the BANKSapi Docs MCP and give it the prompt above.

   ```bash
   claude mcp add --transport http banksapi-docs https://banksapi.io/docs-mcp
   ```

   In Claude the Docs MCP is also available as a [connector](https://claude.ai/directory/banksapi-docs). Setup for other
   assistants: <https://docs.banksapi.de/guide/docs-mcp.html>

## Limitations

Kontor is a demo, not a product. The assistants pointed out the open items themselves, among them: a Skonto deduction
is not written off, the credentials of the technical BANKSapi user are stored unencrypted in SQLite, and the Kontor API
has no authentication. The match notes returned by AI/Connect are in English, the UI is in German.

## Running Kontor (starting state)

```bash
npm install
npm run seed   # sample data, resets the database
npm run dev    # API on :3001, UI on http://localhost:5173
```

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests (Node test runner) |
| `npm run build` | Type check and frontend build to `dist/` |
| `npm start` | API also serves the built frontend |

Structure: `server/` is an Express API in TypeScript with SQLite (`node:sqlite`), `src/` is the React UI (Vite).

## License

[MIT](LICENSE)
