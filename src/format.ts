const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const formatCents = (cents: number) => euro.format(cents / 100);
export const formatDate = (iso: string) => date.format(new Date(`${iso}T12:00:00`));
export const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
