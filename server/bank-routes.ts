import { Router, type Request } from 'express';
import * as banksapi from './banksapi';
import * as bankRepo from './bank-repository';
import * as reconcile from './reconcile';

export const bankRouter = Router();

/** IP-Adresse des Nutzers; Banken verlangen sie bei interaktiven Vorgängen (PSD2). */
function customerIp(req: Request): string | undefined {
  return req.ip?.replace(/^::ffff:/, '');
}

/**
 * Rücksprungadresse nach REG/Protect. Muss zur Allowlist des Mandanten bei BANKSapi passen,
 * daher im Produktivbetrieb über PUBLIC_URL fest vorgeben.
 */
function appOrigin(req: Request): string {
  const candidate = process.env.PUBLIC_URL ?? req.get('origin');
  if (!candidate) throw new banksapi.BanksapiError('PUBLIC_URL ist nicht gesetzt und die Anfrage hat keinen Origin', 400);
  const url = new URL(candidate);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new banksapi.BanksapiError('Ungültige PUBLIC_URL', 400);
  return url.origin;
}

function callbackUrl(req: Request, accessId: string): string {
  return `${appOrigin(req)}/bankabgleich/fertig?accessId=${encodeURIComponent(accessId)}`;
}

bankRouter.use((_req, res, next) => {
  if (!banksapi.isConfigured()) {
    res.status(503).json({ error: 'BANKSapi ist nicht konfiguriert (BANKSAPI_TENANT, BANKSAPI_BASIC_AUTH)' });
    return;
  }
  next();
});

bankRouter.get('/status', async (_req, res) => {
  const accesses = await banksapi.getBankAccesses();
  res.json({
    accesses: accesses.map((a) => ({
      id: a.id,
      status: a.status ?? null,
      updated_at: a.aktualisierungszeitpunkt ?? null,
      needs_sca: Boolean(banksapi.relation(a, 'start_sca')),
      products: (a.bankprodukte ?? []).map((p) => ({
        id: p.id,
        name: p.bezeichnung ?? p.kategorie ?? 'Konto',
        bank: p.kreditinstitut ?? null,
        iban: p.iban ?? null,
        owner: p.inhaber ?? null,
        balance: p.saldo ?? null,
        currency: p.waehrung ?? 'EUR',
        status: p.status ?? null,
      })),
    })),
    last_run: reconcile.lastRun(),
    auto_book_confidence: reconcile.autoBookConfidence(),
  });
});

bankRouter.post('/connect', async (req, res) => {
  const session = await banksapi.startAddBankAccess((id) => callbackUrl(req, id), customerIp(req));
  res.status(201).json(session);
});

async function findAccess(id: string) {
  const access = (await banksapi.getBankAccesses()).find((a) => a.id === id);
  if (!access) throw new banksapi.BanksapiError('Bankzugang nicht gefunden', 404);
  return access;
}

bankRouter.post('/accesses/:id/refresh', async (req, res) => {
  const access = await findAccess(req.params.id);
  const session = await banksapi.refreshBankAccess(access.id, callbackUrl(req, access.id), customerIp(req));
  if (session) {
    res.json({ session });
    return;
  }
  res.json({ run: await reconcile.runReconciliation() });
});

bankRouter.post('/accesses/:id/sca', async (req, res) => {
  const access = await findAccess(req.params.id);
  res.status(201).json(await banksapi.startSca(access, callbackUrl(req, access.id), customerIp(req)));
});

bankRouter.delete('/accesses/:id', async (req, res) => {
  const access = await findAccess(req.params.id);
  await banksapi.deleteBankAccess(access.id, customerIp(req));
  // Bereits gebuchte Zahlungen bleiben erhalten; nur Zwischenspeicher und offene Vorschläge verschwinden
  bankRepo.deleteTransactionsOfAccess(access.id);
  res.status(204).end();
});

bankRouter.post('/reconcile', async (_req, res) => {
  res.json(await reconcile.runReconciliation());
});

bankRouter.get('/suggestions', (_req, res) => {
  res.json(bankRepo.listOpenSuggestions());
});

bankRouter.post('/suggestions/:id/confirm', (req, res) => {
  const result = reconcile.confirmSuggestion(Number(req.params.id));
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

bankRouter.post('/suggestions/:id/reject', (req, res) => {
  res.status(bankRepo.rejectSuggestion(Number(req.params.id)) ? 204 : 404).end();
});

bankRouter.get('/transactions', (_req, res) => {
  res.json(bankRepo.listTransactions());
});
