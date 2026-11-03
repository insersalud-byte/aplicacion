console.error = () => {}; // los escenarios provocan errores a proposito
// Harness: base falsa con latencias configurables + localStorage compartido.
let carga = 0;
export function crearEntorno({ remoto } = {}) {
  const db = { data: remoto, ts: 1, caida: false, delayLoad: 0, delaySave: 0, delayTs: 0, rechazar: null, auth401: false, log: [] };
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
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  globalThis.fetch = async (url, opts) => {
    if (db.caida) throw new TypeError('Failed to fetch');
    const fn = String(url).split('/rpc/')[1];
    const body = JSON.parse(opts.body);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => '' });
    if (db.auth401 && fn !== 'app_login') return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    if (fn === 'app_login') { db.auth401 = false; return ok({ ok: true, token: 'tok2' }); }
    if (fn === 'app_load') {
      if (db.delayLoad) await wait(db.delayLoad);
      db.log.push('load@' + db.ts);
      return ok({ data: structuredClone(db.data), updated_at: String(db.ts) });
    }
    if (fn === 'app_ts') { if (db.delayTs) await wait(db.delayTs); db.log.push('ts@' + db.ts); return ok(String(db.ts)); }
    if (fn === 'app_save') {
      if (db.delaySave) await wait(db.delaySave);
      if (db.rechazar && db.rechazar(body.p_data)) { db.log.push('reject'); return { ok: false, status: 400, json: async () => ({}), text: async () => 'rechazo' }; }
      db.data = structuredClone(body.p_data); db.ts++;
      db.log.push('save->' + db.ts);
      return ok(String(db.ts));
    }
    if (fn === 'app_logout') return ok(null);
    return ok(null);
  };
  return { db, store };
}
export function cerrarPestanas() {
  for (const k of [...globalThis.__store.keys()]) if (k.startsWith('insersalud_vivo_')) globalThis.__store.delete(k);
}
export async function cargarModulo() {
  return import(`../src/data/database.js?e=${++carga}`);
}
export const base = () => ({
  patients: [{ id: 'p1', name: 'Ana' }, { id: 'p2', name: 'Beto' }],
  rentals: [{ id: 'r1', patientId: 'p1' }, { id: 'r2', patientId: 'p2' }],
  equiposNuevos: [{ id: 'n1', name: 'CPAP', stock: 1 }],
  settings: { equiposNuevosSembrados: true },
});
export const ids = (arr) => arr.map(x => x.id).sort();
export const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
