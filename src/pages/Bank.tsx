import { useCallback, useEffect, useState } from 'react';
import { api, type BankAction, type BankProposal, type BankStatus, type ReconcileResult } from '../api';
import { RegProtect } from '../components/RegProtect';
import { formatCents, formatDate } from '../format';

/** Rückmeldungen aus REG/Protect (baReentry), siehe https://docs.banksapi.de/guide/customer.html */
const reentryMessages: Record<string, { text: string; ok: boolean }> = {
  ACCOUNT_CREATED: { text: 'Bankkonto verbunden. Die Umsätze stehen jetzt für den Abgleich bereit.', ok: true },
  WAITING_FOR_PROVIDER: { text: 'Die Bank braucht etwas länger. Die Umsätze werden im Hintergrund geladen – bitte in ein paar Minuten aktualisieren.', ok: true },
  USER_CANCELLED: { text: 'Vorgang abgebrochen.', ok: false },
  LEGAL_NOT_ACCEPTED: { text: 'Ohne Zustimmung zu den Nutzungsbedingungen von BANKSapi kann kein Konto verbunden werden.', ok: false },
  INVALID_CREDENTIALS: { text: 'Die Zugangsdaten wurden von der Bank abgelehnt.', ok: false },
  INVALID_TAN: { text: 'Die TAN war nicht korrekt.', ok: false },
  ERROR_NO_ACCOUNTS: { text: 'Bei dieser Bank wurden keine Konten gefunden.', ok: false },
  SESSION_TIMEOUT: { text: 'Die Sitzung ist abgelaufen. Bitte erneut starten.', ok: false },
  INVALID_CALLBACK_URL_BASE: { text: 'Die Rücksprungadresse ist bei BANKSapi nicht freigegeben (APP_BASE_URL prüfen).', ok: false },
  CONCURRENT_CREATION_OF_SAME_ACCESS: { text: 'Dieses Konto wird gerade bereits verbunden.', ok: false },
};

function reentryMessage(code: string) {
  return reentryMessages[code] ?? { text: `Die Bankanbindung wurde nicht abgeschlossen (${code}).`, ok: false };
}

const matchTypeLabels: Record<string, string> = {
  exact: 'IBAN, Betrag und Rechnungsnummer',
  strong: 'IBAN und Betrag',
  reference_only: 'Rechnungsnummer im Verwendungszweck',
  amount_only: 'nur Betrag',
  skonto: 'Skonto abgezogen',
  fuzzy: 'Betrag weicht ab',
  partial: 'Teilzahlung',
  possible_batch: 'Sammelüberweisung',
};

const statusLabels: Record<string, string> = {
  matched: 'Treffer',
  likely_matched: 'Wahrscheinlich',
  partially_matched: 'Teilzahlung',
  overpaid: 'Überzahlung',
  possible_batch: 'Sammelüberweisung',
  unmatched: 'Unsicher',
};

const accessStatusLabels: Record<string, string> = {
  VOLLSTAENDIG: 'Aktuell',
  INTERAKTION: 'Aktion nötig',
  IN_BEARBEITUNG: 'Wird geladen',
  FEHLER: 'Fehler',
};

const formatTimestamp = (value: string) => {
  const [date, time] = value.split(/[ T]/);
  return `${formatDate(date)}${time ? `, ${time.slice(0, 5)} Uhr` : ''}`;
};

