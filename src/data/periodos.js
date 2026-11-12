// Logica PURA de periodos, vencimientos y meses de los alquileres. Sin React ni DOM:
// se prueba con node (tests/periodos.test.js). Es la regla unica que usan Inicio,
// Alquileres, Contabilidad y Reportes; el agente contador de Santi (contabilidad.py)
// la replica: si se cambia algo aca, avisar para actualizarlo.
import { getToday, toLocalDateStr } from './fechas.js';

// Pago registrado bajo una clave exacta (mes YYYY-MM o quincena YYYY-MM-DD).
export const isPaidKey = (rental, key) => Boolean(rental.paymentStatusByMonth?.[key]?.paid);

// ---- Periodo del alquiler: mensual (por defecto) o quincenal (15 dias) ----
// Los alquileres viejos no tienen el campo y se tratan como mensuales.
export const periodoDe = (r) => (r && r.period === 'quincenal' ? 'quincenal' : 'mensual');
export function addDaysStr(dateStr, dias) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + dias);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
// Clave con la que se registra el pago del periodo que vence en dueDate:
// mensual = el mes (YYYY-MM), quincenal = la fecha exacta (YYYY-MM-DD).
export const claveDePeriodo = (dueDate, periodo) => (periodo === 'quincenal' ? String(dueDate || '') : String(dueDate || '').slice(0, 7));
const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/;
const esFecha = (v) => typeof v === 'string' && FECHA_VALIDA.test(v);
// Dia de referencia de los vencimientos: el de inicio si es una fecha valida; si no (datos
// importados con formato viejo), el del vencimiento guardado.
const diaReferencia = (rental) => (esFecha(rental.startDate) ? rental.startDate : rental.endDate);
// Dia local (YYYY-MM-DD) de la baja, o '' si no hay fecha.
export function diaDeBaja(r) {
  if (r.finalizedAt) {
    const d = new Date(r.finalizedAt);
    if (!isNaN(d)) return toLocalDateStr(d);
  }
  return esFecha(r.endDate) ? r.endDate : '';
}
export const mesDeClave = (k) => String(k || '').slice(0, 7);
// Precio del equipo segun el periodo elegido.
export const precioEquipoPorPeriodo = (e, periodo) => (periodo === 'quincenal' ? (Number(e?.rentalPrice15) || 0) : (Number(e?.rentalPrice) || 0));

// Cuantos periodos se cobraron en un mes: los tildados como pagos con clave de ese
// mes, mas el primero (se cobra al iniciar) si el alquiler arranco ese mes. Un
// alquiler ya finalizado solo suma el de alta en meses pasados. Mensual = maximo
// uno por mes (hay datos viejos con el mes de alta tildado ademas).
export function periodosCobradosEnMes(rental, monthKey) {
  const p = rental.paymentStatusByMonth || {};
  let cant = Object.entries(p).filter(([k, v]) => v && v.paid && mesDeClave(k) === monthKey).length;
  // El periodo de alta se cobra al iniciar: cuenta SIEMPRE en su mes. Antes un alquiler que
  // arrancaba y se daba de baja en el mismo mes valia 0 ese mes y 1 al mes siguiente, y el
  // numero de un mes cerrado cambiaba segun el dia en que se mirara.
  const arranca = String(rental.startDate || '').slice(0, 7) === monthKey;
  if (arranca) cant += 1;
  if (periodoDe(rental) === 'mensual') cant = Math.min(cant, 1);
  return cant;
}
export const montoCobradoEnMes = (rental, monthKey) => periodosCobradosEnMes(rental, monthKey) * (Number(rental.price) || 0);

// Cuantos periodos corresponde cobrar en un mes: mensual siempre 1; quincenal, el de
// alta (si arranco ese mes) mas cada vencimiento de 15 dias que cae en el mes.
// Un alquiler dado de baja solo cuenta los vencimientos hasta el dia de la baja. Nunca es
// menos que lo efectivamente cobrado ese mes (vencimientos editados a mano fuera de la grilla
// de 15 dias): asi "falta cobrar" no da negativo ni inventa deuda.
export function periodosContratadosEnMes(rental, monthKey) {
  const cobrados = periodosCobradosEnMes(rental, monthKey);
  if (periodoDe(rental) !== 'quincenal') return 1;
  const inicio = String(rental.startDate || '');
  let cant = inicio.slice(0, 7) === monthKey ? 1 : 0;
  const finalizado = rental.status === 'finalizado';
  const baja = finalizado ? diaDeBaja(rental) : '';
  let d = addDaysStr(inicio, 15);
  let guard = 0;
  while (d && d.slice(0, 7) <= monthKey && guard < 400) {
    if (d.slice(0, 7) === monthKey && !(baja && d > baja)) cant += 1;
    d = addDaysStr(d, 15); guard++;
  }
  return finalizado ? Math.max(cant, cobrados) : Math.max(1, cant, cobrados);
}

