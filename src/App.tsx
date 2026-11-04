import { useEffect, useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Invoices } from './pages/Invoices';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { InvoiceForm } from './pages/InvoiceForm';
import { Customers } from './pages/Customers';
import { BankReconciliation, type BankEntry } from './pages/BankReconciliation';
import { CALLBACK_PATH, REENTRY_PATH } from './components/RegProtect';

/**
 * Rücksprünge von BANKSapi REG/Protect kommen als echte Pfade an (Query-Parameter vertragen sich
 * nicht mit Hash-Routing): nach Redirect-SCA bei der Bank bzw. über die callbackUrl.
 */
function detectBankEntry(): BankEntry | undefined {
  const { pathname, href } = window.location;
  if (pathname === REENTRY_PATH) return { kind: 'reentry' };
  if (pathname === CALLBACK_PATH) return { kind: 'callback', url: href };
  return undefined;
}

/** Einfaches Hash-Routing: #/, #/rechnungen, #/rechnungen/neu, #/rechnungen/12, #/kunden, #/bankabgleich */
function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#/, '');
}

const nav = [
  { href: '#/', label: 'Übersicht', match: (r: string) => r === '/' },
  { href: '#/rechnungen', label: 'Offene Posten', match: (r: string) => r.startsWith('/rechnungen') },
  { href: '#/kunden', label: 'Kunden', match: (r: string) => r.startsWith('/kunden') },
  { href: '#/bankabgleich', label: 'Bankabgleich', match: (r: string) => r.startsWith('/bankabgleich') },
];

export function App() {
  const route = useRoute();
  const [bankEntry, setBankEntry] = useState(detectBankEntry);

  let page;
  const detail = route.match(/^\/rechnungen\/(\d+)$/);
  if (bankEntry)
    page = (
      <BankReconciliation
        entry={bankEntry}
        onEntryHandled={() => {
          // Rücksprung-URL aus der Adresszeile entfernen und ins Hash-Routing zurückkehren
          window.history.replaceState(null, '', '/#/bankabgleich');
          window.dispatchEvent(new HashChangeEvent('hashchange'));
          setBankEntry(undefined);
        }}
      />
    );
  else if (route.startsWith('/bankabgleich')) page = <BankReconciliation />;
  else if (route === '/rechnungen/neu') page = <InvoiceForm />;
  else if (detail) page = <InvoiceDetail id={Number(detail[1])} />;
  else if (route.startsWith('/rechnungen')) page = <Invoices />;
  else if (route.startsWith('/kunden')) page = <Customers />;
  else page = <Dashboard />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <div>
            <strong>Kontor</strong>
            <small>Muster Design GmbH</small>
          </div>
        </div>
        <nav>
          {nav.map((item) => (
            <a key={item.href} href={item.href} className={item.match(route) ? 'active' : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
        <footer>Geschäftsjahr {new Date().getFullYear()}</footer>
      </aside>
      <main className="content">{page}</main>
    </div>
  );
}
