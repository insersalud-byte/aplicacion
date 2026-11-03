// Tests de la sincronizacion con la base (src/data/database.js) con una base falsa en
// memoria y un localStorage simulado. Cada test carga una copia nueva del modulo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let carga = 0;
// Base falsa: responde app_load / app_ts / app_save como las funciones de Supabase.
function crearEntorno({ remoto, rechazarGuardado = false } = {}) {
  const db = { data: remoto, ts: 1, caida: false };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  store.set('insersalud_session', 'tok');
  globalThis.__store = store;
  const llamadas = [];
  globalThis.fetch = async (url, opts) => {
    if (db.caida) throw new TypeError('Failed to fetch');
    const fn = String(url).split('/rpc/')[1];
    llamadas.push(fn);
    const body = JSON.parse(opts.body);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => '' });
    if (fn === 'app_load') {
      const foto = { data: structuredClone(db.data), updated_at: String(db.ts) };
      if (db.demorarProximaCarga) { db.demorarProximaCarga = false; await new Promise(r => setTimeout(r, 30)); }
      return ok(foto);
    }
    if (fn === 'app_ts') return ok(String(db.ts));
    if (fn === 'app_save') {
      if (rechazarGuardado) return { ok: false, status: 400, json: async () => ({}), text: async () => 'sin pacientes' };
      db.data = structuredClone(body.p_data); db.ts++;
      return ok(String(db.ts));
    }
    return ok(null);
  };
  return { db, store, llamadas };
}
// Simula cerrar todas las pestanas abiertas: dejan de "latir" (pagehide).
function cerrarPestanas() {
  for (const k of [...globalThis.__store.keys()]) if (k.startsWith('insersalud_vivo_')) globalThis.__store.delete(k);
}
async function cargarModulo() {
  return import(`../src/data/database.js?n=${++carga}`);
}
const base = () => ({
  patients: [{ id: 'p1', name: 'Ana' }, { id: 'p2', name: 'Beto' }],
  rentals: [{ id: 'r1', patientId: 'p1' }, { id: 'r2', patientId: 'p2' }],
  equiposNuevos: [{ id: 'n1', name: 'CPAP', stock: 1 }],
});
// Lo que haria otro dispositivo: cambiar la base directamente.
const ajeno = (db, f) => { f(db.data); db.ts++; };
const ids = (arr) => arr.map(x => x.id).sort();

test('un borrado de otro dispositivo no revive al guardar otra cosa (E1)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const m = await cargarModulo();
  const pantalla = await m.loadData();
  ajeno(db, d => { d.rentals = d.rentals.filter(r => r.id !== 'r2'); });
  const next = { ...pantalla, patients: pantalla.patients.map(p => p.id === 'p1' ? { ...p, name: 'Ana M' } : p) };
  await m.saveData(next, pantalla);
  assert.deepEqual(ids(db.data.rentals), ['r1']);
  assert.equal(db.data.patients.find(p => p.id === 'p1').name, 'Ana M');
});

test('dos guardados seguidos no borran altas ni revierten ediciones ajenas (E2)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const m = await cargarModulo();
  const s0 = await m.loadData();
  ajeno(db, d => { d.rentals.push({ id: 'r3', patientId: 'p2' }); d.patients[1].name = 'Beto B'; });
  const s1 = { ...s0, rentals: [...s0.rentals, { id: 'rA', patientId: 'p1' }] };
  const g1 = m.saveData(s1, s0);
  const s2 = { ...s1, rentals: [...s1.rentals, { id: 'rB', patientId: 'p1' }] };
  const g2 = m.saveData(s2, s1);
  await g1; await g2;
  assert.deepEqual(ids(db.data.rentals), ['r1', 'r2', 'r3', 'rA', 'rB']);
  assert.equal(db.data.patients.find(p => p.id === 'p2').name, 'Beto B');
});

