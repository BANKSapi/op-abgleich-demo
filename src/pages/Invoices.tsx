import { useCallback, useEffect, useState } from 'react';
import { api, type Invoice } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PaymentDialog } from '../components/PaymentDialog';
import { formatCents, formatDate } from '../format';

const filters = [
  { value: 'unbezahlt', label: 'Unbezahlt' },
  { value: 'ueberfaellig', label: 'Überfällig' },
  { value: 'bezahlt', label: 'Bezahlt' },
  { value: '', label: 'Alle' },
];

export function Invoices() {
  const [filter, setFilter] = useState('unbezahlt');
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);

  const load = useCallback(() => {
    api.invoices(filter || undefined).then(setInvoices);
  }, [filter]);

  useEffect(load, [load]);

  const totalOpen = invoices?.reduce((sum, i) => sum + i.open_cents, 0) ?? 0;

  return (
    <>
      <header className="page-header">
        <h1>Offene Posten</h1>
        <a className="button" href="#/rechnungen/neu">
          Neue Rechnung
        </a>
      </header>

      <div className="toolbar">
        <div className="segmented">
          {filters.map((f) => (
            <button
              key={f.value}
              className={filter === f.value ? 'active' : undefined}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="muted">Summe offen: {formatCents(totalOpen)}</span>
      </div>

      <section className="panel">
        {!invoices ? (
          <p className="muted">Lade …</p>
        ) : invoices.length === 0 ? (
          <p className="muted">Keine Rechnungen in dieser Ansicht.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rechnung</th>
                <th>Kunde</th>
                <th>Rechnungsdatum</th>
                <th>Fällig</th>
                <th className="num">Betrag</th>
                <th className="num">Offen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <a href={`#/rechnungen/${invoice.id}`}>{invoice.number}</a>
                  </td>
                  <td>{invoice.customer_name}</td>
                  <td>{formatDate(invoice.issue_date)}</td>
                  <td>{formatDate(invoice.due_date)}</td>
                  <td className="num">{formatCents(invoice.amount_cents)}</td>
                  <td className="num">{formatCents(invoice.open_cents)}</td>
                  <td>
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td className="num">
                    {invoice.status !== 'bezahlt' && (
                      <button className="link" onClick={() => setPaying(invoice)}>
                        Zahlung erfassen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {paying && (
        <PaymentDialog
          invoice={paying}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            load();
          }}
        />
      )}
    </>
  );
}
