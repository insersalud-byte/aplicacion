// Fechas de negocio en hora LOCAL (Argentina). Sin dependencias: lo usan la app, la logica
// de periodos y los tests de node.

// Fecha local YYYY-MM-DD. NUNCA usar toISOString() para fechas de negocio:
// devuelve UTC, y en Argentina (UTC-3) desde las 21:00 ya es "manana" en UTC,
// lo que marcaba vencimientos un dia antes.
export function toLocalDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getToday() {
  return toLocalDateStr(new Date());
}
