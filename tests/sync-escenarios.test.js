import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, cerrarPestanas, cargarModulo, base, ids, tick } from './sync-escenarios.helper.js';

// Simula App(): dataRef + onDataChange + updateData
function app(m, initial) {
  const ui = { data: initial };
  m.onDataChange(d => { ui.data = d; });
  ui.update = (f) => { const prev = ui.data; const next = f(prev); if (next === prev) return; ui.data = next; return m.saveData(next, prev); };
  return ui;
}
const addRental = (id) => (d) => ({ ...d, rentals: [...d.rentals, { id, patientId: 'p1' }] });

test('S1 logout con pendiente + login en la misma pestana', async () => {
  const { db, store } = crearEntorno({ remoto: base() });
  const m = await cargarModulo();
  const ui = app(m, await m.loadData());
  db.caida = true;
  await ui.update(addRental('rOff'));
  db.caida = false;
  await m.logout();
  assert.equal(m.hayCambiosSinSubir(), true);
  await m.login('x');
  const d = await m.loadData();
  ui.data = d;
  await m.syncIfRemoteChanged(); await m.syncIfRemoteChanged();
  const subido = db.data.rentals.some(r => r.id === 'rOff');
  void ('S1 rOff subido tras re-login:', subido, 'pend keys:', [...store.keys()].filter(k => k.includes('pend')));
  await ui.update(addRental('rNew'));
  const keys = [...store.keys()].filter(k => k.includes('pend'));
  void ('S1 tras nueva edicion, keys pend:', keys, 'rOff en base:', db.data.rentals.some(r => r.id === 'rOff'), 'hayCambios:', m.hayCambiosSinSubir());
  assert.ok(db.data.rentals.some(r => r.id === 'rOff'), 'rOff perdido');
});

test('S2 sesion vencida a mitad de guardado', async () => {
  const { db, store } = crearEntorno({ remoto: base() });
  const m = await cargarModulo();
  const ui = app(m, await m.loadData());
  db.auth401 = true;
  await ui.update(addRental('rAuth'));
  void ('S2 hayCambios tras 401:', m.hayCambiosSinSubir());
  await m.login('x');
  ui.data = await m.loadData();
  await m.syncIfRemoteChanged(); await m.syncIfRemoteChanged();
  void ('S2 rAuth en base tras re-login:', db.data.rentals.some(r => r.id === 'rAuth'));
  await ui.update(addRental('rNew'));
  await m.syncIfRemoteChanged();
  void ('S2 tras otra edicion: rAuth en base:', db.data.rentals.some(r => r.id === 'rAuth'), 'keys:', [...store.keys()].filter(k => k.includes('pend')));
  assert.ok(db.data.rentals.some(r => r.id === 'rAuth'), 'rAuth perdido');
});

test('S3 carga offline con huerfano + edicion propia del mismo registro', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  db.caida = true;
  await uA.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, name: 'Ana A' } : p) }));
  await uA.update(addRental('rOrf'));
  cerrarPestanas();
  const B = await cargarModulo();
  const uB = app(B, await B.loadData()); // offline: muestra cache + huerfano
  assert.equal(uB.data.patients.find(p => p.id === 'p1').name, 'Ana A');
  await uB.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p1' ? { ...p, phone: '123' } : p) }));
  await uB.update(d => ({ ...d, rentals: d.rentals.filter(r => r.id !== 'rOrf') })); // borra el alta del huerfano
  db.caida = false;
  for (let i = 0; i < 4; i++) await B.syncIfRemoteChanged();
  const p1 = db.data.patients.find(p => p.id === 'p1');
  void ('S3 p1 en base:', p1, 'rentals:', ids(db.data.rentals), 'UI p1:', uB.data.patients.find(p => p.id === 'p1'), 'UI rentals', ids(uB.data.rentals));
  assert.equal(p1.phone, '123', 'se perdio la edicion propia');
  assert.ok(!db.data.rentals.some(r => r.id === 'rOrf'), 'revivio el borrado');
});

test('S4 huerfano rechazado por la base: reintento eterno y pestana atascada en cache', async () => {
  const { db } = crearEntorno({ remoto: base() });
  db.rechazar = (d) => d.patients.length === 0;
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  db.caida = true;
  await uA.update(d => ({ ...d, patients: [] }));
  cerrarPestanas();
  db.caida = false;
  db.data.rentals.push({ id: 'rAjeno', patientId: 'p2' }); db.ts++;
  const B = await cargarModulo();
  const uB = app(B, await B.loadData());
  void ('S4 status', B.getSyncStatus().state, 've rAjeno:', uB.data.rentals.some(r => r.id === 'rAjeno'));
  db.log.length = 0;
  for (let i = 0; i < 5; i++) await B.syncIfRemoteChanged();
  await tick(5);
  void ('S4 log 5 latidos:', db.log.join(' '), 've rAjeno:', uB.data.rentals.some(r => r.id === 'rAjeno'), 'status', B.getSyncStatus().state);
  assert.ok(uB.data.rentals.some(r => r.id === 'rAjeno'), 'la pestana nunca recibe lo remoto');
});

