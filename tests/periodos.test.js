// Tests de la logica de periodos/vencimientos (src/data/periodos.js). Correr: npm test
// "Hoy" se fija con mock de Date para que los resultados no dependan del dia.
import { test, mock, before, after } from 'node:test';
process.env.TZ = 'America/Argentina/Cordoba'; // fechas de negocio en hora de Argentina
import assert from 'node:assert/strict';
import {
  periodosImpagos, primerVencimientoImpago, cappedDueDate, rollingDueDate, normalizarAlquiler,
  periodosCobradosEnMes, periodosContratadosEnMes, vigenteEnMes, mesDeBaja, nextDueAfter, addDaysStr,
} from '../src/data/periodos.js';

const HOY = '2026-11-03';
before(() => { mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 3, 12, 0, 0) }); });
after(() => mock.timers.reset());

const pago = (...claves) => Object.fromEntries(claves.map(k => [k, { paid: true }]));

test('fin de mes y bisiesto: 31-ene da 28-feb y vuelve a 31-mar', () => {
  assert.equal(nextDueAfter('2026-01-31', '2025-12-31', 'mensual'), '2026-02-28');
  assert.equal(nextDueAfter('2026-02-28', '2025-12-31', 'mensual'), '2026-03-31');
  assert.equal(nextDueAfter('2028-01-31', '2027-12-31', 'mensual'), '2028-02-29');
  assert.equal(addDaysStr('2026-12-25', 15), '2027-01-09');
});

test('sin startDate se conserva el dia del vencimiento guardado (A7)', () => {
  const r = { endDate: '2026-01-31', paymentStatusByMonth: pago('2026-01', '2026-02', '2026-03', '2026-04') };
  assert.equal(primerVencimientoImpago(r), '2026-05-31');
});

test('periodos impagos: mensual y quincenal, vence hoy cuenta', () => {
  const m = { startDate: '2026-08-05', endDate: '2026-10-05', period: 'mensual' };
  assert.deepEqual(periodosImpagos(m), ['2026-10']);
  const q = { startDate: '2026-10-04', endDate: '2026-10-19', period: 'quincenal' };
  assert.deepEqual(periodosImpagos(q), ['2026-10-19', '2026-11-03']);
});

test('periodos pagados por adelantado no quedan como vencimiento (A6)', () => {
  const r = { startDate: '2026-06-10', endDate: '2027-01-10', status: 'activo', paymentStatusByMonth: pago('2026-11', '2026-12') };
  assert.equal(cappedDueDate(r), '2027-01-10');
  assert.equal(normalizarAlquiler(r, HOY).endDate, '2027-01-10');
});

test('normalizar es idempotente en cientos de combinaciones', () => {
  const inicios = ['2026-01-31', '2026-03-15', '2026-08-05', '2026-10-20', '2026-11-03', '2025-02-28'];
  const fines = ['', '2026-09-05', '2026-10-31', '2026-11-03', '2026-11-20', '2027-03-01'];
  const pagos = [{}, pago('2026-10'), pago('2026-11'), pago('2026-11', '2026-12'), pago('2026-10-19', '2026-11-03')];
  let n = 0;
  for (const startDate of inicios) for (const endDate of fines) for (const p of pagos) for (const period of ['mensual', 'quincenal']) {
    const r = { startDate, endDate, period, status: 'activo', paymentStatusByMonth: p };
    const una = normalizarAlquiler(r, HOY);
    const dos = normalizarAlquiler(una, HOY);
    assert.equal(dos, una, `no estable: ${JSON.stringify(r)}`);
    if (una.endDate && una.status !== 'finalizado') {
      // El vencimiento normalizado nunca es un periodo ya pagado.
      const clave = period === 'quincenal' ? una.endDate : una.endDate.slice(0, 7);
      assert.ok(!p[clave], `vence en periodo pago: ${JSON.stringify(una)}`);
    }
    n++;
  }
  assert.ok(n > 300);
});

test('normalizar no toca fechas de inicio invalidas (bucle de guardado B2)', () => {
  const r = { startDate: 45900, endDate: '', status: 'activo' };
  assert.equal(normalizarAlquiler(r, HOY), r);
  const r2 = { startDate: '05/10/2026', status: 'activo' };
  assert.equal(normalizarAlquiler(r2, HOY), r2);
});

test('normalizar NO adelanta un alquiler con deuda', () => {
  const r = { startDate: '2026-06-10', endDate: '2026-09-10', status: 'vencido' };
  const n = normalizarAlquiler(r, HOY);
  assert.equal(n.endDate, '2026-09-10');
  assert.deepEqual(periodosImpagos(n), ['2026-09', '2026-10']);
});

