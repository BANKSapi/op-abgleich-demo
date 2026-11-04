import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BankAccess, type BankStatus, type ReconcileResult, type RegprotectSession, type Suggestion } from '../api';
import { formatCents, formatDate } from '../format';

const SESSION_KEY = 'kontor.regprotect-session';

const matchLabels: Record<string, string> = {
  exact: 'IBAN, Betrag und Rechnungsnummer',
  strong: 'IBAN und Betrag',
  reference_only: 'Rechnungsnummer im Verwendungszweck',
  amount_only: 'Nur Betrag',
  skonto: 'Betrag nach Skonto',
  partial: 'Teilzahlung',
  fuzzy: 'Schwache Übereinstimmung',
  possible_batch: 'Mögliche Sammelüberweisung',
};

/** Hinweise, die vor dem Verbuchen besonders ins Auge fallen sollen. */
function caution(s: Suggestion): string | null {
  if (s.match_status === 'possible_batch') return 'Der Umsatz könnte mehrere Rechnungen bezahlen.';
  if (s.match_status === 'overpaid' || s.amount_cents > s.open_cents) return 'Der Umsatz ist höher als der offene Betrag; nur der offene Betrag wird verbucht.';
  if (s.match_status === 'partially_matched' || s.amount_cents < s.open_cents) return 'Der Umsatz deckt den offenen Betrag nicht vollständig.';
  return null;
}

const resultMessages: Record<string, string> = {
  ACCOUNT_CREATED: 'Das Bankkonto wurde verbunden.',
  AUTHENTICATED: 'Die Zustimmung wurde erneuert.',
};

/** REG/Protect (WEB/Connect) als Web Component einbetten; die Sitzung hat das Backend gestartet. */
function RegprotectFrame({ session, onDone }: { session: RegprotectSession; onDone: (baReentry: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let element: HTMLElement | null = null;
    let cancelled = false;
    const onSubscribed = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      let reentry: string | null = null;
      try {
        reentry = new URL(detail).searchParams.get('baReentry');
      } catch {
        // detail ist keine URL: als unbekannt behandeln
      }
      sessionStorage.removeItem(SESSION_KEY);
      done.current(reentry);
    };
    // Das Bundle ist ~1 MB groß und wird deshalb erst bei Bedarf geladen.
    import('@banksapitechnology/regprotect-web-component').then(() => {
      if (cancelled || !container.current) return;
      element = document.createElement('ba-regprotect');
      Object.assign(element, { sessionLink: session.session_link, reentryUrl: session.reentry_url });
      element.addEventListener('subscribed', onSubscribed);
      container.current.appendChild(element);
    });
    return () => {
      cancelled = true;
      element?.removeEventListener('subscribed', onSubscribed);
      element?.remove();
    };
  }, [session]);

  return <div ref={container} className="regprotect" />;
}

