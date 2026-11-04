import './env';
import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { resolve } from 'node:path';
import { isIsoDate, parseAmount, type InvoiceStatus } from './domain';
import * as repo from './repository';
import * as bank from './bank';
import * as banksapi from './banksapi';
import { BanksApiError } from './banksapi';

const app = express();
app.use(express.json());
// Hinter einem Reverse Proxy (z. B. TRUST_PROXY=1), damit req.ip die echte Nutzer-IP ist
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

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
  bank.rememberRemovedBankPayment(Number(req.params.id), Number(req.params.paymentId));
  const deleted = repo.deletePayment(Number(req.params.id), Number(req.params.paymentId));
  res.status(deleted ? 204 : 404).end();
});

// ---------------------------------------------------------------------------
// Bankabgleich (BANKSapi)

const privateRanges = new BlockList();
for (const [net, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8]] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['::', 128]] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv6');
}

/**
 * IP-Adresse des Nutzers für den Header Customer-IP-Address (PSD2: Nachweis der Nutzerinteraktion).
 * BANKSapi erwartet eine öffentliche Adresse; lokal (localhost, LAN) wird der Header weggelassen.
 */
function customerIp(req: Request): string | undefined {
  const ip = req.ip?.replace(/^::ffff:/, '');
  const family = ip ? isIP(ip) : 0;
  if (!ip || !family) return undefined;
  return privateRanges.check(ip, family === 4 ? 'ipv4' : 'ipv6') ? undefined : ip;
}

/** Basis-URL der Oberfläche für Rücksprünge aus REG/Protect (muss bei BANKSapi freigegeben sein). */
function appBaseUrl(req: Request): string {
  const configured = process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  const origin = req.get('origin');
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  return `${req.protocol}://${req.get('host')}`;
}

/** Link für das REG/Protect Web Component: Location von BANKSapi + unsere callbackUrl. */
function sessionLink(req: Request, location: string, context: Record<string, string>): string {
  const callback = new URL(`${appBaseUrl(req)}/bank/callback`);
  for (const [key, value] of Object.entries(context)) callback.searchParams.set(key, value);
  const link = new URL(location);
  link.searchParams.set('callbackUrl', callback.toString());
  return link.toString();
}

app.get('/api/bank/status', async (_req, res) => {
  res.json(await bank.status());
});

app.post('/api/bank/connect', async (req, res) => {
  const { accessId, location } = await banksapi.startAddBankAccess(customerIp(req));
  res.json({ session_link: sessionLink(req, location, { vorgang: 'verbinden', zugang: accessId }) });
});

app.post('/api/bank/accesses/:accessId/refresh', async (req, res) => {
  const result = await banksapi.refreshBankAccess(req.params.accessId, customerIp(req));
  res.json(result.done ? { done: true } : { done: false, session_link: sessionLink(req, result.location, { vorgang: 'aktualisieren', zugang: req.params.accessId }) });
});

app.post('/api/bank/accesses/:accessId/consent', async (req, res) => {
  const result = await banksapi.renewConsent(req.params.accessId, customerIp(req));
  res.json(result.done ? { done: true } : { done: false, session_link: sessionLink(req, result.location, { vorgang: 'zustimmung', zugang: req.params.accessId }) });
});

app.delete('/api/bank/accesses/:accessId', async (req, res) => {
  await banksapi.deleteBankAccess(req.params.accessId, customerIp(req));
  res.status(204).end();
});

app.post('/api/bank/reconcile', async (_req, res) => {
  res.json(await bank.reconcile());
});

app.get('/api/bank/proposals', (_req, res) => {
  res.json(bank.listProposals());
});

app.post('/api/bank/proposals/:id/accept', (req, res) => {
  bank.acceptProposal(Number(req.params.id));
  res.status(204).end();
});

app.post('/api/bank/proposals/:id/dismiss', (req, res) => {
  bank.dismissProposal(Number(req.params.id));
  res.status(204).end();
});

// Im Produktivbetrieb liefert die API auch das gebaute Frontend aus
const dist = resolve('dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof bank.ProposalError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof BanksApiError) {
    console.error(`BANKSapi: ${err.message}`);
    // 404/409 an den Aufrufer durchreichen, alles andere ist ein Fehler im Umsystem
    res.status(err.status === 404 || err.status === 409 ? err.status : 502).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`Kontor-API läuft auf http://localhost:${port}`);
});
