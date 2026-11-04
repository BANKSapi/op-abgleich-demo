import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BankStatus, type BankTransaction, type MatchSuggestion } from '../api';
import { RegProtect, describeReentry } from '../components/RegProtect';
import { formatCents, formatDate } from '../format';

/** Wie die Seite geöffnet wurde: normal, nach Bank-Redirect (SCA) oder über die callbackUrl. */
export type BankEntry = { kind: 'reentry' } | { kind: 'callback'; url: string };

const matchTypeLabels: Record<string, string> = {
  exact: 'IBAN, Betrag und Rechnungsnummer',
  strong: 'IBAN und Betrag',
  reference_only: 'Rechnungsnummer im Verwendungszweck',
  amount_only: 'Nur Betrag',
  skonto: 'Betrag abzüglich Skonto',
  partial: 'Teilzahlung',
  fuzzy: 'Schwache Hinweise',
  possible_batch: 'Mögliche Sammelüberweisung',
};

const resultStatusLabels: Record<string, string> = {
  overpaid: 'Überzahlung',
  possible_batch: 'Sammelüberweisung',
  partially_matched: 'Teilzahlung',
  likely_matched: 'Wahrscheinlich',
};

const formatPercent = (value: number) => `${Math.round(value * 100)} %`;
const formatTimestamp = (iso: string) =>
  new Date(iso.includes('T') ? iso : iso.replace(' ', 'T')).toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

interface Props {
  entry?: BankEntry;
  onEntryHandled?: () => void;
}