export function Bank() {
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [session, setSession] = useState<RegprotectSession | null>(null);
  const [result, setResult] = useState<ReconcileResult | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.bankStatus());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.search);
    if (params.has('baReentry') || params.has('bankReentry') || params.has('bankAccess')) {
      const code = params.get('baReentry');
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (params.has('bankReentry') && stored) {
        // Rückkehr von der Bank nach Redirect-SCA: Web Component muss neu aufgebaut werden
        setSession(JSON.parse(stored) as RegprotectSession);
      } else if (code) {
        report(code);
      }
      history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    }
  }, [load]);

  function report(code: string | null) {
    if (code && resultMessages[code]) {
      setNotice(resultMessages[code]);
      setError(null);
    } else {
      setError(`Die Bankanbindung wurde nicht abgeschlossen${code ? ` (${code})` : ''}.`);
    }
  }

  async function run<T>(name: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      return await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function startSession(start: () => Promise<RegprotectSession>) {
    const s = await run('connect', start);
    if (s) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      setSession(s);
    }
  }

  async function reconcile(refresh: boolean) {
    const r = await run('reconcile', () => api.bankReconcile(refresh));
    if (r) setResult(r);
    await load();
  }

  async function decide(s: Suggestion, action: 'confirm' | 'reject') {
    await run(`${action}-${s.id}`, async () => {
      if (action === 'confirm') await api.confirmSuggestion(s.id);
      else await api.rejectSuggestion(s.id);
    });
    await load();
  }

  if (session) {
    return (
      <>
        <header className="page-header">
          <h1>Bankkonto verbinden</h1>
          <button className="secondary" onClick={() => { sessionStorage.removeItem(SESSION_KEY); setSession(null); }}>
            Abbrechen
          </button>
        </header>
        <section className="panel">
          <RegprotectFrame
            session={session}
            onDone={(code) => {
              setSession(null);
              report(code);
              void load();
            }}
          />
        </section>
      </>
    );
  }

  const accesses: BankAccess[] = status?.accesses ?? [];
  const connected = accesses.some((a) => a.products.length > 0);

  return (
    <>
      <header className="page-header">
        <h1>Bankabgleich</h1>
        {status?.configured && (
          <button onClick={() => startSession(api.bankConnect)} disabled={!!busy}>
            {connected ? 'Weiteres Konto verbinden' : 'Bankkonto verbinden'}
          </button>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      {!status && !error && <p className="muted">Lade …</p>}
      {status && !status.configured && (
        <section className="panel">
          <p>
            BANKSapi ist nicht konfiguriert. Trage <code>BANKSAPI_TENANT</code> und <code>BANKSAPI_BASIC_AUTH</code> in der
            Datei <code>.env</code> ein und starte die API neu.
          </p>
        </section>
      )}

      {status?.configured && (
        <>
          <section className="panel">
            <h2>Verbundene Konten</h2>
            {accesses.length === 0 ? (
              <p className="muted">Noch kein Bankkonto verbunden. Über „Bankkonto verbinden“ meldest du dich bei deiner Bank an.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Konto</th>
                    <th>IBAN</th>
                    <th>Letzter Abruf</th>
                    <th className="num">Saldo</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {accesses.flatMap((a) =>
                    (a.products.length ? a.products : [null]).map((p, i) => (
                      <tr key={`${a.id}-${p?.id ?? i}`}>
                        <td>
                          {p ? `${p.bank} ${p.name}`.trim() : 'Verbindung wird eingerichtet …'}
                          {a.messages.map((m) => (
                            <div key={m} className="error">{m}</div>
                          ))}
                        </td>
                        <td className="mono">{p?.iban ?? '–'}</td>
                        <td>{a.updated_at ? formatDate(a.updated_at.slice(0, 10)) : '–'}</td>
                        <td className="num">{p?.balance != null ? formatCents(Math.round(p.balance * 100)) : '–'}</td>
                        <td className="num">
                          {a.needs_sca && (
                            <button className="secondary" disabled={!!busy} onClick={() => startSession(() => api.bankRenew(a.id))}>
                              Zustimmung erneuern
                            </button>
                          )}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            )}
          </section>

          {connected && (
            <section className="panel">
              <div className="toolbar">
                <h2>Zahlungsabgleich</h2>
                <div className="actions">
                  <button className="secondary" disabled={!!busy} onClick={() => reconcile(false)}>
                    Nur abgleichen
                  </button>
                  <button disabled={!!busy} onClick={() => reconcile(true)}>
                    {busy === 'reconcile' ? 'Gleiche ab …' : 'Umsätze abrufen und abgleichen'}
                  </button>
                </div>
              </div>
              <p className="muted">
                Die Zuordnung der Zahlungseingänge zu offenen Rechnungen übernimmt AI/Connect. Eindeutige Treffer (IBAN, Betrag und
                Rechnungsnummer stimmen) werden direkt verbucht, alles andere erscheint unten zur Bestätigung.
              </p>
              {result && (
                <p className="notice">
                  {result.checked_invoices} offene Rechnungen geprüft: {result.booked} automatisch verbucht, {result.suggested}{' '}
                  zur Bestätigung, {result.unmatched} ohne passenden Zahlungseingang.
                  {result.needs_sca.length > 0 &&
                    ' Für einen frischen Abruf bei der Bank ist eine neue Zustimmung nötig; es wurden die zuletzt abgerufenen Umsätze verwendet.'}
                </p>
              )}
            </section>
          )}

          {status.suggestions.length > 0 && (
            <section className="panel">
              <h2>Zur Bestätigung ({status.suggestions.length})</h2>
              <table>
                <thead>
                  <tr>
                    <th>Rechnung</th>
                    <th>Bankumsatz</th>
                    <th>Zuordnung</th>
                    <th className="num">Betrag</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.suggestions.map((s) => {
                    const warn = caution(s);
                    return (
                      <tr key={s.id}>
                        <td>
                          <a href={`#/rechnungen/${s.invoice_id}`}>{s.invoice_number}</a>
                          <div className="muted">{s.customer_name}</div>
                          <div className="muted">offen {formatCents(s.open_cents)}</div>
                        </td>
                        <td>
                          {formatDate(s.booked_on)} · {s.counterparty || 'unbekannt'}
                          <div className="muted purpose">{s.purpose}</div>
                        </td>
                        <td>
                          {matchLabels[s.match_type] ?? s.match_type} ({Math.round(s.confidence * 100)} %)
                          {s.notes && <div className="muted">{s.notes}</div>}
                          {warn && <div className="warning-text">{warn}</div>}
                        </td>
                        <td className="num">{formatCents(s.amount_cents)}</td>
                        <td className="num">
                          <div className="actions">
                            <button disabled={!!busy} onClick={() => decide(s, 'confirm')}>Verbuchen</button>
                            <button className="secondary" disabled={!!busy} onClick={() => decide(s, 'reject')}>Ablehnen</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </>
  );
}
