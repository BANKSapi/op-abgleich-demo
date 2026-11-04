import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('./db');
const { BanksApi, BankingError } = await import('./banksapi');
const { reconcile, exclusionRefs, invoicePayload, bankingState, bookCandidate, ignoreTransaction } = await import('./reconciliation');
const repo = await import('./repository');
type MatchResult = import('./banksapi').MatchResult;
type RemoteTransaction = import('./banksapi').RemoteTransaction;

const TENANT = 'unit-test';
const PRODUCT = 'DE89370400440532013000';
const transaction = (overrides: Partial<RemoteTransaction> = {}): RemoteTransaction => ({
  id: 'tx-1', betrag: 100, buchungsdatum: '2026-11-04 00:00:00', waehrung: 'EUR',
  verwendungszweck: 'RE-2026-0001', gegenkontoInhaber: 'Testkunde', ...overrides,
});
const match = (overrides: Partial<MatchResult> = {}): MatchResult => ({
  status: 'matched', matches: [{
    confidence: 0.98, delta: 0, matchType: 'exact', transaction: { id: 'tx-1', productId: PRODUCT },
    signals: { amountMatch: 'exact', ibanMatch: true, referenceContainsInvoiceNumber: true }, notes: [],
  }], ...overrides,
});

function invoice(amount = 10_000) {
  const customer = repo.createCustomer({ name: 'Testkunde', iban: 'DE44500105175407324931', email: null });
  return repo.createInvoice({ customer_id: customer.id, issue_date: '2026-10-01', due_date: '2026-11-01', amount_cents: amount, description: '' });
}

function fixture(options: {
  transactions?: RemoteTransaction[];
  results?: unknown | (() => unknown | Promise<unknown>);
  matchingStatus?: number;
  duplicateAccess?: boolean;
} = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let userTokens = 0;
  const http: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (path.endsWith('/token') ? Object.fromEntries(new URLSearchParams(String(init.body))) : JSON.parse(String(init.body))) : {};
    calls.push({ path, body });
    if (path === '/auth/oauth2/token') {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Basic test-secret');
      if (body.grant_type === 'password') {
        userTokens++;
        assert.ok(!body.scope.includes('ueberweisung'));
        return Response.json({ access_token: 'user-token', user: 'user-id', tenant: TENANT, expires_in: 7200 });
      }
      return Response.json({ access_token: 'client-token', tenant: TENANT });
    }
    if (path.endsWith('/users')) return new Response(null, { status: 201 });
    if (path === '/customer/v2/bankzugaenge') {
      const access = { id: 'access-1', bankprodukte: [{ id: PRODUCT, waehrung: 'EUR' }] };
      return Response.json(options.duplicateAccess ? { 'access-1': access, 'access-2': { ...access, id: 'access-2' } } : { 'access-1': access });
    }
    if (path.endsWith('/kontoumsaetze')) return Response.json(options.transactions ?? [transaction()]);
    if (path === '/customer/v2/ai/invoice-matching/') {
      assert.equal(body.invoiceDirection, 'receivable');
      assert.equal(body.assignUnique, true);
      if (options.matchingStatus) return Response.json({ secret: 'NEVER_EXPOSE_PROVIDER_BODY' }, { status: options.matchingStatus });
      return Response.json(typeof options.results === 'function' ? await options.results() : options.results ?? [match()]);
    }
    throw new Error(`Unexpected request ${path}`);
  };
  return { client: new BanksApi(TENANT, 'test-secret', http), calls, tokens: () => userTokens };
}

beforeEach(() => {
  db.exec(`DELETE FROM bank_allocations; DELETE FROM reconciliation_results; DELETE FROM reconciliation_runs;
    DELETE FROM bank_transactions; DELETE FROM payments; DELETE FROM invoices; DELETE FROM customers; DELETE FROM banking_identities;`);
});

