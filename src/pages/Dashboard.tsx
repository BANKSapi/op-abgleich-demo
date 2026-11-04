import { useEffect, useState } from 'react';
import { api, type Summary } from '../api';
import { formatCents, formatDate } from '../format';

export function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    api.summary().then(setSummary);
  }, []);

  if (!summary) return <p className="muted">Lade …</p>;

  return (
    <>
      <header className="page-header">
        <h1>Übersicht</h1>
        <a className="button" href="#/rechnungen/neu">
          Neue Rechnung
        </a>
      </header>

      <section className="cards">
        <a className="card" href="#/rechnungen">
          <span className="card-label">Offene Posten</span>
          <strong className="card-value">{formatCents(summary.open_cents)}</strong>
          <span className="muted">{summary.open_count} Rechnungen</span>
        </a>
        <a className="card card-warning" href="#/rechnungen">
          <span className="card-label">Davon überfällig</span>
          <strong className="card-value">{formatCents(summary.overdue_cents)}</strong>
          <span className="muted">{summary.overdue_count} Rechnungen</span>
        </a>
      </section>

      <section className="panel">
        <h2>Zuletzt erfasste Zahlungen</h2>
        {summary.recent_payments.length === 0 ? (
          <p className="muted">Noch keine Zahlungen erfasst.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Rechnung</th>
                <th>Kunde</th>
                <th className="num">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {summary.recent_payments.map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.booked_on)}</td>
                  <td>
                    <a href={`#/rechnungen/${p.invoice_id}`}>{p.invoice_number}</a>
                  </td>
                  <td>{p.customer_name}</td>
                  <td className="num">{formatCents(p.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
