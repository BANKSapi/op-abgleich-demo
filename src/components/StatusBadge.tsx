import type { InvoiceStatus } from '../api';

const labels: Record<InvoiceStatus, string> = {
  offen: 'Offen',
  ueberfaellig: 'Überfällig',
  teilbezahlt: 'Teilbezahlt',
  bezahlt: 'Bezahlt',
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return <span className={`badge badge-${status}`}>{labels[status]}</span>;
}
