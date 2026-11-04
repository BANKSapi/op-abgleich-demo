import { useEffect, useState, type FormEvent } from 'react';
import { api, type Customer } from '../api';

export function Customers() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [name, setName] = useState('');
  const [iban, setIban] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.customers().then(setCustomers);
  };
  useEffect(load, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.createCustomer({ name, iban, email });
      setName('');
      setIban('');
      setEmail('');
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <header className="page-header">
        <h1>Kunden</h1>
      </header>

      <section className="panel">
        {!customers ? (
          <p className="muted">Lade …</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kundennr.</th>
                <th>Name</th>
                <th>IBAN</th>
                <th>E-Mail</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>{c.customer_number}</td>
                  <td>{c.name}</td>
                  <td className="mono">{c.iban ?? '–'}</td>
                  <td>{c.email ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <form className="panel form" onSubmit={submit}>
        <h2>Kunde anlegen</h2>
        <div className="row">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            IBAN
            <input value={iban} onChange={(e) => setIban(e.target.value)} />
          </label>
          <label>
            E-Mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit">Kunde anlegen</button>
        </div>
      </form>
    </>
  );
}
