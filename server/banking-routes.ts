import { Router } from 'express';
import { banksApi, BankingError } from './banksapi';
import { bankingState, bookCandidate, ignoreTransaction, reconcile } from './reconciliation';

export const bankingRouter = Router();
bankingRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
bankingRouter.use((req, _res, next) => {
  const origin = req.get('origin');
  if (req.method !== 'GET' && origin) {
    try {
      if (new URL(origin).host !== req.get('host')) throw new Error();
    } catch { throw new BankingError('Anfrage von einem fremden Ursprung abgewiesen.', 403); }
  }
  next();
});
bankingRouter.get('/', (_req, res) => res.json(bankingState()));

bankingRouter.post('/session', async (req, res) => {
  res.json(await banksApi.userToken(req.body?.refresh === true));
});
bankingRouter.post('/reconcile', async (_req, res) => { res.json(await reconcile()); });
bankingRouter.post('/assign', (req, res) => {
  const { invoice_id, transaction_id } = req.body ?? {};
  if (!Number.isSafeInteger(invoice_id) || !Number.isSafeInteger(transaction_id)) throw new BankingError('Rechnung und Bankumsatz fehlen.', 400);
  bookCandidate(banksApi.tenant, invoice_id, transaction_id);
  res.status(204).end();
});
bankingRouter.post('/ignore', (req, res) => {
  if (!Number.isSafeInteger(req.body?.transaction_id)) throw new BankingError('Bankumsatz fehlt.', 400);
  ignoreTransaction(banksApi.tenant, req.body.transaction_id);
  res.status(204).end();
});
