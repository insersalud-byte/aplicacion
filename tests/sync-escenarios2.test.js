import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, cerrarPestanas, cargarModulo, base, ids, tick } from './sync-escenarios.helper.js';
const addRental = (id) => (d) => ({ ...d, rentals: [...d.rentals, { id, patientId: 'p1' }] });

test('S10 doble adopcion simultanea + borrado ajeno en el medio', async () => {
  const { db } = crearEntorno({ remoto: base() });
  const X = await cargarModulo(); const sX = await X.loadData();
  const B = await cargarModulo(); await B.loadData();
  const C = await cargarModulo(); await C.loadData();
  db.caida = true; await X.saveData(addRental('rX')(sX), sX); cerrarPestanas(); db.caida = false;
  db.delayLoad = 30; db.delaySave = 30;
  const pB = B.syncIfRemoteChanged();
  await tick(10);
  const pC = C.syncIfRemoteChanged();
  await pB;                          // B adopto rX
  // otro dispositivo borra rX mientras C esta bajando
  db.data.rentals = db.data.rentals.filter(r => r.id !== 'rX'); db.ts++;
  await pC; db.delayLoad = 0; db.delaySave = 0;
  void ('S10 log', db.log.join(' '), 'rentals', ids(db.data.rentals));
  assert.ok(!db.data.rentals.some(r => r.id === 'rX'), 'el huerfano se aplico dos veces y revivio el borrado');
});

test('S11 pestana oculta con pendiente: nadie lo sube mientras siga oculta', async () => {
  const { db, store } = crearEntorno({ remoto: base() });
  const A = await cargarModulo(); const sA = await A.loadData();
  const B = await cargarModulo(); await B.loadData();
  db.caida = true; await A.saveData(addRental('rA'), sA).catch(()=>{});
  await A.saveData(addRental('rA')(sA), sA); db.caida = false;
  // A queda oculta: su intervalo de 20 s sigue marcando vivo, pero App no llama syncIfRemoteChanged
  for (let i = 0; i < 3; i++) { store.set([...store.keys()].find(k=>k.startsWith('insersalud_vivo_') && store.has('insersalud_pend_'+k.slice(16))), String(Date.now())); await B.syncIfRemoteChanged(); }
  void ('S11 rA en base:', db.data.rentals.some(r => r.id === 'rA'));
});

test('S12 claves vivo de pestanas muertas sin pagehide quedan para siempre', async () => {
  const { store } = crearEntorno({ remoto: base() });
  for (let i = 0; i < 5; i++) { const m = await cargarModulo(); await m.loadData(); await m.syncIfRemoteChanged(); }
  const N = await cargarModulo(); await N.loadData(); await N.syncIfRemoteChanged();
  void ('S12 claves vivo:', [...store.keys()].filter(k => k.startsWith('insersalud_vivo_')).length);
});
