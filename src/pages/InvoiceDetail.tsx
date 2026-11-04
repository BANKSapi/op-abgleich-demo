import { useCallback, useEffect, useState } from 'react';
import { api, type Invoice } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PaymentDialog } from '../components/PaymentDialog';
import { formatCents, formatDate } from '../format';

export function InvoiceDetail({ id }: { id: number }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const load = useCallback(() => {
    api.invoice(id).then(setInvoice, (e: Error) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!invoice) return <p className="muted">Lade …</p>;

  async function removePayment(paymentId: number) {
    if (!confirm('Zahlung wirklich entfernen?')) return;
    await api.deletePayment(id, paymentId);
    load();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <a href="#/rechnungen" className="muted">
            ← Offene Posten
          </a>
          <h1>
            Rechnung {invoice.number} <StatusBadge status={invoice.status} />
          </h1>
        </div>
        {invoice.status !== 'bezahlt' && <button onClick={() => setPaying(true)}>Zahlung erfassen</button>}
      </header>

      <section className="panel details">
        <dl>
          <dt>Kunde</dt>
          <dd>
            {invoice.customer_name} ({invoice.customer_number})
          </dd>
          <dt>Leistung</dt>
          <dd>{invoice.description || '–'}</dd>
          <dt>Rechnungsdatum</dt>
          <dd>{formatDate(invoice.issue_date)}</dd>
          <dt>Fällig am</dt>
          <dd>{formatDate(invoice.due_date)}</dd>
          <dt>Rechnungsbetrag</dt>
          <dd>{formatCents(invoice.amount_cents)}</dd>
          <dt>Bezahlt</dt>
          <dd>{formatCents(invoice.paid_cents)}</dd>
          <dt>Offen</dt>
          <dd>
            <strong>{formatCents(invoice.open_cents)}</strong>
          </dd>
        </dl>
      </section>

      <section className="panel">
        <h2>Zahlungen</h2>
        {invoice.payments?.length ? (
          <table>
            <thead>
              <tr>
                <th>Buchungsdatum</th>
                <th>Erfasst über</th>
                <th>Notiz</th>
                <th className="num">Betrag</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.booked_on)}</td>
                  <td>{p.method}</td>
                  <td>{p.note || '–'}</td>
                  <td className="num">{formatCents(p.amount_cents)}</td>
                  <td className="num">
                    <button className="link" onClick={() => removePayment(p.id)}>
                      Entfernen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Noch keine Zahlung erfasst.</p>
        )}
      </section>

      {paying && (
        <PaymentDialog
          invoice={invoice}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            load();
          }}
        />
      )}
    </>
  );
}