test('S5 rechazo de pendiente con varios pasos + edicion nueva durante el guardado', async () => {
  const { db } = crearEntorno({ remoto: base() });
  db.rechazar = (d) => d.patients.length === 0;
  const m = await cargarModulo(); const ui = app(m, await m.loadData());
  db.caida = true;
  await ui.update(addRental('rValido'));             // paso 1 valido
  await ui.update(d => ({ ...d, patients: [] }));    // paso 2 rechazable
  db.caida = false;
  db.delaySave = 30;
  const s = m.syncIfRemoteChanged();                 // reintenta pend (2 pasos)
  await tick(10);
  const g = ui.update(addRental('rNuevo'));          // edicion durante el guardado
  await s; await g; db.delaySave = 0;
  for (let i = 0; i < 3; i++) await m.syncIfRemoteChanged();
  await tick(5);
  void ('S5 base rentals:', ids(db.data.rentals), 'patients:', db.data.patients.length, 'UI rentals:', ids(ui.data.rentals));
  assert.ok(db.data.rentals.some(r => r.id === 'rValido'), 'se perdio el paso valido');
});

test('S6 emitData del rechazo pisa una edicion nueva y la siguiente la borra', async () => {
  const { db } = crearEntorno({ remoto: base() });
  db.rechazar = (d) => d.patients.length === 0;
  const m = await cargarModulo(); const ui = app(m, await m.loadData());
  db.delaySave = 20; db.delayLoad = 30;
  const g0 = ui.update(d => ({ ...d, patients: [] }));   // sera rechazado
  await tick(25);                                         // rechazo recibido, recargando
  const g1 = ui.update(addRental('rE1'));                 // E1 durante la recarga
  await tick(35);
  await tick(1);
  void ('S6 UI tiene rE1 tras emit del rechazo:', ui.data.rentals.some(r => r.id === 'rE1'));
  const g2 = ui.update(d => ({ ...d, patients: d.patients.map(p => p.id === 'p2' ? { ...p, name: 'B2' } : p) })); // E2
  await g0; await g1; await g2; db.delaySave = 0; db.delayLoad = 0;
  for (let i = 0; i < 3; i++) await m.syncIfRemoteChanged();
  await tick(5);
  void ('S6 base rentals:', ids(db.data.rentals), 'UI:', ids(ui.data.rentals), 'p2:', db.data.patients.find(p => p.id === 'p2')?.name);
  assert.ok(db.data.rentals.some(r => r.id === 'rE1'), 'E1 perdido');
});

test('S7 pestana congelada/bfcache: su pendiente es adoptado y luego ella lo re-sube', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const uA = app(A, await A.loadData());
  const B = await cargarModulo(); const uB = app(B, await B.loadData());
  db.caida = true;
  await uA.update(addRental('rA'));
  cerrarPestanas();                    // A congelada (vivo vencido) o pagehide con bfcache
  db.caida = false;
  await B.syncIfRemoteChanged();       // B adopta
  assert.ok(db.data.rentals.some(r => r.id === 'rA'));
  await tick(1);
  await uB.update(d => ({ ...d, rentals: d.rentals.filter(r => r.id !== 'rA') })); // B borra rA
  assert.ok(!db.data.rentals.some(r => r.id === 'rA'));
  await A.syncIfRemoteChanged();       // A vuelve
  void ('S7 rA revivio:', db.data.rentals.some(r => r.id === 'rA'));
  assert.ok(!db.data.rentals.some(r => r.id === 'rA'), 'revivio un borrado');
});

test('S8 subida de huerfanos no serializada con el guardado propio (misma pestana)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const X = await cargarModulo(); const uX = app(X, await X.loadData());
  db.caida = true; await uX.update(addRental('rOrf')); cerrarPestanas(); db.caida = false;
  const A = await cargarModulo();
  // A carga ANTES de que X muera (sin huerfanos): simular con carga y despues el huerfano aparece
  const uA = app(A, (await A.loadData()));
  // (A ya adopto en loadData; recrear huerfano para el latido)
  db.data.rentals = db.data.rentals.filter(r => r.id !== 'rOrf'); db.ts++;
  const Y = await cargarModulo(); const uY = app(Y, await Y.loadData());
  db.caida = true; await uY.update(addRental('rOrf2')); cerrarPestanas(); db.caida = false;
  A.syncIfRemoteChanged; // noop
  db.delaySave = 40;
  const s = A.syncIfRemoteChanged();  // ts -> refresh -> load -> subirHuerfanos (save lento)
  await tick(15);
  void ('S8 log antes de editar:', db.log.slice(-3).join(' '));
  const g = uA.update(addRental('rUser'));
  await s; await g; db.delaySave = 0;
  await tick(5);
  void ('S8 log:', db.log.slice(-6).join(' '), 'base rentals:', ids(db.data.rentals), 'hayCambios A:', A.hayCambiosSinSubir());
  assert.ok(db.data.rentals.some(r => r.id === 'rOrf2'), 'huerfano perdido');
});

test('S9 evento online: dos pestanas, una sube su pendiente y otra adopta un huerfano', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const X = await cargarModulo(); const uX = app(X, await X.loadData());
  const B = await cargarModulo(); const uB = app(B, await B.loadData());
  const C = await cargarModulo(); app(C, await C.loadData());
  db.caida = true;
  await uX.update(addRental('rX'));
  const kx = [...globalThis.__store.keys()].find(k => k.startsWith('insersalud_pend_'));
  await uB.update(addRental('rB'));
  globalThis.__store.delete('insersalud_vivo_' + kx.slice(16)); // X se cierra
  db.caida = false;
  db.delayLoad = 20; db.delaySave = 20;
  await Promise.all([B.syncIfRemoteChanged(), C.syncIfRemoteChanged()]);
  db.delayLoad = 0; db.delaySave = 0;
  for (let i = 0; i < 3; i++) { await B.syncIfRemoteChanged(); await C.syncIfRemoteChanged(); }
  void ('S9 log', db.log.join(' '));
  void ('S9 base rentals:', ids(db.data.rentals), 'B hayCambios:', B.hayCambiosSinSubir());
});
