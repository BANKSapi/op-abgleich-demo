import { useState, type FormEvent } from 'react';
import { api, type Invoice } from '../api';
import { formatCents, todayIso } from '../format';

interface Props {
  invoice: Invoice;
  onClose: () => void;
  onSaved: () => void;
}

/** Zahlungseingang manuell erfassen, z. B. nach Blick auf den Kontoauszug. */
export function PaymentDialog({ invoice, onClose, onSaved }: Props) {
  const [bookedOn, setBookedOn] = useState(todayIso());
  const [amount, setAmount] = useState((invoice.open_cents / 100).toFixed(2).replace('.', ','));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.addPayment(invoice.id, { booked_on: bookedOn, amount, note });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Zahlung erfassen</h2>
        <p className="muted">
          {invoice.number} · {invoice.customer_name} · offen {formatCents(invoice.open_cents)}
        </p>
        <label>
          Buchungsdatum
          <input type="date" value={bookedOn} onChange={(e) => setBookedOn(e.target.value)} required />
        </label>
        <label>
          Betrag (€)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
        </label>
        <label>
          Notiz
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Kontoauszug Nr. 42" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" disabled={saving}>
            Zahlung buchen
          </button>
        </div>
      </form>
    </div>
  );
}
