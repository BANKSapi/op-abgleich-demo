import './env';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from './db';

const API_ORIGIN = 'https://banksapi.io';
const USER_SCOPE = 'http://banksapi.io/customer/read http://banksapi.io/customer/modify http://banksapi.io/provider/read';

export class BankingError extends Error {
  constructor(message: string, public status = 502, public upstreamStatus?: number) { super(message); }
}

export interface TransactionRef { id: string; productId: string }
export interface MatchCandidate {
  confidence: number;
  delta: number;
  matchType: string;
  transaction: TransactionRef;
  signals: { amountMatch?: string; ibanMatch?: boolean; referenceContainsInvoiceNumber?: boolean; [key: string]: unknown };
  notes?: string[];
}
export interface MatchResult {
  status: string;
  matches: MatchCandidate[];
  error?: string;
  totalMatchedAmount?: number;
  remainingAmount?: number;
}
export interface BankProduct {
  id: string;
  bezeichnung?: string;
  iban?: string;
  waehrung?: string;
  relations?: { rel: string; href: string }[];
}
export interface BankAccess {
  id: string;
  status?: string;
  bankprodukte?: BankProduct[];
  aktualisierungszeitpunkt?: string;
}
export interface RemoteTransaction {
  id?: string;
  betrag: number;
  buchungsdatum: string;
  waehrung?: string;
  verwendungszweck?: string;
  gegenkontoInhaber?: string;
}
interface Token { access_token: string; expires_in?: number; tenant?: string; user?: string }
interface Identity { username: string; password: string }

export class BanksApi {
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<{ token: string; expiresAt: number }>;

  constructor(
    readonly tenant = process.env.BANKSAPI_TENANT ?? '',
    private basicAuth = process.env.BANKSAPI_BASIC_AUTH ?? '',
    private http: typeof fetch = fetch,
  ) {}

  get configured() { return Boolean(this.tenant && this.basicAuth); }
  get initialized() {
    return Boolean(db.prepare('SELECT 1 FROM banking_identities WHERE tenant = ? AND activated = 1').get(this.tenant));
  }

  private key() {
    return createHash('sha256').update(`kontor:banksapi:${this.tenant}:${this.basicAuth}`).digest();
  }