// Mes de la baja en hora LOCAL: finalizedAt se guarda en UTC (toISOString) y una baja del
// 31 a las 22 hs caia en el mes siguiente. Sin finalizedAt (datos viejos) se usa endDate.
export function mesDeBaja(r) {
  return diaDeBaja(r).slice(0, 7);
}
// Vigente en el mes (regla unica de Inicio, Contabilidad y Reportes): arranco antes o
// durante y todavia no habia terminado. Si se cobro ese mes, estaba vigente. Un moroso
// sigue vigente aunque su vencimiento haya quedado en un mes anterior. El mes de la baja
// solo cuenta si efectivamente se cobro.
export function vigenteEnMes(r, mk) {
  if (periodosCobradosEnMes(r, mk) > 0) return true;
  const inicio = String(r.startDate || '').slice(0, 7);
  if (!inicio || inicio > mk) return false;
  if (r.status === 'finalizado') {
    // Sin fecha de baja no se sabe hasta cuando estuvo: solo cuenta en los meses que cobro
    // (antes quedaba vigente para siempre e inventaba deuda todos los meses).
    const baja = mesDeBaja(r);
    return Boolean(baja) && baja > mk;
  }
  return true;
}


// Periodos vencidos y sin pagar: cada vencimiento desde el actual hasta hoy
// (hoy inclusive). El pago se registra con la clave del periodo que vence ese
// dia (mensual = el mes del vencimiento, quincenal = la fecha). Un periodo cuyo
// vencimiento todavia no llego NO es deuda.
// Antes el mensual contaba meses calendario: el mes en curso figuraba impago
// aunque su vencimiento fuera dias despues, y new Date('YYYY-MM-01') (UTC) caia
// en el mes anterior en Argentina y sumaba un mes de mas.
export function periodosImpagos(rental) {
  if (!esFecha(rental.endDate)) return []; // sin vencimiento o con formato invalido
  const periodo = periodoDe(rental);
  const hoy = getToday();
  const out = [];
  let d = rental.endDate;
  let guard = 0;
  while (d && d <= hoy && guard < 400) {
    const clave = claveDePeriodo(d, periodo);
    if (!isPaidKey(rental, clave)) out.push(clave);
    // Sin startDate se usa el dia del vencimiento guardado (si no, 31-ene arrastraba el 28 de feb).
    d = nextDueAfter(d, diaReferencia(rental), periodo); guard++;
  }
  return out;
}

// Vencimiento real: el primer periodo SIN PAGAR a partir del vencimiento guardado.
// Si se pago un periodo atrasado (ej: septiembre pagado en octubre), el
// vencimiento pasa al siguiente en vez de quedar clavado en la fecha vieja.
export function primerVencimientoImpago(rental) {
  const periodo = periodoDe(rental);
  if (!esFecha(rental.endDate)) return rental.endDate;
  let d = rental.endDate;
  let guard = 0;
  // Salta los periodos pagos, tambien los futuros (pagados por adelantado): si no, un periodo
  // ya pago aparecia como "por vencer".
  while (d && isPaidKey(rental, claveDePeriodo(d, periodo)) && guard < 400) {
    d = nextDueAfter(d, diaReferencia(rental), periodo); guard++;
  }
  return d;
}