export function Bank({ reentry }: { reentry?: string }) {
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [proposals, setProposals] = useState<BankProposal[]>([]);
  const [sessionLink, setSessionLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(reentry ? reentryMessage(reentry) : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ReconcileResult | null>(null);

  const load = useCallback(() => {
    api.bankStatus().then(setStatus, (e: Error) => setError(e.message));
    api.bankProposals().then(setProposals, (e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  async function run<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function startInteractive(label: string, action: () => Promise<BankAction>) {
    const outcome = await run(label, action);
    if (!outcome) return;
    if (outcome.done) {
      setNotice({ text: 'Erledigt.', ok: true });
      load();
    } else {
      setNotice(null);
      setSessionLink(outcome.session_link);
    }
  }

  function regProtectFinished(code: string) {
    setSessionLink(null);
    setNotice(reentryMessage(code));
    load();
  }

  async function connect() {
    const response = await run('connect', api.bankConnect);
    if (response) {
      setNotice(null);
      setSessionLink(response.session_link);
    }
  }

  async function disconnect(accessId: string) {
    if (!confirm('Bankverbindung wirklich entfernen? Bereits gebuchte Zahlungen bleiben erhalten.')) return;
    await run('disconnect', () => api.bankDisconnect(accessId));
    load();
  }

  async function reconcile() {
    const response = await run('reconcile', api.bankReconcile);
    if (response) {
      setResult(response);
      load();
    }
  }

  async function decideProposal(id: number, accept: boolean) {
    await run(`proposal-${id}`, () => (accept ? api.acceptProposal(id) : api.dismissProposal(id)));
    load();
  }

  if (sessionLink) {
    return (
      <>
        <header className="page-header">
          <h1>Bankkonto verbinden</h1>
          <button className="secondary" onClick={() => regProtectFinished('USER_CANCELLED')}>
            Abbrechen
          </button>
        </header>
        <p className="muted">
          Bankauswahl, Zugangsdaten und TAN werden direkt bei unserem Kontoinformationsdienst BANKSapi erfasst und nicht in
          Kontor gespeichert.
        </p>
        <section className="panel">
          <RegProtect sessionLink={sessionLink} onFinished={regProtectFinished} />
        </section>
      </>
    );
  }

  const accesses = status?.accesses ?? [];
  const lastRun = status?.last_run;

  return (
    <>
      <header className="page-header">
        <h1>Bankabgleich</h1>
        <button onClick={reconcile} disabled={!accesses.length || busy !== null}>
          {busy === 'reconcile' ? 'Gleiche ab …' : 'Abgleich starten'}
        </button>
      </header>

      {notice && <p className={notice.ok ? 'notice' : 'notice notice-error'}>{notice.text}</p>}
      {error && <p className="notice notice-error">{error}</p>}

      {result && (
        <section className="panel">
          <h2>Ergebnis des Abgleichs</h2>
          <p>
            {result.invoices} offene Rechnungen mit {result.transactions} Zahlungseingängen abgeglichen:{' '}
            <strong>{result.booked.length} automatisch gebucht</strong>, {result.proposed} zur Prüfung, {result.unmatched} ohne
            passende Zahlung.
          </p>
          {result.booked.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Rechnung</th>
                  <th>Kunde</th>
                  <th>Zahlung von</th>
                  <th>Buchungstag</th>
                  <th className="num">Betrag</th>
                </tr>
              </thead>
              <tbody>
                {result.booked.map((b) => (
                  <tr key={b.invoice_id}>
                    <td>
                      <a href={`#/rechnungen/${b.invoice_id}`}>{b.invoice_number}</a>
                    </td>
                    <td>{b.customer_name}</td>
                    <td>{b.counterparty || '–'}</td>
                    <td>{formatDate(b.booked_on)}</td>
                    <td className="num">{formatCents(b.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.warnings.map((w) => (
            <p key={w} className="error">
              {w}
            </p>
          ))}
        </section>
      )}

      <section className="panel">
        <h2>Zu prüfende Zuordnungen</h2>
        {proposals.length === 0 ? (
          <p className="muted">
            {lastRun ? 'Keine offenen Vorschläge.' : 'Noch kein Abgleich durchgeführt.'}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rechnung</th>
                <th>Zahlungseingang</th>
                <th>Einschätzung</th>
                <th className="num">Buchen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={`#/rechnungen/${p.invoice_id}`}>{p.invoice_number}</a>
                    <div className="muted small">
                      {p.customer_name} · offen {formatCents(p.invoice_open_cents)}
                    </div>
                  </td>
                  <td>
                    {formatDate(p.booked_on)} · {formatCents(p.tx_cents)}
                    <div className="muted small">{p.counterparty || 'Auftraggeber unbekannt'}</div>
                    {p.purpose && <div className="muted small purpose">{p.purpose}</div>}
                  </td>
                  <td>
                    {statusLabels[p.match_status] ?? p.match_status} · {Math.round(p.confidence * 100)} %
                    {matchTypeLabels[p.match_type] !== statusLabels[p.match_status] && (
                      <div className="muted small">{matchTypeLabels[p.match_type] ?? p.match_type}</div>
                    )}
                    {p.notes.length > 0 && <div className="muted small" lang="en">{p.notes.join(' · ')}</div>}
                  </td>
                  <td className="num">
                    {formatCents(p.book_cents)}
                    {p.book_cents < p.invoice_open_cents && (
                      <div className="muted small">Rest offen {formatCents(p.invoice_open_cents - p.book_cents)}</div>
                    )}
                  </td>
                  <td className="num nowrap">
                    <button onClick={() => decideProposal(p.id, true)} disabled={busy !== null}>
                      Übernehmen
                    </button>{' '}
                    <button className="secondary" onClick={() => decideProposal(p.id, false)} disabled={busy !== null}>
                      Verwerfen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {lastRun && (
          <p className="muted small">
            Letzter Abgleich: {new Date(lastRun.finished_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
            {lastRun.booked} gebucht · {lastRun.proposed} vorgeschlagen
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Bankkonten</h2>
          {status?.configured && (
            <button className="secondary" onClick={connect} disabled={busy !== null}>
              {busy === 'connect' ? 'Starte …' : 'Bankkonto verbinden'}
            </button>
          )}
        </div>
        {!status ? (
          <p className="muted">Lade …</p>
        ) : !status.configured ? (
          <p className="muted">
            Die Bankanbindung ist nicht eingerichtet. Bitte <code>BANKSAPI_TENANT</code> und <code>BANKSAPI_BASIC_AUTH</code> in der
            Konfiguration hinterlegen.
          </p>
        ) : accesses.length === 0 ? (
          <p className="muted">Noch kein Bankkonto verbunden. Danach werden Zahlungseingänge automatisch den offenen Posten zugeordnet.</p>
        ) : (
          accesses.map((access) => (
            <div key={access.id} className="bank-access">
              <div className="bank-access-header">
                <div>
                  <strong>{access.products[0]?.bank ?? 'Bankzugang'}</strong>{' '}
                  <span className={`badge ${access.status === 'VOLLSTAENDIG' && !access.needs_consent ? 'badge-bezahlt' : 'badge-teilbezahlt'}`}>
                    {access.needs_consent ? 'Zustimmung erneuern' : (accessStatusLabels[access.status] ?? access.status)}
                  </span>
                  {access.updated_at && <div className="muted small">Stand {formatTimestamp(access.updated_at)}</div>}
                </div>
                <div className="actions">
                  {access.needs_consent && (
                    <button onClick={() => startInteractive('consent', () => api.bankConsent(access.id))} disabled={busy !== null}>
                      Zustimmung erneuern
                    </button>
                  )}
                  <button className="secondary" onClick={() => startInteractive('refresh', () => api.bankRefresh(access.id))} disabled={busy !== null}>
                    {busy === 'refresh' ? 'Aktualisiere …' : 'Aktualisieren'}
                  </button>
                  <button className="link" onClick={() => disconnect(access.id)} disabled={busy !== null}>
                    Entfernen
                  </button>
                </div>
              </div>
              {access.messages.map((m) => (
                <p key={m} className="error small">
                  {m}
                </p>
              ))}
              <table>
                <tbody>
                  {access.products.map((product) => (
                    <tr key={product.id}>
                      <td>{product.name}</td>
                      <td className="mono">{product.iban ?? product.id}</td>
                      <td>{product.owner ?? ''}</td>
                      <td className="num">{product.balance === null ? '–' : formatCents(Math.round(product.balance * 100))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </section>
    </>
  );
}

/** Wiedereinstieg nach einer Redirect-SCA bei der Bank: REG/Protect setzt den Vorgang selbst fort. */
export function BankReentry() {
  return (
    <>
      <header className="page-header">
        <h1>Bankkonto verbinden</h1>
      </header>
      <section className="panel">
        <RegProtect onFinished={(code) => window.location.replace(`/#/bank/ergebnis/${encodeURIComponent(code)}`)} />
      </section>
    </>
  );
}