test('rollingDueDate: vence hoy queda hoy', () => {
  assert.equal(rollingDueDate('2026-10-03', 'mensual'), '2026-11-03');
});

test('cobrado: el periodo de alta cuenta siempre, tambien si se dio de baja ese mes (D7)', () => {
  const r = { startDate: '2026-11-01', status: 'finalizado', finalizedAt: '2026-11-02T15:00:00.000Z', price: 100 };
  assert.equal(periodosCobradosEnMes(r, '2026-11'), 1);
  const q = { startDate: '2026-10-05', period: 'quincenal', paymentStatusByMonth: pago('2026-10-20') };
  assert.equal(periodosCobradosEnMes(q, '2026-10'), 2);
  assert.equal(periodosContratadosEnMes(q, '2026-10'), 2);
  const m = { startDate: '2026-10-05', paymentStatusByMonth: pago('2026-10') };
  assert.equal(periodosCobradosEnMes(m, '2026-10'), 1);
});

test('baja en hora local: 31-oct 22:30 de Argentina es octubre (A5/D8)', () => {
  // 2026-11-01T01:30Z = 31-oct 22:30 en UTC-3. El test corre con TZ=America/Argentina/Cordoba.
  assert.equal(mesDeBaja({ finalizedAt: '2026-11-01T01:30:00.000Z' }), '2026-10');
});

test('vigente: morosos y meses pasados de bajas cuentan; el mes de la baja sin cobro no (A4/D5)', () => {
  const moroso = { startDate: '2026-06-10', endDate: '2026-09-10', status: 'vencido' };
  assert.equal(vigenteEnMes(moroso, '2026-11'), true);
  const baja = { startDate: '2026-06-10', status: 'finalizado', finalizedAt: '2026-09-15T15:00:00.000Z' };
  assert.equal(vigenteEnMes(baja, '2026-07'), true);
  assert.equal(vigenteEnMes(baja, '2026-09'), false);
  assert.equal(vigenteEnMes(baja, '2026-10'), false);
  assert.equal(vigenteEnMes(moroso, '2026-05'), false);
});

test('vencimiento con formato invalido no rompe ni se toca (R2A-1)', () => {
  const r = { startDate: '2026-05-07', endDate: 45900, status: 'activo' };
  assert.equal(normalizarAlquiler(r, HOY), r);
  assert.deepEqual(periodosImpagos(r), []);
});

test('inicio invalido: se usa el dia del vencimiento, sin inventar deuda (R2A-2)', () => {
  const r = { startDate: '15/08/2026', endDate: '2026-10-15', paymentStatusByMonth: {} };
  assert.deepEqual(periodosImpagos(r), ['2026-10']);
  const pagado = { ...r, paymentStatusByMonth: pago('2026-10') };
  assert.equal(primerVencimientoImpago(pagado), '2026-11-15');
});

test('quincenal dado de baja: no cuenta vencimientos posteriores a la baja (R2A-3/R2D-1)', () => {
  const r = { startDate: '2026-11-01', period: 'quincenal', status: 'finalizado', finalizedAt: '2026-11-05T15:00:00.000Z', price: 100 };
  assert.equal(periodosContratadosEnMes(r, '2026-11'), 1);
  const r2 = { startDate: '2026-10-05', period: 'quincenal', status: 'finalizado', finalizedAt: '2026-11-10T15:00:00.000Z', paymentStatusByMonth: pago('2026-11-04') };
  assert.equal(periodosContratadosEnMes(r2, '2026-11'), 1);
  assert.equal(periodosCobradosEnMes(r2, '2026-11'), 1);
});

test('contratado nunca menor que cobrado (vencimientos fuera de grilla, R2D-2)', () => {
  const r = { startDate: '2026-10-02', endDate: '2026-10-25', period: 'quincenal', status: 'activo', paymentStatusByMonth: pago('2027-02-07', '2027-02-22') };
  assert.ok(periodosContratadosEnMes(r, '2027-02') >= periodosCobradosEnMes(r, '2027-02'));
});

test('finalizado sin fecha de baja no queda vigente para siempre (R2D-3)', () => {
  const r = { startDate: '2025-03-10', status: 'finalizado' };
  assert.equal(vigenteEnMes(r, '2026-11'), false);
  assert.equal(vigenteEnMes(r, '2025-03'), true); // el mes de alta cobro
});
