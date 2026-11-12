// Historial de cuotas de un alquiler (historialDeCuotas). Correr: npm test
import { test, mock, before, after } from 'node:test';
process.env.TZ = 'America/Argentina/Cordoba';
import assert from 'node:assert/strict';
import { historialDeCuotas, periodosImpagos } from '../src/data/periodos.js';

const HOY = '2026-11-12';
before(() => { mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 12, 12, 0, 0) }); });
after(() => mock.timers.reset());
const pago = (...claves) => Object.fromEntries(claves.map(k => [k, { paid: true, updatedAt: k.length === 7 ? `${k}-12T12:00:00.000Z` : `${k}T12:00:00.000Z` }]));

test('caso Abad: alta tildada en el mes de inicio, al dia, proximo vencimiento 12/12', () => {
  const r = { startDate: '2026-08-12', endDate: '2026-12-12', status: 'activo', price: 60000, paymentStatusByMonth: pago('2026-08', '2026-09', '2026-10', '2026-11') };
  const h = historialDeCuotas(r, HOY);
  assert.deepEqual(h.cuotas.map(c => [c.tipo, c.desde, c.hasta]), [
    ['alta', '2026-08-12', '2026-09-12'], ['pagada', '2026-09-12', '2026-10-12'],
    ['pagada', '2026-10-12', '2026-11-12'], ['pagada', '2026-11-12', '2026-12-12']]);
  assert.equal(h.proximo, '2026-12-12');
  assert.equal(h.discrepancia, null);
  assert.equal(h.otros.length, 0);
  assert.equal(h.cobradas, 4); // mismo total que antes: 4 x 60.000
});

test('moroso: las cuotas vencidas sin pagar quedan marcadas y coinciden con periodosImpagos', () => {
  const r = { startDate: '2026-08-05', endDate: '2026-10-05', status: 'vencido', paymentStatusByMonth: pago('2026-09') };
  const h = historialDeCuotas(r, HOY);
  const impagas = h.cuotas.filter(c => c.tipo === 'impaga').map(c => c.clave);
  assert.deepEqual(impagas, periodosImpagos(r));
  assert.equal(h.primerImpago, '2026-10-05');
  assert.equal(h.discrepancia, null);
  assert.equal(h.proximo, '2026-12-05');
});

test('vencimiento guardado que no coincide con los pagos se avisa', () => {
  const r = { startDate: '2026-08-12', endDate: '2026-11-12', status: 'activo', paymentStatusByMonth: pago('2026-09', '2026-10', '2026-11') };
  assert.deepEqual(historialDeCuotas(r, HOY).discrepancia, { guardado: '2026-11-12', segunPagos: '2026-12-12' });
});

test('pagos fuera de la grilla y por adelantado no se pierden', () => {
  const r = { startDate: '2026-10-05', endDate: '2026-11-05', status: 'activo', paymentStatusByMonth: pago('2026-11', '2026-12', '2025-01') };
  const h = historialDeCuotas(r, HOY);
  assert.ok(h.cuotas.some(c => c.tipo === 'pagada' && c.clave === '2026-12'));
  assert.deepEqual(h.otros.map(o => o.clave), ['2025-01']);
  assert.equal(h.proximo, '2027-01-05');
});

test('quincenal y dado de baja: corta en la baja', () => {
  const r = { startDate: '2026-10-01', endDate: '2026-10-31', period: 'quincenal', status: 'finalizado', finalizedAt: '2026-10-20T15:00:00.000Z', paymentStatusByMonth: pago('2026-10-16') };
  const h = historialDeCuotas(r, HOY);
  assert.deepEqual(h.cuotas.map(c => [c.tipo, c.desde]), [['alta', '2026-10-01'], ['pagada', '2026-10-16']]);
  assert.equal(h.proximo, '');
  assert.equal(h.discrepancia, null);
});

test('inicio invalido: no inventa cuotas, lista los pagos aparte', () => {
  const r = { startDate: '15/08/2026', endDate: '2026-11-15', paymentStatusByMonth: pago('2026-10') };
  const h = historialDeCuotas(r, HOY);
  assert.equal(h.cuotas.length, 0);
  assert.deepEqual(h.otros.map(o => o.clave), ['2026-10']);
});

test('alquiler viejo cargado con su inicio real: los meses previos a la app no son deuda', () => {
  const r = { startDate: '2025-10-15', endDate: '2026-11-15', status: 'activo', paymentStatusByMonth: pago('2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10') };
  const h = historialDeCuotas(r, HOY);
  assert.equal(h.impagas, 0);
  assert.deepEqual(periodosImpagos(r), []);
  assert.equal(h.cuotas.filter(c => c.tipo === 'sinRegistro').length, 6); // nov-25 a abr-26
  assert.equal(h.proximo, '2026-11-15');
  assert.equal(h.discrepancia, null);
  assert.equal(h.cobradas, 7); // alta + 6 pagos
});
