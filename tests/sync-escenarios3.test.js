import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, cerrarPestanas, cargarModulo, base, ids, tick } from './sync-escenarios.helper.js';

function app(m, initial) {
  const ui = { data: initial };
  m.onDataChange(d => { ui.data = d; });
  ui.update = (f) => { const prev = ui.data; const next = f(prev); if (next === prev) return; ui.data = next; return m.saveData(next, prev); };
  return ui;
}
const addRental = (id) => (d) => ({ ...d, rentals: [...d.rentals, { id, patientId: 'p1' }] });
const pendKeys = () => [...globalThis.__store.keys()].filter(k => k.startsWith('insersalud_pend_'));

test('F1 pestana descongelada edita MIENTRAS otra adopta su pendiente: edicion nueva perdida', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const B = await cargarModulo(); app(B, await B.loadData());
  db.caida = true;
  await uA.update(addRental('rViejo'));
  cerrarPestanas();                 // A congelada > 2 min
  db.caida = false;
  db.delaySave = 40;
  const s = B.syncIfRemoteChanged(); // B adopta rViejo (save lento)
  await tick(20);
  const g = uA.update(addRental('rNuevoA')); // A vuelve y edita durante la subida de B
  await s; await g; db.delaySave = 0;
  for (let i = 0; i < 3; i++) { await A.syncIfRemoteChanged(); await B.syncIfRemoteChanged(); }
  await tick(5);
  void ('F1 base:', ids(db.data.rentals), 'UI A:', ids(uA.data.rentals), 'pend:', pendKeys(), 'A hayCambios', A.hayCambiosSinSubir());
  assert.ok(db.data.rentals.some(r => r.id === 'rNuevoA'), 'edicion nueva de A perdida');
});

test('F2 pestana descongelada edita DESPUES de la adopcion: re-sube lo adoptado y revive un borrado', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const B = await cargarModulo(); const uB = app(B, await B.loadData());
  db.caida = true;
  await uA.update(addRental('rA'));
  cerrarPestanas();
  db.caida = false;
  await B.syncIfRemoteChanged();
  await tick(1);
  await uB.update(d => ({ ...d, rentals: d.rentals.filter(r => r.id !== 'rA') }));
  assert.ok(!db.data.rentals.some(r => r.id === 'rA'));
  // A vuelve: el usuario edita antes del latido
  await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p2' ? { ...p, name: 'B2' } : p) }));
  void ('F2 base:', ids(db.data.rentals), 'p2', db.data.patients.find(p => p.id === 'p2').name);
  assert.ok(!db.data.rentals.some(r => r.id === 'rA'), 'revivio rA (borrado ajeno)');
});

test('F3 error de red en la subida paso a paso: pasos ya escritos se reaplican y pisan una edicion ajena', async () => {
  const { db } = crearEntorno({ remoto: base() });
  db.rechazar = (d) => d.patients.length === 0;
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  db.caida = true;
  await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, name: 'Ana A' } : p) })); // paso 1
  await uA.update(d => ({ ...d, patients: [] }));     // paso 2 rechazable
  db.caida = false;
  // la red se corta justo despues del primer save del paso a paso
  const realFetch = globalThis.fetch; let saves = 0;
  globalThis.fetch = async (u, o) => {
    const r = await realFetch(u, o);
    if (String(u).endsWith('app_save') && r.ok && ++saves === 1) db.caida = true;
    return r;
  };
  await A.syncIfRemoteChanged();
  globalThis.fetch = realFetch; db.caida = false;
  void ('F3 tras corte: p1 en base', db.data.patients.find(p => p.id === 'p1').name, 'pend', A.hayCambiosSinSubir());
  // otro dispositivo corrige p1
  db.data.patients = db.data.patients.map(p => p.id === 'p1' ? { ...p, name: 'Ana Otro' } : p); db.ts++;
  for (let i = 0; i < 2; i++) await A.syncIfRemoteChanged();
  void ('F3 final p1:', db.data.patients.find(p => p.id === 'p1').name);
  assert.equal(db.data.patients.find(p => p.id === 'p1').name, 'Ana Otro', 'edicion ajena revertida por reaplicacion');
});

test('F4 cuota de localStorage: pasos completos agotan 5 MB con pocas ediciones offline', async () => {
  const big = base();
  big.patients = Array.from({ length: 600 }, (_, i) => ({ id: 'p' + i, name: 'Paciente ' + i, notas: 'x'.repeat(250) }));
  const { db, store } = crearEntorno({ remoto: big });
  const LIM = 5 * 1024 * 1024;
  const real = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (k, v) => {
    let tot = 0; for (const [kk, vv] of store) if (kk !== k) tot += kk.length + vv.length;
    if (tot + k.length + String(v).length > LIM) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    return real(k, v);
  };
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  void ('F4 blob chars', JSON.stringify(db.data).length);
  db.caida = true;
  let n = 0;
  for (; n < 40; n++) {
    await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, name: 'v' + n } : p) }));
    const k = pendKeys()[0]; const g = k && JSON.parse(store.get(k));
    if (!g || g.pasos.length !== n + 1) break;
  }
  const k = pendKeys()[0];
  void ('F4 ultimo paso persistido OK:', n, 'pasos en clave:', k ? JSON.parse(store.get(k)).pasos.length : 0);
  // la pestana se cierra offline
  cerrarPestanas();
  db.caida = false;
  const B = await cargarModulo(); await B.loadData();
  void ('F4 p1 en base tras reabrir:', db.data.patients.find(p => p.id === 'p1').name, 'esperado v' + n);
  assert.equal(db.data.patients.find(p => p.id === 'p1').name, 'v' + (n - 1), 'ediciones perdidas por cuota');
});

test('F5 costo: 50 ediciones offline con blob ~1 MB', async () => {
  const big = base();
  big.patients = Array.from({ length: 2500 }, (_, i) => ({ id: 'p' + i, name: 'Paciente ' + i, notas: 'x'.repeat(350) }));
  const { db } = crearEntorno({ remoto: big });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  void ('F5 blob chars', JSON.stringify(db.data).length);
  db.caida = true;
  const t0 = performance.now(); const tiempos = [];
  for (let n = 0; n < 50; n++) {
    const t = performance.now();
    await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, name: 'v' + n } : p) }));
    tiempos.push(Math.round(performance.now() - t));
  }
  void ('F5 ms por edicion (1,10,25,50):', tiempos[0], tiempos[9], tiempos[24], tiempos[49], 'total', Math.round(performance.now() - t0));
  db.caida = false;
  const t1 = performance.now(); await A.syncIfRemoteChanged();
  void ('F5 ciclo de subida ms', Math.round(performance.now() - t1), 'nombre', db.data.patients.find(p => p.id === 'p1').name);
});
test('F8 respuesta de app_save perdida (commit hecho): se reaplica y revive un borrado ajeno', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const real = globalThis.fetch; let perder = true;
  globalThis.fetch = async (u, o) => { const r = await real(u, o); if (perder && String(u).endsWith('app_save')) { perder = false; throw new TypeError('Failed to fetch'); } return r; };
  await uA.update(d => ({ ...d, rentals: [...d.rentals, { id: 'rA', patientId: 'p1' }] }));
  globalThis.fetch = real;
  db.data.rentals = db.data.rentals.filter(r => r.id !== 'rA'); db.ts++; // otro dispositivo lo borra
  for (let i = 0; i < 2; i++) await A.syncIfRemoteChanged();
  void ('F8 base', ids(db.data.rentals));
  assert.ok(!db.data.rentals.some(r => r.id === 'rA'));
});
