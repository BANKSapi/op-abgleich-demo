/**
 * Integrationstest des Abgleichs gegen einen lokalen Fake von BANKSapi
 * (Antwortformen nach der BANKSapi-Dokumentation) und eine In-Memory-Datenbank.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

process.env.DATABASE_PATH = ':memory:';
process.env.BANKSAPI_TENANT = 'testtenant';
process.env.BANKSAPI_BASIC_AUTH = 'Basic dGVzdDp0ZXN0';

const IBAN = 'DE00123456789012345678';
const ACCESS = '629e4510-5331-47d4-9bad-8902039ff762';
const requests: { method: string; url: string; body: any }[] = [];

// Umsätze auf dem Konto (id → Betrag in €)
const transactions = [
  { id: 'tx-exact', betrag: 1000, buchungsdatum: '2026-10-20 00:00:00', gegenkontoInhaber: 'Hofmann Gartenbau', verwendungszweck: 'RE-2026-0001' },
  { id: 'tx-part', betrag: 300, buchungsdatum: '2026-10-21 00:00:00', gegenkontoInhaber: 'Cafe Lindenbluete', verwendungszweck: 'Anzahlung RE-2026-0002' },
  { id: 'tx-over', betrag: 800, buchungsdatum: '2026-10-22 00:00:00', gegenkontoInhaber: 'Weber', verwendungszweck: 'RE-2026-0003 inkl. Trinkgeld' },
  { id: 'tx-late', betrag: 700, buchungsdatum: '2026-10-24 00:00:00', gegenkontoInhaber: 'Nix', verwendungszweck: 'Überweisung' },
  { id: 'tx-out', betrag: -50, buchungsdatum: '2026-10-23 00:00:00', gegenkontoInhaber: 'Papier GmbH', verwendungszweck: 'Rechnung' },
];

const candidate = (id: string, matchType: string, confidence: number, delta: number) => ({
  confidence, delta, matchType, notes: [], transaction: { id, productId: IBAN },
});

let overrides: Record<string, unknown> = {};
let server: Server;
let reconcile: typeof import('./reconcile').reconcile;
let confirmSuggestion: typeof import('./reconcile').confirmSuggestion;
let repo: typeof import('./repository');

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = raw;
    try { body = JSON.parse(raw); } catch { /* Formulardaten */ }
    requests.push({ method: req.method!, url: req.url!, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const url = req.url!;
    if (url === '/auth/oauth2/token') return json(200, { access_token: 'tok', expires_in: 7200 });
    if (url === '/customer/v2/regprotect/sessions') return json(200, {});
    if (url === '/customer/v2/bankzugaenge') {
      return json(200, { [ACCESS]: { id: ACCESS, status: 'VOLLSTAENDIG', bankprodukte: [{ id: IBAN, iban: IBAN, bezeichnung: 'Girokonto', kreditinstitut: 'Demo Provider', saldo: 10 }] } });
    }
    if (url.startsWith(`/customer/v2/bankzugaenge/${ACCESS}/${IBAN}/kontoumsaetze`)) return json(200, transactions);
    if (url === '/customer/v2/ai/invoice-matching/') {
      const byNumber: Record<string, unknown> = {
        'RE-2026-0001': { status: 'matched', matches: [candidate('tx-exact', 'exact', 1, 0)] },
        'RE-2026-0002': { status: 'partially_matched', matches: [candidate('tx-part', 'partial', 0.7, -200)], remainingAmount: 200 },
        'RE-2026-0003': { status: 'overpaid', matches: [candidate('tx-over', 'reference_only', 0.8, 300)] },
        'RE-2026-0004': { status: 'matched', matches: [candidate('tx-out', 'exact', 1, 0)] },
        'RE-2026-0005': { status: 'unmatched', matches: [] },
      };
      return json(200, body.invoices.map((i: any) => overrides[i.invoiceNumber] ?? byNumber[i.invoiceNumber]));
    }
    json(404, { error: `unerwartet ${req.method} ${url}` });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.BANKSAPI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  repo = await import('./repository');
  ({ reconcile, confirmSuggestion } = await import('./reconcile'));
  const c = (name: string, iban: string | null) => repo.createCustomer({ name, iban, email: null });
  const customers = [c('Hofmann Gartenbau', 'DE44500105175407324931'), c('Cafe Lindenbluete', null), c('Weber', null), c('Papier', null), c('Nix', null)];
  [1000, 500, 500, 50, 700].forEach((euro, n) =>
    repo.createInvoice({ customer_id: customers[n].id, issue_date: '2026-10-01', due_date: '2026-10-31', amount_cents: euro * 100, description: '' }),
  );
});

