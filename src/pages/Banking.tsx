import { useCallback, useEffect, useState } from 'react';
import { api, type BankingState } from '../api';
import { formatCents, formatDate } from '../format';
import { BankConnection, BANK_SESSION_KEY } from '../components/BankConnection';

const statuses: Record<string, string> = {
  not_checked: 'Noch nicht abgeglichen', matched: 'Treffer prüfen', likely_matched: 'Möglicher Treffer',
  partially_matched: 'Teilzahlung', possible_batch: 'Mögliche Sammelzahlung', overpaid: 'Überzahlung',
  unmatched: 'Kein eindeutiger Treffer', extraction_failed: 'Abgleich nicht möglich',
};

export function Banking() {
  const [state, setState] = useState<BankingState | null>(null);
  const [session, setSession] = useState<{ token: string; expiresAt: number } | null>(null);
  const [manager, setManager] = useState(() => Boolean(sessionStorage.getItem(BANK_SESSION_KEY)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try { setState(await api.banking()); } catch (error) { setError((error as Error).message); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const refreshToken = useCallback(() => {
    void api.bankingSession(true).then(setSession, (error: Error) => setError(error.message));
  }, []);
  useEffect(() => {
    if (!manager) return;
    if (!session) { refreshToken(); return; }
    const timer = setTimeout(refreshToken, Math.max(session.expiresAt - Date.now() - 60_000, 1000));
    return () => clearTimeout(timer);
  }, [manager, session, refreshToken]);

  const run = useCallback(async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.reconcile();
      setMessage(`${result.checked_count} offene Posten geprüft, ${result.booked_count} Zahlungen automatisch zugeordnet.`);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); await load(); }
  }, [load]);
  const complete = useCallback(() => { setManager(false); setSession(null); void run(); }, [run]);

  async function assign(invoiceId: number, transactionId: number) {
    setBusy(true); setError(''); setMessage('');
    try {
      await api.assignBankPayment(invoiceId, transactionId);
      setMessage('Zahlung zugeordnet. Der offene Rechnungsbetrag wurde aktualisiert.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); await load(); }
  }
  async function ignore(transactionId: number) {
    setBusy(true); setError('');
    try { await api.ignoreBankTransaction(transactionId); setMessage('Bankumsatz wird bei weiteren Abgleichen ausgeschlossen.'); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); await load(); }
  }

  const running = busy || state?.last_run?.status === 'running';
  return <>
    <header className="page-header">
      <div><h1>Bankabgleich</h1><p className="muted">Zahlungseingänge mit offenen Posten abgleichen</p></div>
      <button disabled={!state?.initialized || running} onClick={() => void run()}>{running ? 'Abgleich läuft …' : 'Jetzt abgleichen'}</button>
    </header>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="bank-notice" role="status">{message}</p>}
    {!state ? <p className="muted">Lade Bankabgleich …</p> : <>
      <section className="panel">
        <div className="toolbar bank-toolbar">
          <div><h2>Bankverbindungen</h2><p className="muted">Bankkonto verbinden oder eine abgelaufene Bankfreigabe erneuern.</p></div>
          <button className="secondary" disabled={!state.configured || busy} onClick={() => {
            setError('');
            if (manager) { setManager(false); setSession(null); sessionStorage.removeItem(BANK_SESSION_KEY); }
            else setManager(true);
          }}>{manager ? 'Schließen' : state.initialized ? 'Bankverbindungen verwalten' : 'Bankkonto verbinden'}</button>
        </div>
        {!state.configured && <p className="error">Die BANKSapi-Zugangsdaten fehlen in der Serverkonfiguration.</p>}
        {manager && session && <BankConnection token={session.token} onComplete={complete} onError={setError} onRefreshToken={refreshToken} />}
        {manager && !session && <p className="muted">Bankverbindung wird vorbereitet … <button className="link" onClick={refreshToken}>Erneut versuchen</button></p>}
        <p className="muted">Eindeutige Treffer ab 90 % Sicherheit und mit genau passendem Betrag werden automatisch gebucht. Teilzahlungen, Skonto und Sammelzahlungen bleiben zur Prüfung offen.</p>
        {state.last_run && <p className={state.last_run.status === 'failed' ? 'error' : 'muted'}>
          Letzter Abgleich: {state.last_run.started_at} UTC · {state.last_run.status === 'running' ? 'läuft' : state.last_run.status === 'failed' ? state.last_run.error : `${state.last_run.booked_count} Zahlungen automatisch gebucht`}
        </p>}
      </section>

      <section className="panel">
        <h2>Offene Posten und Zuordnungsvorschläge</h2>
        {state.results.length === 0 ? <p className="muted">Alle Rechnungen sind bezahlt.</p> : state.results.map(({ invoice, status, candidates }) => <article className="bank-result" key={invoice.id}>
          <div className="toolbar bank-toolbar">
            <div><a href={`#/rechnungen/${invoice.id}`}><strong>{invoice.number}</strong></a> · {invoice.customer_name}<br /><small className="muted">{statuses[status] ?? status}</small></div>
            <strong>Offen: {formatCents(invoice.open_cents)}</strong>
          </div>
          {candidates.length > 0 && <div className="table-scroll"><table>
            <thead><tr><th>Bankumsatz</th><th>Buchung</th><th className="num">Betrag</th><th>Begründung</th><th /></tr></thead>
            <tbody>{candidates.map((candidate, index) => {
              const transaction = candidate.bank_transaction;
              return <tr key={`${transaction?.id ?? 'unknown'}-${index}`}>
                <td>{transaction?.counterparty || 'Umsatz nicht eindeutig verfügbar'}<br /><small className="muted">{transaction?.purpose}</small></td>
                <td>{transaction ? formatDate(transaction.booked_on) : '–'}</td>
                <td className="num">{transaction ? `${formatCents(transaction.amount_cents).replace(/\s*€$/, '')} ${transaction.currency || '?'}` : '–'}</td>
                <td><strong>{Math.round(candidate.confidence * 100)} %</strong><br /><small className="muted">{[
                  candidate.signals.ibanMatch && 'IBAN stimmt überein',
                  candidate.signals.referenceContainsInvoiceNumber && 'Rechnungsnummer gefunden',
                  candidate.signals.amountMatch === 'exact' && 'Betrag passt',
                  candidate.delta !== 0 && `Abweichung ${formatCents(Math.round(candidate.delta * 100))}`,
                ].filter(Boolean).join(' · ') || 'Weitere Prüfung erforderlich'}</small></td>
                <td>{candidate.available && transaction ? <div className="bank-actions">
                  <button disabled={running} onClick={() => void assign(invoice.id, transaction.id)}>Zuordnen</button>
                  <button className="link" disabled={running} onClick={() => void ignore(transaction.id)}>Ausschließen</button>
                </div> : <small className="muted">{transaction && transaction.amount_cents > invoice.open_cents ? 'Betrag übersteigt offenen Posten – manuell prüfen' : 'Nicht für Zuordnung verfügbar'}</small>}</td>
              </tr>;
            })}</tbody>
          </table></div>}
        </article>)}
      </section>

      <section className="panel">
        <h2>Zuletzt bearbeitete Bankumsätze</h2>
        {!state.history.length ? <p className="muted">Noch keine Bankumsätze zugeordnet.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Buchung</th><th>Auftraggeber</th><th>Rechnung</th><th>Verarbeitung</th><th className="num">Betrag</th></tr></thead>
          <tbody>{state.history.map(transaction => <tr key={transaction.id}>
            <td>{formatDate(transaction.booked_on)}</td><td>{transaction.counterparty}</td>
            <td>{transaction.invoice_id ? <a href={`#/rechnungen/${transaction.invoice_id}`}>{transaction.invoice_number}</a> : '–'}</td>
            <td>{!transaction.payment_id ? transaction.source === 'ignored' ? 'Ausgeschlossen' : 'Zahlung entfernt · ausgeschlossen' : transaction.source === 'automatic' ? 'Automatisch · AI/Connect' : 'Geprüft zugeordnet'}</td>
            <td className="num">{formatCents(transaction.amount_cents)}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </>}
  </>;
}
