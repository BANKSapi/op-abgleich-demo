/**
 * Schmaler Client für BANKS/Connect (Auth, Bankzugänge, Umsätze) und AI/Connect (Rechnungsabgleich).
 * Läuft ausschließlich im Backend: Basic-Auth-Zugangsdaten und Tokens verlassen den Server nie.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { banksapiConfig, type BanksapiConfig } from './config';

export class BanksapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Relation {
  rel: string;
  href: string;
}

export interface BankProduct {
  id: string;
  iban?: string;
  bezeichnung?: string;
  kategorie?: string;
  saldo?: number;
  kreditinstitut?: string;
  inhaber?: string;
}

export interface BankAccess {
  id: string;
  status?: string;
  aktualisierungszeitpunkt?: string;
  bankprodukte?: BankProduct[];
  relations?: Relation[];
  messages?: { code?: string; level?: string; message?: string }[];
}

export interface BankTransaction {
  id?: string;
  betrag: number;
  waehrung?: string;
  verwendungszweck?: string;
  buchungsdatum: string;
  gegenkontoInhaber?: string;
  gegenkontoIban?: string;
}

export interface ExtractedInvoice {
  invoiceNumber: string;
  invoiceIssueDate: string;
  invoiceCurrencyCode: string;
  sellerName: string;
  amountDueForPayment: number;
  buyerName?: string;
  buyerIdentifier?: string;
  debitedAccountIdentifier?: string;
  invoiceTotalAmountWithVat?: number;
  paymentDueDate?: string;
  remittanceInformation?: string;
}

export interface TransactionRef {
  id: string;
  productId?: string;
}

export interface MatchCandidate {
  confidence: number;
  delta: number;
  matchType: 'exact' | 'strong' | 'reference_only' | 'amount_only' | 'skonto' | 'partial' | 'fuzzy' | 'possible_batch';
  notes?: string[];
  transaction: TransactionRef;
}

export type MatchStatus =
  | 'matched'
  | 'likely_matched'
  | 'partially_matched'
  | 'overpaid'
  | 'possible_batch'
  | 'unmatched'
  | 'extraction_failed';

export interface InvoiceMatchResult {
  status: MatchStatus;
  matches?: MatchCandidate[];
  remainingAmount?: number | null;
  error?: string | null;
}

/** Die Zugangsdaten für den technischen Benutzer werden abgeleitet, damit kein Passwort gespeichert werden muss. */
function derivedPassword(config: BanksapiConfig): string {
  const digest = createHmac('sha256', config.basicAuth).update(`kontor-bank-user:${config.tenant}:${config.username}`).digest('hex');
  return `Kt-${digest}`;
}

export class BanksapiClient {
  private clientToken?: { value: string; expiresAt: number };
  private userToken?: { value: string; expiresAt: number };
  private userReady?: Promise<void>;

  constructor(private readonly config: BanksapiConfig) {}

  // ---------- HTTP ----------

