import './env';
import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIsoDate, parseAmount, type InvoiceStatus } from './domain';
import * as repo from './repository';
import { bankRouter } from './bank-routes';
import { BanksapiError, hasUser, isConfigured } from './banksapi';
import { runReconciliation } from './reconcile';

const app = express();
// Hinter dem Vite-Proxy bzw. einem lokalen Reverse-Proxy die echte Client-IP verwenden
app.set('trust proxy', 'loopback');
app.use(express.json());

app.use('/api/bank', bankRouter);

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

// Im Produktivbetrieb liefert die API auch das gebaute Frontend aus
const dist = resolve('dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof BanksapiError) {
    console.error(`BANKSapi: ${err.message}`, err.body ?? '');
    // Fehler der Gegenseite als 502 melden, eigene fachliche Fehler (4xx) durchreichen
    const status = err.status >= 400 && err.status < 500 && !err.body ? err.status : 502;
    res.status(status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`Kontor-API läuft auf http://localhost:${port}`);
});

// Regelmäßiger Abgleich im Hintergrund. BANKSapi aktualisiert verbundene Konten selbst bis zu 4× täglich.
const intervalMinutes = Number(process.env.BANKSAPI_RECONCILE_INTERVAL_MINUTES ?? 360);
if (isConfigured() && intervalMinutes > 0) {
  setInterval(() => {
    if (!hasUser()) return;
    runReconciliation().then(
      (r) => console.log(`Bankabgleich: ${r.booked} gebucht, ${r.suggested} Vorschläge, ${r.unmatched} ohne Treffer`),
      (e: Error) => console.error(`Bankabgleich fehlgeschlagen: ${e.message}`),
    );
  }, intervalMinutes * 60_000).unref();
}