export function BankReconciliation({ entry, onEntryHandled }: Props) {
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [suggestions, setSuggestions] = useState<MatchSuggestion[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Aktiver REG/Protect-Vorgang ('' = Rückkehr nach Redirect-SCA, Sitzung wird von der Komponente wiederhergestellt)
  const [sessionLink, setSessionLink] = useState<string | null>(entry?.kind === 'reentry' ? '' : null);

  const load = useCallback(async () => {
    try {
      const [s, sug, tx] = await Promise.all([api.bank.status(), api.bank.suggestions(), api.bank.transactions()]);
      setStatus(s);
      setSuggestions(sug);
      setTransactions(tx);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
        load();
      }
    },
    [load],
  );

  const reconcile = useCallback(
    () =>
      run('reconcile', async () => {
        const r = await api.bank.reconcile();
        setNotice(
          `Abgleich abgeschlossen: ${r.booked} Zahlung(en) automatisch gebucht, ${r.suggested} Vorschlag/Vorschläge zur Prüfung, ${r.unmatched} Rechnung(en) ohne passenden Zahlungseingang.`,
        );
      }),
    [run],
  );

  const finishRegProtect = useCallback(
    (callbackUrl: string) => {
      setSessionLink(null);
      onEntryHandled?.();
      const result = describeReentry(callbackUrl);
      setNotice(result.message);
      if (result.success) reconcile();
      else load();
    },
    [load, onEntryHandled, reconcile],
  );

  // Rückkehr über die callbackUrl (ohne Event der Web Component); nur einmal auswerten
  const callbackHandled = useRef(false);
  useEffect(() => {
    if (entry?.kind !== 'callback' || callbackHandled.current) return;
    callbackHandled.current = true;
    finishRegProtect(entry.url);
  }, [entry, finishRegProtect]);

  const accesses = status?.accesses ?? [];

  if (sessionLink !== null) {
    return (
      <>
        <header className="page-header">
          <div>
            <span className="muted">Bankabgleich</span>
            <h1>Bankkonto verbinden</h1>
          </div>
          <button
            className="secondary"
            onClick={() => {
              setSessionLink(null);
              onEntryHandled?.();
              load();
            }}
          >
            Abbrechen
          </button>
        </header>
        <p className="muted">
          Bankauswahl, Online-Banking-Zugangsdaten und TAN werden direkt bei BANKSapi (REG/Protect) eingegeben. Kontor
          erhält nur die Kontoumsätze.
        </p>
        <section className="panel">
          <RegProtect sessionLink={sessionLink} onFinished={finishRegProtect} />
        </section>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <h1>Bankabgleich</h1>
        <button onClick={reconcile} disabled={busy !== null || accesses.length === 0}>
          {busy === 'reconcile' ? 'Abgleich läuft …' : 'Abgleich starten'}
        </button>
      </header>

      {error && <p className="notice notice-error">{error}</p>}
      {notice && (
        <p className="notice">
          {notice}{' '}
          <button className="link" onClick={() => setNotice(null)}>
            Ausblenden
          </button>
        </p>
      )}

      <section className="panel">
        <div className="toolbar">
          <h2>Bankverbindung</h2>
          {status && accesses.length > 0 && (
            <button
              className="secondary"
              disabled={busy !== null}
              onClick={() => run('connect', async () => setSessionLink((await api.bank.connect()).sessionLink))}
            >
              Weiteres Konto verbinden
            </button>
          )}
        </div>
        {!status && !error ? (
          <p className="muted">Lade …</p>
        ) : accesses.length === 0 ? (
          <div className="empty">
            <p className="muted">
              Verbinden Sie Ihr Geschäftskonto, damit Zahlungseingänge automatisch den offenen Posten zugeordnet werden.
            </p>
            <button
              disabled={busy !== null || !status}
              onClick={() => run('connect', async () => setSessionLink((await api.bank.connect()).sessionLink))}
            >
              Bankkonto verbinden
            </button>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Konto</th>
                <th>IBAN</th>
                <th>Stand</th>
                <th className="num">Saldo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accesses.map((access) => (
                <tr key={access.id}>
                  <td>
                    {access.products.length === 0 ? (
                      <span className="muted">Wird eingerichtet …</span>
                    ) : (
                      access.products.map((p) => (
                        <div key={p.id}>
                          {p.name} <span className="muted">{[p.bank, p.owner].filter(Boolean).join(' · ')}</span>
                        </div>
                      ))
                    )}
                    {access.needs_sca && <div className="warning-text">Zustimmung bei der Bank abgelaufen</div>}
                  </td>
                  <td className="mono">
                    {access.products.map((p) => (
                      <div key={p.id}>{p.iban ?? '–'}</div>
                    ))}
                  </td>
                  <td>{access.updated_at ? formatTimestamp(access.updated_at) : '–'}</td>
                  <td className="num">
                    {access.products.map((p) => (
                      <div key={p.id}>{p.balance === null ? '–' : formatCents(Math.round(p.balance * 100))}</div>
                    ))}
                  </td>
                  <td className="num actions-inline">
                    {access.needs_sca ? (
                      <button
                        className="link"
                        disabled={busy !== null}
                        onClick={() =>
                          run('sca', async () => setSessionLink((await api.bank.renewConsent(access.id)).sessionLink))
                        }
                      >
                        Zustimmung erneuern
                      </button>
                    ) : (
                      <button
                        className="link"
                        disabled={busy !== null}
                        onClick={() =>
                          run('refresh', async () => {
                            const r = await api.bank.refresh(access.id);
                            if (r.session) setSessionLink(r.session.sessionLink);
                            else if (r.run)
                              setNotice(
                                `Umsätze aktualisiert: ${r.run.booked} Zahlung(en) gebucht, ${r.run.suggested} Vorschlag/Vorschläge zur Prüfung.`,
                              );
                          })
                        }
                      >
                        {busy === 'refresh' ? 'Aktualisiere …' : 'Umsätze aktualisieren'}
                      </button>
                    )}
                    <button
                      className="link danger"
                      disabled={busy !== null}
                      onClick={() => {
                        if (!confirm('Bankverbindung wirklich trennen? Bereits gebuchte Zahlungen bleiben erhalten.')) return;
                        run('disconnect', () => api.bank.disconnect(access.id));
                      }}
                    >
                      Trennen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {status?.last_run && (
          <p className="muted small">
            Letzter Abgleich {formatTimestamp(status.last_run.at)}: {status.last_run.invoices} offene Rechnungen geprüft,{' '}
            {status.last_run.booked} gebucht, {status.last_run.suggested} zur Prüfung. Automatisch gebucht wird nur bei
            eindeutigem Treffer (exakter Betrag, IBAN oder Rechnungsnummer, Sicherheit ab{' '}
            {formatPercent(status.auto_book_confidence)}).
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Zu prüfen {suggestions.length > 0 && <span className="muted">({suggestions.length})</span>}</h2>
        {suggestions.length === 0 ? (
          <p className="muted">Keine offenen Vorschläge.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rechnung</th>
                <th>Zahlungseingang</th>
                <th>Hinweis</th>
                <th className="num">Buchen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={`#/rechnungen/${s.invoice_id}`}>{s.invoice_number}</a>
                    <div className="muted">{s.customer_name}</div>
                    <div className="muted">
                      {formatCents(s.invoice_amount_cents)} · fällig {formatDate(s.invoice_due_date)}
                    </div>
                  </td>
                  <td>
                    {formatDate(s.booked_on)} · <strong>{formatCents(s.transaction_amount_cents)}</strong>
                    <div>{s.counterparty_name || <span className="muted">Auftraggeber unbekannt</span>}</div>
                    <div className="muted purpose">{s.purpose || '–'}</div>
                  </td>
                  <td>
                    {matchTypeLabels[s.match_type] ?? s.match_type}
                    {resultStatusLabels[s.result_status] && (
                      <span className="badge badge-teilbezahlt">{resultStatusLabels[s.result_status]}</span>
                    )}
                    <div className="muted">Sicherheit {formatPercent(s.confidence)}</div>
                    {s.notes.length > 0 && <div className="muted small">{s.notes.join(' · ')}</div>}
                  </td>
                  <td className="num">{formatCents(s.amount_cents)}</td>
                  <td className="num actions-inline">
                    <button
                      disabled={busy !== null}
                      onClick={() => run(`confirm-${s.id}`, () => api.bank.confirm(s.id))}
                    >
                      Buchen
                    </button>
                    <button
                      className="secondary"
                      disabled={busy !== null}
                      onClick={() => run(`reject-${s.id}`, () => api.bank.reject(s.id))}
                    >
                      Ablehnen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Zahlungseingänge</h2>
        {transactions.length === 0 ? (
          <p className="muted">Noch keine Zahlungseingänge abgerufen.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Buchungstag</th>
                <th>Auftraggeber</th>
                <th>Verwendungszweck</th>
                <th className="num">Betrag</th>
                <th>Zugeordnet</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={`${t.access_id}|${t.product_id}|${t.id}`}>
                  <td>{formatDate(t.booked_on)}</td>
                  <td>
                    {t.counterparty_name || '–'}
                    {t.counterparty_iban && <div className="muted mono">{t.counterparty_iban}</div>}
                  </td>
                  <td className="purpose">{t.purpose || '–'}</td>
                  <td className="num">{formatCents(t.amount_cents)}</td>
                  <td>
                    {t.allocations.length === 0 ? (
                      <span className="muted">–</span>
                    ) : (
                      t.allocations.map((a) => (
                        <div key={a.invoice_id}>
                          <a href={`#/rechnungen/${a.invoice_id}`}>{a.invoice_number}</a>
                          {a.amount_cents !== t.amount_cents && (
                            <span className="muted"> ({formatCents(a.amount_cents)})</span>
                          )}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
