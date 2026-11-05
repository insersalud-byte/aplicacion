import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, cargarModulo, base, tick } from './sync-escenarios.helper.js';
function app(m, initial) {
  const ui = { data: initial };
  m.onDataChange(d => { ui.data = d; });
  ui.update = (f) => { const prev = ui.data; const next = f(prev); if (next === prev) return; ui.data = next; return m.saveData(next, prev); };
  return ui;
}
test('R6A-1 logout con ciclo en vuelo borra el paso B posterior', async () => {
  const { db, store } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const u = app(A, await A.loadData());
  db.delaySave = 50;
  const pA = u.update(d => ({ ...d, patients: [...d.patients, { id: 'pA', name: 'A' }] }));
  await tick(10); // ciclo 1 en app_save
  u.update(d => ({ ...d, patients: [...d.patients, { id: 'pB', name: 'B' }] }));
  const pend = [...store.keys()].filter(k => k.startsWith('insersalud_pend_'));
  void ('pend antes de logout', pend.map(k => store.get(k).includes('pB')));
  await A.logout();
  await pA; await tick(100);
  void ('hayCambiosSinSubir', A.hayCambiosSinSubir(), 'keys', [...store.keys()]);
  // relogin misma pestana
  store.set('insersalud_session', 'tok');
  db.delaySave = 0;
  await A.loadData(); await tick(20);
  void ('base pats', db.data.patients.map(p => p.id));
  assert.ok(db.data.patients.some(p => p.id === 'pB'), 'pB perdido');
});
test('R6A-2 cuerpo de respuesta colgado bloquea el candado para siempre', async () => {
  crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const u = app(A, await A.loadData());
  globalThis.__insersaludTopeRpcMs = 100; // tope corto para el test (en la app: 20 s / 60 s)
  const real = globalThis.fetch;
  let colgar = true;
  globalThis.fetch = async (url, o) => {
    const r = await real(url, o);
    if (colgar && String(url).endsWith('/app_ts')) { colgar = false; return { ...r, json: () => new Promise(() => {}) }; }
    return r;
  };
  const p = u.update(d => ({ ...d, patients: [...d.patients, { id: 'pX' }] }));
  const r = await Promise.race([p.then(() => 'termino'), tick(300).then(() => 'colgado')]);
  void ('resultado', r);
  globalThis.fetch = real;
  globalThis.__insersaludTopeRpcMs = 0;
  assert.equal(r, 'termino');
});

test('R9-2 dos dispositivos pagan meses distintos del mismo alquiler: quedan los dos pagos', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const B = await cargarModulo(); const uB = app(B, await B.loadData());
  const pagar = (mk) => (d) => ({ ...d, rentals: d.rentals.map(r => r.id === 'r1' ? { ...r, paymentStatusByMonth: { ...(r.paymentStatusByMonth || {}), [mk]: { paid: true } } } : r) });
  await uA.update(pagar('2026-09'));
  await uB.update(pagar('2026-10'));           // B todavia no vio el pago de A
  const r1 = db.data.rentals.find(r => r.id === 'r1');
  assert.ok(r1.paymentStatusByMonth['2026-09']?.paid, 'se perdio el pago de septiembre');
  assert.ok(r1.paymentStatusByMonth['2026-10']?.paid);
});

test('R9-2 editar campos distintos del mismo paciente en dos dispositivos', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const B = await cargarModulo(); const uB = app(B, await B.loadData());
  await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, phone: '351' } : p) }));
  await uB.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, address: 'Calle 1' } : p) }));
  const p1 = db.data.patients.find(p => p.id === 'p1');
  assert.equal(p1.phone, '351');
  assert.equal(p1.address, 'Calle 1');
});