after(() => server.close());

test('Abgleich: exakter Treffer wird gebucht, Unsicheres wird nur vorgeschlagen, Abgänge werden ignoriert', async () => {
  const result = await reconcile();
  assert.deepEqual(
    { booked: result.booked, suggested: result.suggested, unmatched: result.unmatched, checked: result.checked_invoices },
    { booked: 1, suggested: 2, unmatched: 2, checked: 5 },
  );

  const exact = repo.getInvoice(1)!;
  assert.equal(exact.status, 'bezahlt');
  assert.equal(exact.payments[0].method, 'bank');
  assert.equal(exact.payments[0].booked_on, '2026-10-20');
  assert.equal(exact.payments[0].bank_transaction_id, 'tx-exact');

  assert.equal(repo.getInvoice(2)!.paid_cents, 0, 'Teilzahlung nicht ohne Bestätigung verbuchen');
  assert.equal(repo.getInvoice(4)!.paid_cents, 0, 'Abgang nie als Zahlungseingang verbuchen');
  assert.deepEqual(repo.listSuggestions().map((s) => s.invoice_number).sort(), ['RE-2026-0002', 'RE-2026-0003']);
});

test('Der Rechnungsabgleich bekommt offene Beträge und bereits verbuchte Umsätze zum Ausschließen', async () => {
  await reconcile();
  const call = requests.filter((r) => r.url === '/customer/v2/ai/invoice-matching/').at(-1)!;
  assert.equal(call.body.invoiceDirection, 'receivable');
  assert.deepEqual(call.body.excludeTransactions, [{ id: 'tx-exact', productId: IBAN }]);
  assert.deepEqual(call.body.invoices.map((i: any) => i.invoiceNumber), ['RE-2026-0002', 'RE-2026-0003', 'RE-2026-0004', 'RE-2026-0005']);
  assert.equal(call.body.invoices[0].amountDueForPayment, 500);
  // wiederholter Lauf: keine Duplikate
  assert.equal(repo.listSuggestions().length, 2);
  assert.equal(repo.getInvoice(1)!.payments.length, 1);
});

test('Bestätigen verbucht höchstens den offenen Betrag und nur einmal', async () => {
  const [partial, over] = ['RE-2026-0002', 'RE-2026-0003'].map((n) => repo.listSuggestions().find((s) => s.invoice_number === n)!);

  const p1 = confirmSuggestion(partial.id);
  assert.equal(p1.amount_cents, 30_000);
  assert.equal(repo.getInvoice(2)!.open_cents, 20_000);
  assert.throws(() => confirmSuggestion(partial.id), /nicht gefunden/);

  const p2 = confirmSuggestion(over.id);
  assert.equal(p2.amount_cents, 50_000, 'Überzahlung wird auf den offenen Betrag begrenzt');
  assert.match(p2.note, /Überzahlung von 300,00 € nicht verbucht/);
  assert.equal(repo.getInvoice(3)!.status, 'bezahlt');
});

test('Derselbe Bankumsatz lässt sich nicht zweimal verbuchen', () => {
  assert.throws(
    () => repo.bookBankPayment(5, { booked_on: '2026-10-20', amount_cents: 100, note: '', product_id: IBAN, transaction_id: 'tx-exact' }),
    /UNIQUE/,
  );
});

test('Abgelehnte Vorschläge kommen nicht wieder', async () => {
  overrides = { 'RE-2026-0005': { status: 'likely_matched', matches: [candidate('tx-late', 'amount_only', 0.6, 0)] } };
  await reconcile();
  const s = repo.listSuggestions().find((x) => x.invoice_number === 'RE-2026-0005')!;
  assert.ok(s, 'Vorschlag erscheint');
  assert.equal(s.amount_cents, 70_000);

  assert.ok(repo.rejectSuggestion(s.id));
  await reconcile();
  assert.equal(repo.listSuggestions().filter((x) => x.invoice_number === 'RE-2026-0005').length, 0, 'abgelehnt bleibt abgelehnt');
  overrides = {};
});
