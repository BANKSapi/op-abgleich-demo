import { useEffect, useState, type FormEvent } from 'react';
import { api, type Customer } from '../api';
import { addDays, todayIso } from '../format';

export function InvoiceForm() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [number, setNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [term, setTerm] = useState(14);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.customers().then(setCustomers);
    api.nextInvoiceNumber().then((r) => setNumber(r.number));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const invoice = await api.createInvoice({
        customer_id: Number(customerId),
        issue_date: issueDate,
        due_date: addDays(issueDate, term),
        amount,
        description,
      });
      window.location.hash = `#/rechnungen/${invoice.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <a href="#/rechnungen" className="muted">
            ← Offene Posten
          </a>
          <h1>Neue Rechnung {number && <span className="muted">{number}</span>}</h1>
        </div>
      </header>

      <form className="panel form" onSubmit={submit}>
        <label>
          Kunde
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
            <option value="">Bitte wählen</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.customer_number})
              </option>
            ))}
          </select>
        </label>
        <label>
          Leistung
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="z. B. Gestaltung Flyer" />
        </label>
        <div className="row">
          <label>
            Rechnungsdatum
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
          </label>
          <label>
            Zahlungsziel
            <select value={term} onChange={(e) => setTerm(Number(e.target.value))}>
              <option value={7}>7 Tage</option>
              <option value={14}>14 Tage</option>
              <option value={30}>30 Tage</option>
            </select>
          </label>
          <label>
            Betrag brutto (€)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0,00" required />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <a className="button secondary" href="#/rechnungen">
            Abbrechen
          </a>
          <button type="submit">Rechnung anlegen</button>
        </div>
      </form>
    </>
  );
}