  private encrypt(identity: Identity) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(identity), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  private identity(): Identity {
    const stored = db.prepare('SELECT secret FROM banking_identities WHERE tenant = ?').get(this.tenant) as { secret: string } | undefined;
    if (!stored) {
      const identity = { username: `kontor-${randomUUID()}`, password: `Ko!9${randomBytes(30).toString('base64url')}` };
      db.prepare('INSERT INTO banking_identities (tenant, secret) VALUES (?, ?)').run(this.tenant, this.encrypt(identity));
      return identity;
    }
    try {
      const data = Buffer.from(stored.secret, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')) as Identity;
    } catch {
      throw new BankingError('BANKSapi-Benutzerdaten können nicht entschlüsselt werden. Ursprünglichen BANKSAPI_BASIC_AUTH wiederherstellen.', 503);
    }
  }

  private async send(path: string, init: RequestInit) {
    let response: Response;
    try {
      const url = new URL(path, API_ORIGIN);
      if (url.origin !== API_ORIGIN) throw new Error('Ungültiger API-Ursprung');
      response = await this.http(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new BankingError('BANKSapi ist derzeit nicht erreichbar oder hat das Zeitlimit überschritten. Bitte erneut versuchen.');
    }
    if (!response.ok) {
      // Provider-Antworten können persönliche Daten enthalten: niemals ungefiltert protokollieren.
      const reasons: Record<number, string> = {
        401: 'BANKSapi-Anmeldung fehlgeschlagen.',
        402: 'Der BANKSapi-Testmandant ist abgelaufen.',
        403: 'BANKSapi-Berechtigung fehlt. Freischaltung von AI/Connect und den angeforderten Scopes prüfen.',
        409: 'Der BANKSapi-Benutzer existiert bereits.',
        422: 'BANKSapi hat die übermittelten Daten abgelehnt.',
        423: 'Der BANKSapi-Benutzer ist gesperrt.',
        429: 'BANKSapi-Anfragelimit erreicht. Bitte später erneut versuchen.',
        451: 'Bankfreigabe erforderlich. Bitte unter Bankverbindungen erneuern.',
      };
      throw new BankingError(reasons[response.status] ?? `BANKSapi-Anfrage fehlgeschlagen (HTTP ${response.status}).`, 502, response.status);
    }
    return response;
  }

  private async oauth(fields: Record<string, string>): Promise<Token> {
    const authorization = `Basic ${this.basicAuth.replace(/^Basic\s+/i, '').trim()}`;
    const response = await this.send('/auth/oauth2/token', {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    const token = await response.json() as Token;
    if (!token.access_token || (token.tenant && token.tenant !== this.tenant)) {
      throw new BankingError('BANKSapi-Token oder Mandant stimmt nicht mit der Konfiguration überein.');
    }
    return token;
  }

  async userToken(force = false): Promise<{ token: string; expiresAt: number }> {
    if (!this.configured) throw new BankingError('BANKSAPI_TENANT und BANKSAPI_BASIC_AUTH in .env konfigurieren.', 503);
    if (this.pendingToken) return this.pendingToken;
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) {
      return { token: this.token.value, expiresAt: this.token.expiresAt };
    }
    this.pendingToken = this.createUserToken();
    try { return await this.pendingToken; } finally { this.pendingToken = undefined; }
  }

  private async createUserToken() {
    const identity = this.identity();
    if (!this.initialized) {
      const client = await this.oauth({ grant_type: 'client_credentials', scope: 'auth/tenants/users/create' });
      try {
        await this.send(`/auth/mgmt/v1/tenants/${encodeURIComponent(this.tenant)}/users`, {
          method: 'POST', headers: { Authorization: `Bearer ${client.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(identity),
        });
      } catch (error) {
        // Nach einem Verbindungsabbruch kann der zuvor gespeicherte Benutzer bereits angelegt sein.
        if (!(error instanceof BankingError) || error.upstreamStatus !== 409) throw error;
      }
    }
    const user = await this.oauth({ grant_type: 'password', ...identity, scope: USER_SCOPE });
    if (!user.user) throw new BankingError('BANKSapi hat keinen Token auf Benutzerebene geliefert.');
    db.prepare('UPDATE banking_identities SET activated = 1 WHERE tenant = ?').run(this.tenant);
    const expiresAt = Date.now() + (user.expires_in ?? 7200) * 1000;
    this.token = { value: user.access_token, expiresAt };
    return { token: user.access_token, expiresAt };
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { token } = await this.userToken(attempt > 0);
      try {
        const response = await this.send(path, {
          ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-correlation-id': randomUUID(), ...init.headers },
        });
        return await response.json() as T;
      } catch (error) {
        if (!(error instanceof BankingError) || error.upstreamStatus !== 401 || attempt > 0) throw error;
      }
    }
    throw new BankingError('BANKSapi-Anmeldung fehlgeschlagen.');
  }

  accesses() { return this.request<Record<string, BankAccess>>('/customer/v2/bankzugaenge'); }

  transactions(accessId: string, productId: string) {
    return this.request<RemoteTransaction[]>(`/customer/v2/bankzugaenge/${encodeURIComponent(accessId)}/${encodeURIComponent(productId)}/kontoumsaetze?bookingStatus=booked`);
  }

  match(invoices: unknown[], excludeTransactions: TransactionRef[]) {
    return this.request<MatchResult[]>('/customer/v2/ai/invoice-matching/', {
      method: 'POST', body: JSON.stringify({ invoices, invoiceDirection: 'receivable', assignUnique: true, searchWindowDays: 180, excludeTransactions }),
    });
  }
}

export const banksApi = new BanksApi();