  private async http(path: string, init: RequestInit & { redirect?: 'manual' } = {}): Promise<Response> {
    return fetch(`${this.config.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
  }

  private async fail(res: Response, what: string): Promise<never> {
    // Nur Statuscode und Fehlermeldung weitergeben, niemals Header oder Tokens.
    const body = await res.text().catch(() => '');
    let detail = '';
    try {
      const json = JSON.parse(body);
      detail = json.error_description ?? json.message ?? json.error ?? '';
      if (!detail && Array.isArray(json.messages)) detail = json.messages.map((m: { message?: string }) => m.message).join('; ');
    } catch {
      detail = body.slice(0, 200);
    }
    throw new BanksapiError(`${what} fehlgeschlagen (HTTP ${res.status}${detail ? `: ${detail}` : ''})`, res.status);
  }

  // ---------- Auth ----------

  private async token(form: Record<string, string>, what: string) {
    const res = await this.http('/auth/oauth2/token', {
      method: 'POST',
      headers: { Authorization: this.config.basicAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    if (!res.ok) return this.fail(res, what);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    // 5 Minuten Sicherheitsabstand zur Ablaufzeit
    return { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 };
  }

  private async getClientToken(): Promise<string> {
    if (!this.clientToken || this.clientToken.expiresAt < Date.now()) {
      this.clientToken = await this.token({ grant_type: 'client_credentials' }, 'Anmeldung am BANKSapi-Mandanten');
    }
    return this.clientToken.value;
  }

  /** Legt den technischen Benutzer beim ersten Aufruf an. */
  private ensureUser(): Promise<void> {
    this.userReady ??= (async () => {
      const password = derivedPassword(this.config);
      const login = () =>
        this.token({ grant_type: 'password', username: this.config.username, password }, 'Anmeldung des BANKSapi-Benutzers');
      try {
        this.userToken = await login();
      } catch (err) {
        if (!(err instanceof BanksapiError) || err.status >= 500) throw err;
        const res = await this.http(`/auth/mgmt/v1/tenants/${encodeURIComponent(this.config.tenant)}/users`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await this.getClientToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.config.username, password }),
        });
        if (res.status === 409) {
          throw new BanksapiError(
            `Der BANKSapi-Benutzer "${this.config.username}" existiert bereits mit anderem Passwort. Setze BANKSAPI_USERNAME auf einen neuen Namen.`,
            409,
          );
        }
        if (!res.ok) await this.fail(res, 'Anlegen des BANKSapi-Benutzers');
        this.userToken = await login();
      }
    })().catch((err) => {
      this.userReady = undefined; // beim nächsten Aufruf erneut versuchen
      throw err;
    });
    return this.userReady;
  }

  private async getUserToken(): Promise<string> {
    await this.ensureUser();
    if (!this.userToken || this.userToken.expiresAt < Date.now()) {
      this.userToken = await this.token(
        { grant_type: 'password', username: this.config.username, password: derivedPassword(this.config) },
        'Anmeldung des BANKSapi-Benutzers',
      );
    }
    return this.userToken.value;
  }

  private async user(path: string, init: RequestInit = {}, customerIp?: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getUserToken()}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (customerIp) headers['Customer-IP-Address'] = customerIp;
    return this.http(path, { ...init, headers, redirect: 'manual' });
  }

  // ---------- Bankzugänge ----------

  async listAccesses(): Promise<BankAccess[]> {
    const res = await this.user('/customer/v2/bankzugaenge');
    if (!res.ok) return this.fail(res, 'Abruf der Bankzugänge');
    const json = (await res.json()) as Record<string, BankAccess>;
    return Object.values(json ?? {});
  }

  /** Startet eine REG/Protect-Sitzung. Der Rückgabewert ist der Sitzungslink für die Web Component. */
  private async regprotectLink(path: string, init: RequestInit, callbackUrl: string, customerIp?: string): Promise<string> {
    const res = await this.user(path, init, customerIp);
    const location = res.headers.get('Location');
    if (res.status !== 451 || !location) return this.fail(res, 'Start der Bankanbindung');
    return `${location}${location.includes('?') ? '&' : '?'}callbackUrl=${encodeURIComponent(callbackUrl)}`;
  }

  /** Alte, ggf. abgebrochene REG/Protect-Sitzungen verwerfen (Empfehlung der BANKSapi-Doku). */
  private async deleteSessions(): Promise<void> {
    const res = await this.user('/customer/v2/regprotect/sessions', { method: 'DELETE' });
    if (!res.ok) await this.fail(res, 'Aufräumen alter REG/Protect-Sitzungen');
  }

  async startBankAccess(callbackBase: string, customerIp?: string): Promise<{ accessId: string; sessionLink: string }> {
    await this.deleteSessions();
    const accessId = randomUUID(); // bewusst neu, nicht die Benutzer-ID
    const sessionLink = await this.regprotectLink(
      '/customer/v2/bankzugaenge',
      { method: 'POST', body: JSON.stringify({ [accessId]: {} }) },
      `${callbackBase}${callbackBase.includes('?') ? '&' : '?'}bankAccess=${accessId}`,
      customerIp,
    );
    return { accessId, sessionLink };
  }

  /** Zustimmung (SCA) für einen bestehenden Bankzugang erneuern. */
  async startConsentRenewal(accessId: string, callbackBase: string, customerIp?: string): Promise<string> {
    const access = (await this.listAccesses()).find((a) => a.id === accessId);
    const sca = access?.relations?.find((r) => r.rel === 'start_sca');
    if (!sca) throw new BanksapiError('Für diesen Bankzugang ist keine Erneuerung der Zustimmung nötig.', 409);
    const url = new URL(sca.href);
    if (url.origin !== new URL(this.config.baseUrl).origin) throw new BanksapiError('Unerwartete Relation von BANKSapi', 502);
    await this.deleteSessions();
    return this.regprotectLink(
      url.pathname + url.search,
      { method: 'POST', body: '{}' },
      `${callbackBase}${callbackBase.includes('?') ? '&' : '?'}bankAccess=${accessId}`,
      customerIp,
    );
  }

  /**
   * Stößt bei der Bank einen Abruf an. Gibt false zurück, wenn dafür eine neue Zustimmung (SCA) nötig ist;
   * dann bleiben die zuletzt abgerufenen Umsätze nutzbar.
   */
  async refreshAccess(accessId: string, customerIp?: string): Promise<boolean> {
    const res = await this.user(
      '/customer/v2/bankzugaenge?refresh=true',
      { method: 'POST', body: JSON.stringify({ [accessId]: {} }) },
      customerIp,
    );
    if (res.status === 451) return false;
    if (!res.ok) await this.fail(res, 'Aktualisierung des Bankzugangs');
    return true;
  }

  // ---------- Umsätze ----------

  async transactions(accessId: string, productId: string, fromIso: string): Promise<BankTransaction[]> {
    const qs = new URLSearchParams({ from: `${fromIso}T00:00:00` });
    const res = await this.user(
      `/customer/v2/bankzugaenge/${encodeURIComponent(accessId)}/${encodeURIComponent(productId)}/kontoumsaetze?${qs}`,
    );
    if (!res.ok) return this.fail(res, 'Abruf der Kontoumsätze');
    return (await res.json()) as BankTransaction[];
  }

  // ---------- AI/Connect ----------

  async matchInvoices(body: {
    invoices: ExtractedInvoice[];
    invoiceDirection: 'receivable' | 'payable';
    excludeTransactions: TransactionRef[];
    searchWindowDays?: number;
  }): Promise<InvoiceMatchResult[]> {
    const res = await this.user('/customer/v2/ai/invoice-matching/', { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 403) {
      throw new BanksapiError('AI/Connect (Rechnungsabgleich) ist für diesen BANKSapi-Mandanten nicht freigeschaltet.', 403);
    }
    if (!res.ok) return this.fail(res, 'Rechnungsabgleich (AI/Connect)');
    return (await res.json()) as InvoiceMatchResult[];
  }
}

let shared: BanksapiClient | null | undefined;

/** Gemeinsamer Client; null, wenn BANKSAPI_TENANT / BANKSAPI_BASIC_AUTH fehlen. */
export function banksapi(): BanksapiClient | null {
  if (shared === undefined) {
    const config = banksapiConfig();
    shared = config ? new BanksapiClient(config) : null;
  }
  return shared;
}
