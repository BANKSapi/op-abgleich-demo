import { useEffect, useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Invoices } from './pages/Invoices';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { InvoiceForm } from './pages/InvoiceForm';
import { Customers } from './pages/Customers';
import { Banking } from './pages/Banking';

/** Einfaches Hash-Routing: #/, #/rechnungen, #/rechnungen/neu, #/rechnungen/12, #/kunden */
function useRoute() {
  const [hash, setHash] = useState(() => /[?&]banking(?:Reentry|Callback)=/.test(window.location.search) ? '#/bankabgleich' : window.location.hash || '#/');
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

  let page;
  const detail = route.match(/^\/rechnungen\/(\d+)$/);
  if (route === '/rechnungen/neu') page = <InvoiceForm />;
  else if (detail) page = <InvoiceDetail id={Number(detail[1])} />;
  else if (route.startsWith('/rechnungen')) page = <Invoices />;
  else if (route.startsWith('/kunden')) page = <Customers />;
  else if (route.startsWith('/bankabgleich')) page = <Banking />;
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