test('Server provisioniert genau einen Benutzer, verschlüsselt sein Passwort und begrenzt den Token-Scope', async () => {
  const { client, calls, tokens } = fixture();
  await Promise.all([client.userToken(), client.userToken()]);
  assert.equal(calls.filter(call => call.path.endsWith('/users')).length, 1);
  assert.equal(tokens(), 1);
  const identity = calls.find(call => call.path.endsWith('/users'))!.body;
  const stored = db.prepare('SELECT secret FROM banking_identities').get() as { secret: string };
  assert.ok(!stored.secret.includes(String(identity.password)));
  assert.ok(!stored.secret.includes(String(identity.username)));
  const restarted = new BanksApi(TENANT, 'test-secret', async (url, init) => {
    assert.ok(String(url).endsWith('/token'));
    assert.equal(new URLSearchParams(String(init?.body)).get('username'), identity.username);
    return Response.json({ access_token: 'new-token', user: 'user-id', tenant: TENANT });
  });
  await restarted.userToken();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM banking_identities').get()!.n, 1);
});

test('Payload enthält offenen Betrag, Kundennummer und Kunden-IBAN im Feld BT-91', () => {
  const inv = invoice();
  repo.addPayment(inv.id, { booked_on: '2026-11-01', amount_cents: 2500 });
  const payload = invoicePayload()[0].payload;
  assert.equal(payload.amountDueForPayment, 75);
  assert.equal(payload.invoiceTotalAmountWithVat, 100);
  assert.equal(payload.debitedAccountIdentifier, 'DE44500105175407324931');
  assert.equal(payload.buyerIdentifier, 'K-10001');
  assert.ok(!('paymentAccountIdentifier' in payload));
});

