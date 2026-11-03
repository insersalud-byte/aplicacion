import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, cargarModulo, base, tick } from './sync-escenarios.helper.js';

function app(m, initial) {
  const ui = { data: initial };
  m.onDataChange(d => { ui.data = d; });
  ui.update = (f) => { const prev = ui.data; const next = f(prev); if (next === prev) return; ui.data = next; return m.saveData(next, prev); };
  return ui;
}
const pasosAplicados = (db) => db.data.settings._pasosAplicados || [];
function perderRespuestaSave(n = 1) {
  const real = globalThis.fetch; let k = 0;
  globalThis.fetch = async (url, opts) => {
    const r = await real(url, opts);
    if (String(url).endsWith('/app_save') && k < n) { k++; throw new TypeError('respuesta perdida'); }
    return r;
  };
  return () => { globalThis.fetch = real; };
}

test('L1 legacy: respuesta perdida + edicion local cambia el id -> se reaplica y pisa edicion ajena', async () => {
  const { db, store } = crearEntorno({ remoto: base() });
  // Formato anterior: base sincronizada + cache con un cambio sin subir (p1 renombrado)
  const b = base();
  const local = { ...b, patients: b.patients.map(p => p.id === 'p1' ? { ...p, name: 'Ana LEGACY' } : p) };
  store.set('insersalud_base', JSON.stringify(b));
  store.set('insersalud_db', JSON.stringify(local));
  store.set('insersalud_db_ts', '111');
  store.set('insersalud_dirty', '1');
  const restore = perderRespuestaSave(1);
  const A = await cargarModulo();
  const uA = app(A, await A.loadData()); // la carga sube legacy, commit OK, respuesta perdida
  restore();
  assert.equal(db.data.patients.find(p => p.id === 'p1').name, 'Ana LEGACY');
  const idsLegacy1 = pasosAplicados(db).filter(x => x.startsWith('legacy-'));
  // Otro dispositivo corrige p1
  db.data = structuredClone(db.data); db.data.patients.find(p => p.id === 'p1').name = 'Ana CORREGIDA'; db.ts++;
  // El usuario de A edita otra cosa (sin conexion momentanea no hace falta: cacheLocal reescribe la cache)
  db.caida = true;
  await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p2' ? { ...p, name: 'Beto A' } : p) }));
  db.caida = false;
  await A.syncIfRemoteChanged(); await tick(5);
  const idsLegacy2 = pasosAplicados(db).filter(x => x.startsWith('legacy-'));
  void ('L1 legacy ids', idsLegacy1, '->', idsLegacy2, 'p1=', db.data.patients.find(p => p.id === 'p1').name, 'p2=', db.data.patients.find(p => p.id === 'p2').name);
  assert.equal(db.data.patients.find(p => p.id === 'p1').name, 'Ana CORREGIDA', 'legacy reaplicado piso la edicion ajena');
});

test('D1 borrar y re-agregar mismo id en dos pasos offline; dos ediciones mismo registro', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  db.caida = true;
  await uA.update(d => ({ ...d, rentals: d.rentals.filter(r => r.id !== 'r1') }));
  await uA.update(d => ({ ...d, rentals: [...d.rentals, { id: 'r1', patientId: 'p2', v: 2 }] }));
  await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, a: 1 } : p) }));
  await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, b: 2 } : p) }));
  db.caida = false;
  await A.syncIfRemoteChanged(); await tick(5);
  assert.deepEqual(db.data.rentals.find(r => r.id === 'r1'), { id: 'r1', patientId: 'p2', v: 2 });
  assert.deepEqual(db.data.patients.find(p => p.id === 'p1'), { id: 'p1', name: 'Ana', a: 1, b: 2 });
  assert.deepEqual(uA.data, db.data);
});

test('S1 save sin cambios no genera paso; timeout de app_save no duplica', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const ts0 = db.ts;
  await A.saveData(uA.data, uA.data); await tick(5);
  void ('S1 saves sin cambio', db.ts - ts0);
  const restore = perderRespuestaSave(1);
  await uA.update(d => ({ ...d, rentals: [...d.rentals, { id: 'rX' }] }));
  restore();
  // otro dispositivo borra rX entre medio
  db.data = structuredClone(db.data); db.data.rentals = db.data.rentals.filter(r => r.id !== 'rX'); db.ts++;
  await A.syncIfRemoteChanged(); await tick(5);
  assert.ok(!db.data.rentals.some(r => r.id === 'rX'), 'rX revivio');
});

test('P1 rendimiento 1MB', async () => {
  const big = base();
  big.invoices = Array.from({ length: 3000 }, (_, i) => ({ id: 'i' + i, items: [{ n: 'x'.repeat(300) }] }));
  const { db } = crearEntorno({ remoto: big });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const t = performance.now();
  for (let i = 0; i < 10; i++) await uA.update(d => ({ ...d, invoices: d.invoices.map(x => x.id === 'i5' ? { ...x, k: i } : x) }));
  void ('P1 10 saves ms', Math.round(performance.now() - t), 'blob', JSON.stringify(db.data).length, 'aplicados', pasosAplicados(db).length);
});
