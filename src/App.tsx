import { useEffect, useState } from 'react';
import { REENTRY_PATH } from './components/RegProtect';
import { Dashboard } from './pages/Dashboard';
import { Invoices } from './pages/Invoices';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { InvoiceForm } from './pages/InvoiceForm';
import { Customers } from './pages/Customers';
import { Bank, BankReentry } from './pages/Bank';

/** Einfaches Hash-Routing (Navigation mit absolutem Pfad, damit Rücksprungseiten wie /bank/reentry verlassen werden): #/, #/rechnungen, #/rechnungen/neu, #/rechnungen/12, #/kunden */
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
  { href: '/#/', label: 'Übersicht', match: (r: string) => r === '/' },
  { href: '/#/rechnungen', label: 'Offene Posten', match: (r: string) => r.startsWith('/rechnungen') },
  { href: '/#/kunden', label: 'Kunden', match: (r: string) => r.startsWith('/kunden') },
  { href: '/#/bank', label: 'Bankabgleich', match: (r: string) => r.startsWith('/bank') },
];

/**
 * Rücksprünge aus REG/Protect kommen als echte Pfade (nicht als Hash), weil BANKSapi an die URL
 * Query-Parameter wie baReentry anhängt.
 */
function bankReturnPage() {
  const path = window.location.pathname;
  if (path === '/bank/callback') {
    const code = new URLSearchParams(window.location.search).get('baReentry') ?? 'ERROR';
    window.location.replace(`/#/bank/ergebnis/${encodeURIComponent(code)}`);
    return <p className="muted">Weiterleitung …</p>;
  }
  if (path === REENTRY_PATH) return <BankReentry />;
  return null;
}

export function App() {
  const route = useRoute();

  let page = bankReturnPage();
  const detail = route.match(/^\/rechnungen\/(\d+)$/);
  const bankResult = route.match(/^\/bank\/ergebnis\/([A-Z_]+)$/);
  if (page) {
    // Rücksprung aus REG/Protect
  } else if (route === '/rechnungen/neu') page = <InvoiceForm />;
  else if (detail) page = <InvoiceDetail id={Number(detail[1])} />;
  else if (route.startsWith('/rechnungen')) page = <Invoices />;
  else if (route.startsWith('/kunden')) page = <Customers />;
  else if (route.startsWith('/bank')) page = <Bank key={route} reentry={bankResult?.[1]} />;
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