test('el latido no pisa un guardado en curso (E3)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const m = await cargarModulo();
  const s0 = await m.loadData();
  const recibidos = [];
  m.onDataChange(d => recibidos.push(d));
  ajeno(db, d => { d.patients[1].name = 'Beto B'; });
  db.demorarProximaCarga = true;                   // la descarga del latido tarda
  const latido = m.syncIfRemoteChanged();          // empieza a bajar lo remoto
  await new Promise(r => setTimeout(r, 5));        // ya esta bajando
  const s1 = { ...s0, rentals: [...s0.rentals, { id: 'rNEW', patientId: 'p1' }] };
  const g = m.saveData(s1, s0);                    // el usuario guarda mientras tanto
  await latido; await g;
  await new Promise(r => setTimeout(r, 0));
  assert.ok(db.data.rentals.some(r => r.id === 'rNEW'));
  assert.equal(db.data.patients.find(p => p.id === 'p2').name, 'Beto B');
  // Ninguna actualizacion de pantalla llego sin el alquiler nuevo.
  for (const d of recibidos) assert.ok(d.rentals.some(r => r.id === 'rNEW'), 'la pantalla perdio rNEW');
});

test('cambios sin conexion sobreviven a reabrir la app sin conexion (E4)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  let m = await cargarModulo();
  const s0 = await m.loadData();
  db.caida = true;
  const s1 = { ...s0, rentals: [...s0.rentals, { id: 'rOff', patientId: 'p1' }] };
  await m.saveData(s1, s0);                        // falla: queda en el navegador
  ajeno({ data: db.data, ts: 0 }, () => {});
  // Se cierra y se reabre la app, todavia sin conexion (al cerrar deja de "latir").
  cerrarPestanas();
  m = await cargarModulo();
  const local = await m.loadData();
  assert.ok(local.rentals.some(r => r.id === 'rOff'));
  db.caida = false;
  db.data.patients.push({ id: 'p3', name: 'Caro' }); db.ts++; // otro dispositivo agrego algo
  await m.syncIfRemoteChanged();
  assert.ok(db.data.rentals.some(r => r.id === 'rOff'), 'se perdio el cambio hecho sin conexion');
  assert.ok(db.data.patients.some(p => p.id === 'p3'), 'se borro el alta ajena');
});

test('un guardado rechazado por la base no queda reintentando para siempre (E7)', async () => {
  const env = crearEntorno({ remoto: base(), rechazarGuardado: true });
  const m = await cargarModulo();
  const s0 = await m.loadData();
  await m.saveData({ ...s0, patients: [] }, s0);
  assert.equal(m.hayCambiosSinSubir(), false);
  env.llamadas.length = 0;
  await m.syncIfRemoteChanged();
  assert.ok(!env.llamadas.includes('app_save'), 'volvio a intentar el guardado rechazado');
});

test('sin base guardada, recuperar cambios locales no borra altas ajenas (E8)', async () => {
  const { db, store } = crearEntorno({ remoto: base() });
  const local = { ...base(), rentals: [...base().rentals, { id: 'rLocal', patientId: 'p1' }] };
  store.set('insersalud_db', JSON.stringify(local));
  store.set('insersalud_dirty', '1');
  db.data.rentals.push({ id: 'rAjeno', patientId: 'p2' }); db.ts++;
  const m = await cargarModulo();
  await m.loadData();
  assert.deepEqual(ids(db.data.rentals), ['r1', 'r2', 'rAjeno', 'rLocal']);
  assert.equal(m.hayCambiosSinSubir(), false);
});

test('una pestana no toma el pendiente de otra que sigue abierta (R2B-1)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo();
  const sA = await A.loadData();
  db.caida = true;
  await A.saveData({ ...sA, patients: sA.patients.map(p => p.id === 'p1' ? { ...p, name: 'Ana EDIT-A' } : p) }, sA);
  db.caida = false;
  const B = await cargarModulo();                 // otra pestana, pantalla sin el cambio de A
  const sB = await B.loadData();
  db.data.patients.push({ id: 'p3', name: 'Caro' }); db.ts++;
  await B.syncIfRemoteChanged();
  await B.saveData({ ...sB, rentals: [...sB.rentals, { id: 'rB', patientId: 'p2' }] }, sB);
  await A.syncIfRemoteChanged();                  // A reintenta lo suyo
  assert.ok(db.data.patients.some(p => p.id === 'p3'), 'se borro el alta ajena');
  assert.equal(db.data.patients.find(p => p.id === 'p1').name, 'Ana EDIT-A');
  assert.ok(db.data.rentals.some(r => r.id === 'rB'));
});

