import './config';
import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIsoDate, parseAmount, type InvoiceStatus } from './domain';
import * as repo from './repository';
import { BanksapiError } from './banksapi';
import { banksapiConfig } from './config';
import { confirmSuggestion, reconcile, requireBanksapi } from './reconcile';

const app = express();
app.use(express.json());

app.get('/api/summary', (_req, res) => {
  res.json(repo.summary());
});

app.get('/api/customers', (_req, res) => {
  res.json(repo.listCustomers());
});

app.post('/api/customers', (req, res) => {
  const { name, iban, email } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Name fehlt' });
    return;
  }
  const customer = repo.createCustomer({
    name: name.trim(),
    iban: typeof iban === 'string' && iban.trim() ? iban.replace(/\s/g, '').toUpperCase() : null,
    email: typeof email === 'string' && email.trim() ? email.trim() : null,
  });
  res.status(201).json(customer);
});

const statusFilters = ['offen', 'ueberfaellig', 'teilbezahlt', 'bezahlt', 'unbezahlt'] as const;

app.get('/api/invoices', (req, res) => {
  const status = req.query.status as string | undefined;
  if (status && !statusFilters.includes(status as (typeof statusFilters)[number])) {
    res.status(400).json({ error: `Unbekannter Status: ${status}` });
    return;
  }
  res.json(repo.listInvoices(status as InvoiceStatus | 'unbezahlt' | undefined));
});

app.get('/api/invoices/next-number', (_req, res) => {
  res.json({ number: repo.nextInvoiceNumber() });
});

app.get('/api/invoices/:id', (req, res) => {
  const invoice = repo.getInvoice(Number(req.params.id));
  if (!invoice) {
    res.status(404).json({ error: 'Rechnung nicht gefunden' });
    return;
  }
  res.json(invoice);
});

app.post('/api/invoices', (req, res) => {
  const { customer_id, issue_date, due_date, amount, description } = req.body ?? {};
  const amountCents = parseAmount(amount ?? '');
  if (!Number.isInteger(customer_id) || !isIsoDate(issue_date) || !isIsoDate(due_date) || !amountCents) {
    res.status(400).json({ error: 'Kunde, Rechnungsdatum, Fälligkeit und Betrag sind Pflichtfelder' });
    return;
  }
  if (due_date < issue_date) {
    res.status(400).json({ error: 'Die Fälligkeit liegt vor dem Rechnungsdatum' });
    return;
  }
  const invoice = repo.createInvoice({
    customer_id,
    issue_date,
    due_date,
    amount_cents: amountCents,
    description: typeof description === 'string' ? description.trim() : '',
  });
  res.status(201).json(invoice);
});

app.post('/api/invoices/:id/payments', (req, res) => {
  const invoice = repo.getInvoice(Number(req.params.id));
  if (!invoice) {
    res.status(404).json({ error: 'Rechnung nicht gefunden' });
    return;
  }
  const { booked_on, amount, note } = req.body ?? {};
  const amountCents = parseAmount(amount ?? '');
  if (!isIsoDate(booked_on) || !amountCents) {
    res.status(400).json({ error: 'Buchungsdatum und Betrag sind Pflichtfelder' });
    return;
  }
  const payment = repo.addPayment(invoice.id, {
    booked_on,
    amount_cents: amountCents,
    note: typeof note === 'string' ? note.trim() : '',
  });
  res.status(201).json(payment);
});

app.delete('/api/invoices/:id/payments/:paymentId', (req, res) => {
  const deleted = repo.deletePayment(Number(req.params.id), Number(req.params.paymentId));
  res.status(deleted ? 204 : 404).end();
});

// ---------- Bankanbindung (BANKSapi) ----------

/** IP des Nutzers für den Header Customer-IP-Address (von Banken nach PSD2 verlangt); lokale Adressen sind wertlos. */
function customerIp(req: Request): string | undefined {
  const ip = req.ip?.replace(/^::ffff:/, '');
  return !ip || ip === '::1' || ip.startsWith('127.') ? undefined : ip;
}

app.get('/api/bank/status', async (_req, res) => {
  if (!banksapiConfig()) {
    res.json({ configured: false, accesses: [], suggestions: [] });
    return;
  }
  const accesses = await requireBanksapi().listAccesses();
  res.json({
    configured: true,
    accesses: accesses.map((a) => ({
      id: a.id,
      status: a.status ?? null,
      updated_at: a.aktualisierungszeitpunkt ?? null,
      needs_sca: !!a.relations?.some((r) => r.rel === 'start_sca'),
      messages: (a.messages ?? []).map((m) => m.message).filter(Boolean),
      products: (a.bankprodukte ?? []).map((p) => ({
        id: p.id,
        iban: p.iban ?? p.id,
        name: p.bezeichnung ?? '',
        bank: p.kreditinstitut ?? '',
        balance: p.saldo ?? null,
      })),
    })),
    suggestions: repo.listSuggestions(),
  });
});

// Startet REG/Protect; die Oberfläche bettet die Web Component mit dem Sitzungslink ein.
app.post('/api/bank/connect', async (req, res) => {
  const client = requireBanksapi();
  const config = banksapiConfig()!;
  const started = await client.startBankAccess(`${config.appBaseUrl}/`, customerIp(req));
  res.json({ session_link: started.sessionLink, reentry_url: `${config.appBaseUrl}/?bankReentry=1` });
});

app.post('/api/bank/accesses/:id/renew', async (req, res) => {
  const client = requireBanksapi();
  const config = banksapiConfig()!;
  const link = await client.startConsentRenewal(String(req.params.id), `${config.appBaseUrl}/`, customerIp(req));
  res.json({ session_link: link, reentry_url: `${config.appBaseUrl}/?bankReentry=1` });
});

app.post('/api/bank/reconcile', async (req, res) => {
  res.json(await reconcile({ refresh: req.body?.refresh === true, customerIp: customerIp(req) }));
});

app.post('/api/bank/suggestions/:id/confirm', (req, res) => {
  res.status(201).json(confirmSuggestion(Number(req.params.id)));
});

app.post('/api/bank/suggestions/:id/reject', (req, res) => {
  res.status(repo.rejectSuggestion(Number(req.params.id)) ? 204 : 404).end();
});

// Im Produktivbetrieb liefert die API auch das gebaute Frontend aus
const dist = resolve('dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof BanksapiError) {
    console.error(`[BANKSapi] ${err.message}`);
    // Eigene Hinweise (409/503/…) unverändert weitergeben, Fehler der Gegenseite als 502
    const own = [403, 404, 409, 503].includes(err.status);
    res.status(own ? err.status : 502).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`Kontor-API läuft auf http://localhost:${port}`);
});