export function nextMonthDate(start) {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return '';
  const [y, m, d] = start.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  const maxDay = new Date(ny, nm, 0).getDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, maxDay)).padStart(2, '0')}`;
}

// El vencimiento SIEMPRE cae el dia de inicio. Esta funcion ajusta solo el dia
// de una fecha (manteniendo mes/anio) al dia de inicio, corrigiendo el desfase
// de +/-1 que arrastraban datos viejos. Si el dia no existe (ej: 31 en feb),
// usa el ultimo dia del mes.
export function alignDueDay(refDate, startDate, periodo) {
  if (periodo === 'quincenal') return refDate; // la quincena no cae en el dia de inicio
  if (!refDate || !startDate || !/^\d{4}-\d{2}-\d{2}$/.test(refDate) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return refDate;
  const [y, m] = refDate.split('-').map(Number);
  const startDay = Number(startDate.split('-')[2]);
  const maxDay = new Date(y, m, 0).getDate();
  const day = Math.min(startDay, maxDay);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Proximo vencimiento: el dia de INICIO, en el mes siguiente al vencimiento actual.
export function nextDueAfter(refDate, startDate, periodo) {
  if (periodo === 'quincenal') {
    return refDate && /^\d{4}-\d{2}-\d{2}$/.test(refDate) ? addDaysStr(refDate, 15) : addDaysStr(startDate, 15);
  }
  if (!refDate || !/^\d{4}-\d{2}-\d{2}$/.test(refDate)) return nextMonthDate(startDate);
  const [y, m] = refDate.split('-').map(Number);
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return alignDueDay(`${ny}-${String(nm).padStart(2, '0')}-01`, startDate || refDate);
}

// Vencimiento = un mes despues del inicio, avanzando mes a mes sucesivamente
// hasta el primer vencimiento que sea hoy o futuro. Asi los alquileres viejos
// quedan con el proximo vencimiento real (no uno pasado que marque todo vencido).
export function rollingDueDate(start, periodo) {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return '';
  if (periodo === 'quincenal') {
    const hoy = getToday();
    let due = addDaysStr(start, 15);
    let guard = 0;
    while (due < hoy && guard < 400) { due = addDaysStr(due, 15); guard++; }
    return due;
  }
  const [y, m, d] = start.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let year = y, month = m;
  let due;
  do {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    const maxDay = new Date(year, month, 0).getDate();
    due = new Date(year, month - 1, Math.min(d, maxDay));
  } while (due < today);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
}

// El vencimiento de un alquiler nunca puede estar a mas de un mes (un periodo)
// del que corresponde por fecha de inicio. D = primer vencimiento (dia de inicio)
// que cae hoy o despues. Si ese mes ya esta pagado, el tope es el mes siguiente;
// si no, es D. Si la fecha cargada quedo mas adelante, se la trae al tope.
export function cappedDueDate(rental) {
  if (!rental.startDate || !rental.endDate) return rental.endDate;
  const periodo = periodoDe(rental);
  const D = rollingDueDate(rental.startDate, periodo);
  if (!D) return rental.endDate;
  // Tope = primer vencimiento desde D que NO este pago (antes miraba un solo periodo y con
  // dos o mas pagados por adelantado devolvia uno ya pago).
  let tope = D;
  let guard = 0;
  while (isPaidKey(rental, claveDePeriodo(tope, periodo)) && guard < 400) {
    tope = nextDueAfter(tope, rental.startDate, periodo); guard++;
  }
  return rental.endDate > tope ? tope : rental.endDate;
}


// ---- Normalizacion de vencimientos (la corre Inicio en cada carga) ----
// Devuelve el alquiler normalizado (el MISMO objeto si no hay nada que cambiar):
// 0) sin vencimiento: el proximo desde hoy; 1) cae el dia de inicio; 2) tope de un periodo
// por delante; 3) salta periodos pagos; 4) estado segun la fecha (vence hoy = vencido).
// Un alquiler finalizado o con fecha de inicio invalida (ej. importada de Excel) no se toca.
export function normalizarAlquiler(rental, hoy = getToday()) {
  // Se repite hasta que quede estable (un quincenal fuera de la grilla de 15 dias necesita dos
  // pasadas); asi una sola llamada deja el resultado final y no hay guardados en cadena.
  let r = rental;
  for (let i = 0; i < 5; i++) {
    const n = pasoNormalizar(r, hoy);
    if (n === r) break;
    r = n;
  }
  return r;
}

function pasoNormalizar(rental, hoy) {
  if (!rental || rental.status === 'finalizado' || !esFecha(rental.startDate)) return rental;
  // Vencimiento con formato invalido (ej. numero de Excel): no se toca (antes rompia Inicio).
  if (rental.endDate && !esFecha(rental.endDate)) return rental;
  let r = rental;
  if (!r.endDate) r = { ...r, endDate: rollingDueDate(r.startDate, periodoDe(r)) };
  if (!r.endDate) return rental;
  const aligned = alignDueDay(r.endDate, r.startDate, periodoDe(r));
  if (aligned !== r.endDate) r = { ...r, endDate: aligned };
  const capped = cappedDueDate(r);
  if (capped !== r.endDate) r = { ...r, endDate: capped };
  const real = primerVencimientoImpago(r);
  if (real !== r.endDate) r = { ...r, endDate: real };
  const estado = r.endDate <= hoy ? 'vencido' : 'activo';
  if (estado !== r.status) r = { ...r, status: estado };
  return r;
}

// ---- Historial de un alquiler: cuota por cuota, con su vencimiento ----
// Arma la grilla de cuotas desde el inicio con la MISMA regla que periodosImpagos (cada cuota
// se paga con la clave del periodo que vence) y dice de cada una si se pago, esta vencida
// sin pagar o es la proxima. Asi el historial muestra fechas reales y no solo meses sueltos.
// - alta: el primer periodo (inicio -> primer vencimiento) se cobra al iniciar. En mensual el
//   mes de inicio tildado es ese mismo cobro (datos viejos), igual que periodosCobradosEnMes.
// - otros: pagos tildados con claves que no caen en la grilla (cargados a mano): se listan
//   aparte para no esconder ninguno.
// - sinRegistro: cuotas viejas, anteriores al vencimiento guardado, sin pago tildado. Son los
//   alquileres cargados con su fecha de inicio real cuando la app arranco: esos meses se cobraron
//   por fuera y NO son deuda (periodosImpagos tampoco los cuenta).
// - discrepancia: el vencimiento guardado no coincide con la primera cuota sin pagar.
export function historialDeCuotas(rental, hoy = getToday()) {
  const periodo = periodoDe(rental);
  const pagos = rental.paymentStatusByMonth || {};
  const pagada = (k) => Boolean(pagos[k]?.paid);
  const fechaPago = (k) => (pagos[k]?.updatedAt ? String(pagos[k].updatedAt) : '');
  const finalizado = rental.status === 'finalizado';
  const baja = finalizado ? diaDeBaja(rental) : '';
  const desde = esFecha(rental.endDate) ? rental.endDate : '';
  const usadas = new Set();
  const cuotas = [];
  let proximo = '';
  let primerImpago = '';
  if (esFecha(rental.startDate)) {
    const inicio = rental.startDate;
    const claveAlta = claveDePeriodo(inicio, periodo);
    const primerVto = nextDueAfter(inicio, inicio, periodo);
    const altaTildada = periodo === 'mensual' && pagada(claveAlta);
    if (altaTildada) usadas.add(claveAlta);
    cuotas.push({ tipo: 'alta', desde: inicio, hasta: primerVto, clave: altaTildada ? claveAlta : '', fechaPago: altaTildada ? fechaPago(claveAlta) || inicio : inicio });
    let d = primerVto;
    let guard = 0;
    while (d && guard < 400) {
      const clave = claveDePeriodo(d, periodo);
      const paga = pagada(clave);
      const sig = nextDueAfter(d, inicio, periodo);
      if (finalizado && (!baja || d > baja) && !paga) break;
      if (!paga && d > hoy) { proximo = d; if (!primerImpago) primerImpago = d; break; }
      const tipo = paga ? 'pagada' : (desde && d < desde ? 'sinRegistro' : 'impaga');
      cuotas.push({ tipo, desde: d, hasta: sig, vence: d, clave, fechaPago: paga ? fechaPago(clave) : '' });
      usadas.add(clave);
      if (tipo === 'impaga' && !primerImpago) primerImpago = d;
      d = sig; guard++;
    }
  }
  const otros = Object.keys(pagos).filter(k => pagada(k) && !usadas.has(k)).sort()
    .map(k => ({ clave: k, fechaPago: fechaPago(k) }));
  const discrepancia = !finalizado && esFecha(rental.startDate) && esFecha(rental.endDate) && primerImpago && rental.endDate !== primerImpago
    ? { guardado: rental.endDate, segunPagos: primerImpago } : null;
  const cobradas = cuotas.filter(c => c.tipo === 'alta' || c.tipo === 'pagada').length + otros.length;
  return { periodo, cuotas, otros, proximo, primerImpago, discrepancia, cobradas, impagas: cuotas.filter(c => c.tipo === 'impaga').length };
}