test('dos pestanas sin conexion: al reabrir se suben las dos (R2B-2)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const sA = await A.loadData();
  const B = await cargarModulo(); const sB = await B.loadData();
  db.caida = true;
  await A.saveData({ ...sA, patients: sA.patients.map(p => p.id === 'p1' ? { ...p, name: 'Ana A' } : p) }, sA);
  await B.saveData({ ...sB, rentals: [...sB.rentals, { id: 'rB', patientId: 'p2' }] }, sB);
  cerrarPestanas();
  db.caida = false;
  const C = await cargarModulo();
  const sC = await C.loadData();
  assert.equal(db.data.patients.find(p => p.id === 'p1').name, 'Ana A');
  assert.ok(db.data.rentals.some(r => r.id === 'rB'));
  assert.ok(sC.rentals.some(r => r.id === 'rB'));
  assert.equal(C.hayCambiosSinSubir(), false);
});

test('tras confirmar un guardado, el siguiente sube solo lo nuevo (R2B-3)', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const m = await cargarModulo();
  const s0 = await m.loadData();
  const s1 = { ...s0, rentals: s0.rentals.map(r => r.id === 'r2' ? { ...r, notes: 'edicion 1' } : r) };
  const g1 = m.saveData(s1, s0);
  const s2 = { ...s1, patients: [...s1.patients, { id: 'p9', name: 'Nueve' }] };
  await g1;                                       // el 1 ya subio
  db.caida = true;
  await m.saveData(s2, s1);                       // el 2 falla
  db.caida = false;
  db.data.rentals = db.data.rentals.filter(r => r.id !== 'r2'); db.ts++; // otro borra r2
  await m.syncIfRemoteChanged();
  assert.ok(!db.data.rentals.some(r => r.id === 'r2'), 'revivio un borrado ajeno');
  assert.ok(db.data.patients.some(p => p.id === 'p9'));
});

test('un rechazo descarta solo el cambio rechazado, no los posteriores (R2B-4)', async () => {
  const env = crearEntorno({ remoto: base() });
  const m = await cargarModulo();
  const s0 = await m.loadData();
  // Como app_save real: rechaza un guardado que deja la base sin pacientes.
  const fetchOrig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('app_save') && JSON.parse(opts.body).p_data.patients.length === 0) return { ok: false, status: 400, json: async () => ({}), text: async () => 'sin pacientes' };
    return fetchOrig(url, opts);
  };
  const s1 = { ...s0, patients: [] };
  const g1 = m.saveData(s1, s0);
  const s2 = { ...s1, rentals: [...s1.rentals, { id: 'rNEW', patientId: 'p1' }] };
  const g2 = m.saveData(s2, s1);
  await g1; await g2;
  await m.syncIfRemoteChanged();
  assert.ok(env.db.data.rentals.some(r => r.id === 'rNEW'), 'se perdio el cambio valido');
  assert.equal(env.db.data.patients.length, 2, 'se aplico el cambio rechazado');
});

test('el catalogo de equipos nuevos se siembra una sola vez y se guarda (R2B-7)', async () => {
  const { db } = crearEntorno({ remoto: { ...base(), equiposNuevos: [] } });
  const m = await cargarModulo();
  const d = await m.loadData();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(d.equiposNuevos.length > 0);
  assert.equal(db.data.equiposNuevos.length, d.equiposNuevos.length);
  db.data.equiposNuevos = []; db.ts++;           // el usuario borra todo el catalogo
  const m2 = await cargarModulo();
  const d2 = await m2.loadData();
  assert.equal(d2.equiposNuevos.length, 0, 'volvio a sembrar un catalogo borrado');
});