test('Eindeutiger Eingang wird einmal gebucht; Folgeläufe schließen verbuchte Umsätze aus', async () => {
  const inv = invoice();
  const fixtureData = fixture();
  await fixtureData.client.userToken();
  assert.equal((await reconcile(fixtureData.client)).booked_count, 1);
  assert.equal(repo.getInvoice(inv.id)?.status, 'bezahlt');
  assert.equal(repo.getInvoice(inv.id)?.payments[0].method, 'BANKSapi');
  const second = invoice();
  assert.equal((await reconcile(fixtureData.client)).booked_count, 0);
  assert.equal(repo.getInvoice(second.id)?.open_cents, 10_000);
  const request = fixtureData.calls.filter(call => call.path.endsWith('/invoice-matching/')).at(-1)!;
  assert.deepEqual(request.body.excludeTransactions, [{ id: 'tx-1', productId: PRODUCT }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get()!.n, 1);
});

test('Entfernte Bankzahlung bleibt ausgeschlossen und wird nicht erneut automatisch gebucht', async () => {
  const inv = invoice();
  const { client } = fixture();
  await client.userToken(); await reconcile(client);
  const payment = repo.getInvoice(inv.id)!.payments[0];
  repo.deletePayment(inv.id, payment.id);
  assert.equal(exclusionRefs(TENANT).length, 1);
  assert.equal((await reconcile(client)).booked_count, 0);
  assert.equal(repo.getInvoice(inv.id)?.open_cents, 10_000);
  const history = bankingState(client).history as { payment_id: number | null }[];
  assert.equal(history[0].payment_id, null);
});

test('Teilzahlung wird geprüft zugeordnet und der Restbetrag bleibt offen', async () => {
  const inv = invoice();
  const result = match({ status: 'partially_matched' });
  result.matches[0] = { ...result.matches[0], confidence: 0.65, matchType: 'partial', delta: -60 };
  const { client } = fixture({ transactions: [transaction({ betrag: 40 })], results: [result] });
  await client.userToken(); assert.equal((await reconcile(client)).booked_count, 0);
  const state = bankingState(client);
  const txId = state.results[0].candidates[0].bank_transaction!.id;
  bookCandidate(TENANT, inv.id, txId);
  assert.equal(repo.getInvoice(inv.id)?.open_cents, 6000);
  assert.throws(() => bookCandidate(TENANT, inv.id, txId), /nicht mehr möglich/);
  assert.equal(exclusionRefs(TENANT).length, 1);
});

test('Unsichere Treffer lassen sich ausschließen', async () => {
  const inv = invoice();
  const { client } = fixture({ results: [match({ status: 'likely_matched' })] });
  await client.userToken(); await reconcile(client);
  const txId = bankingState(client).results[0].candidates[0].bank_transaction!.id;
  ignoreTransaction(TENANT, txId);
  assert.throws(() => bookCandidate(TENANT, inv.id, txId), /nicht mehr möglich/);
  assert.equal(exclusionRefs(TENANT).length, 1);
});

test('Skonto, Überzahlungen, Sammelzahlungen, Ausgänge, Fremdwährung und ungültige Umsätze werden nicht automatisch gebucht', async () => {
  invoice();
  const cases: { results?: MatchResult[]; transactions?: RemoteTransaction[] }[] = [
    { results: [match({ status: 'possible_batch' })] },
    { results: [match({ status: 'overpaid' })] },
    { transactions: [transaction({ betrag: -100 })] },
    { transactions: [transaction({ betrag: 101 })] },
    { transactions: [transaction({ betrag: 98 })] },
    { transactions: [transaction({ waehrung: 'USD' })] },
    { transactions: [transaction({ buchungsdatum: '2026-02-31' })] },
    { transactions: [transaction({ id: undefined })] },
    { results: [match({ matches: [{ ...match().matches[0], confidence: 0.89 }] })] },
    { results: [match({ matches: [{ ...match().matches[0], matchType: 'skonto' }] })] },
    { results: [match({ matches: [match().matches[0], { ...match().matches[0], confidence: 0.95 }] })] },
  ];
  for (const options of cases) {
    db.exec('DELETE FROM bank_transactions');
    const { client } = fixture(options); await client.userToken();
    assert.equal((await reconcile(client)).booked_count, 0, JSON.stringify(options));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get()!.n, 0);
});

test('Gleicher Umsatz für mehrere Rechnungen und gleiche Produktreferenz in mehreren Zugängen sind mehrdeutig', async () => {
  invoice(); invoice();
  const { client } = fixture({ results: [match(), match()] });
  await client.userToken(); assert.equal((await reconcile(client)).booked_count, 0);
  const duplicated = fixture({ results: [match(), match()], duplicateAccess: true });
  await duplicated.client.userToken(); assert.equal((await reconcile(duplicated.client)).booked_count, 0);
  assert.equal(bankingState(duplicated.client).results[0].candidates[0].bank_transaction, null);
});

test('Manuelle Zahlung während des API-Aufrufs verhindert eine veraltete automatische Buchung', async () => {
  const inv = invoice();
  const { client } = fixture({ results: () => {
    repo.addPayment(inv.id, { booked_on: '2026-11-04', amount_cents: 3000 });
    return [match()];
  } });
  await client.userToken(); assert.equal((await reconcile(client)).booked_count, 0);
  assert.equal(repo.getInvoice(inv.id)?.open_cents, 7000);
});

test('API-Fehler und ungültige Antwortformate führen zu keiner Buchung und verraten keine Provider-Antwort', async () => {
  invoice();
  for (const options of [{ matchingStatus: 403 }, { results: [] }, { results: [{ status: 'matched', matches: null }] }, { results: [match(), match()] }]) {
    const { client } = fixture(options); await client.userToken();
    await assert.rejects(reconcile(client), (error: unknown) => error instanceof BankingError && !error.message.includes('NEVER_EXPOSE'));
    assert.equal((bankingState(client).last_run as { status: string }).status, 'failed');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get()!.n, 0);
});

test('Parallele Läufe werden abgewiesen', async () => {
  invoice();
  const { client } = fixture(); await client.userToken();
  const first = reconcile(client);
  await assert.rejects(reconcile(client), /läuft bereits/);
  assert.equal((await first).booked_count, 1);
});

test('Bei HTTP 401 wird der Benutzertoken einmal erneuert', async () => {
  const { client } = fixture(); await client.userToken();
  let calls = 0;
  const renewed = new BanksApi(TENANT, 'test-secret', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/token')) return Response.json({ access_token: 'renewed', user: 'user-id', tenant: TENANT });
    calls++;
    return calls === 1 ? new Response(null, { status: 401 }) : Response.json({});
  });
  assert.deepEqual(await renewed.accesses(), {});
  assert.equal(calls, 2);
});
