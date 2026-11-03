import { seedEquiposNuevos } from './seedEquiposNuevos.js';

const STORAGE_KEY = 'insersalud_db';
const STORAGE_TS_KEY = 'insersalud_db_ts';
const DIRTY_KEY = 'insersalud_dirty';   // hay cambios locales que todavia no llegaron a la base
const BASE_KEY = 'insersalud_base';     // ultimo estado sincronizado (base del merge si se cierra offline)
const SESSION_KEY = 'insersalud_session'; // token de sesion (no la contraseña)
const SUPABASE_URL = 'https://gvharyztavhugqiaihjq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wTO5X4JfeoHP0zg7qq4azQ_OJ3jxfwL';

// ============================================================================
// ACCESO CON CONTRASEÑA
// La tabla inser_app_data ya NO se puede leer ni escribir con la clave publica.
// Todo pasa por funciones de la base (app_login, app_load, app_ts, app_save) que
// exigen un token de sesion. El token se obtiene con la contraseña, dura 30 dias
// desde el ultimo uso y se guarda en este navegador. La contraseña nunca se guarda.
// ============================================================================

const _authListeners = new Set();
// La app se suscribe para volver a la pantalla de ingreso si la sesion vence.
export function onAuthRequired(fn) {
  _authListeners.add(fn);
  return () => _authListeners.delete(fn);
}

export function getSessionToken() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}

function setSessionToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* sin localStorage: la sesion dura lo que la pestaña */ }
}

class AuthError extends Error {
  constructor() { super('Sesion vencida: hay que ingresar la contraseña'); this.code = 'AUTH'; }
}

// Tope de tiempo por llamada: una peticion colgada (red movil) dejaba la sincronizacion
// trabada para siempre en todas las pestanas.
const TOPE_RPC_MS = { app_save: 60000 };
async function rpc(fn, args) {
  const tope = globalThis.__insersaludTopeRpcMs || TOPE_RPC_MS[fn] || 20000; // el global es solo para tests
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const vencido = new Promise((_, rej) => {
    timer = setTimeout(() => { try { ctrl?.abort(); } catch { /* noop */ } rej(new Error(`Sin respuesta de la base (${fn})`)); }, tope);
  });
  try {
    const response = await Promise.race([fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    }), vencido]);
    if (response.status === 401 || response.status === 403) {
      setSessionToken('');
      queueMicrotask(() => _authListeners.forEach(f => f()));
      throw new AuthError();
    }
    // El cuerpo tambien se lee dentro del tope (una respuesta cortada a mitad colgaba el ciclo).
    if (!response.ok) {
      const text = await Promise.race([response.text().catch(() => ''), vencido]);
      const err = new Error(`Supabase ${fn} ${response.status}: ${text}`);
      err.status = response.status;
      throw err;
    }
    return await Promise.race([response.json(), vencido]);
  } finally {
    clearTimeout(timer);
  }
}

// Devuelve { ok: true } o { ok: false, error: 'clave_incorrecta' | 'demasiados_intentos' | 'sin_conexion' }.
export async function login(password) {
  try {
    const res = await rpc('app_login', { p_password: password });
    if (res && res.ok && res.token) {
      setSessionToken(res.token);
      return { ok: true };
    }
    return { ok: false, error: res?.error || 'clave_incorrecta' };
  } catch (e) {
    console.error('Login:', e);
    return { ok: false, error: 'sin_conexion' };
  }
}

// Cierra la sesion. Si quedaron cambios sin subir, no borra la copia local para
// que se suban en el proximo ingreso.
export async function logout() {
  const token = getSessionToken();
  setSessionToken('');
  try { if (token) await rpc('app_logout', { p_token: token }); } catch { /* igual queda cerrada en este navegador */ }
  // Los cambios sin subir quedan en memoria y guardados en el navegador, y se suben al volver
  // a ingresar (sin sesion, el ciclo no puede subirlos: falla y quedan pendientes). Antes se
  // vaciaban aca y un ciclo en vuelo, al terminar, borraba la copia guardada.
  try {
    if (!hayCambiosSinSubir()) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_TS_KEY);
    }
  } catch { /* noop */ }
  _baseState = null;
  _lastRemoteTs = null;
  _ultimaVista = null;
}

export function hayCambiosSinSubir() {
  if (_pasos.length) return true;
  try {
    if (localStorage.getItem(DIRTY_KEY)) return true; // marca de una version anterior
    return clavesPendientes().length > 0;
  } catch { return false; }
}

// Devuelve { ok } o { ok: false, error: 'clave_actual_incorrecta' | 'clave_muy_corta' | ... }.
export async function cambiarClave(actual, nueva) {
  try {
    return await rpc('app_cambiar_clave', { p_token: getSessionToken(), p_actual: actual, p_nueva: nueva });
  } catch (e) {
    return { ok: false, error: e.code === 'AUTH' ? 'sesion_vencida' : 'sin_conexion' };
  }
}

// Sube una foto (data URL ya comprimida) a Cloudflare R2 por la API de la app y
// devuelve la URL publica. Asi la foto NO viaja dentro de los datos de Supabase en
// cada carga (R2 no cobra la transferencia). Si falla, lanza y el formulario puede
// quedarse con la foto en base64 como antes.
export async function subirFoto(dataUrl, carpeta = 'general') {
  const r = await fetch('/api/server?subir_foto=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: getSessionToken(), dataUrl, carpeta }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(j.error || `Error ${r.status} al subir la foto`);
  return j.url;
}

let _syncStatus = { state: 'idle', lastSync: null, error: null };
const _syncListeners = new Set();

export function onSyncStatus(fn) {
  _syncListeners.add(fn);
  return () => _syncListeners.delete(fn);
}

export function getSyncStatus() {
  return _syncStatus;
}

function setSyncStatus(state, error) {
  _syncStatus = { state, lastSync: state === 'ok' ? new Date() : _syncStatus.lastSync, error: error || null };
  const status = _syncStatus;
  queueMicrotask(() => _syncListeners.forEach(fn => fn(status)));
}

export const initialData = {
  patients: [],
  equipment: [],
  rentals: [],
  quotations: [],
  remitos: [],
  descartables: [],
  mascaras: [],
  invoices: [],
  equiposNuevos: seedEquiposNuevos,
  settings: {
    companyName: 'Inser Salud',
    companyPhone: '+54 9 351 206-5320',
    companyAddress: 'Cordoba, Argentina',
    companyEmail: 'inser.salud@gmail.com',
    monthlyRentalPrice: 15000,
    dailyRentalPrice: 500,
    salePriceMultiplier: 3.5
  }
};

function normalizeData(data = {}) {
  return {
    ...initialData,
    ...data,
    settings: {
      ...initialData.settings,
      ...(data.settings || {})
    },
    patients: Array.isArray(data.patients) ? data.patients : [],
    equipment: Array.isArray(data.equipment) ? data.equipment : [],
    rentals: Array.isArray(data.rentals) ? data.rentals : [],
    quotations: Array.isArray(data.quotations) ? data.quotations : [],
    remitos: Array.isArray(data.remitos) ? data.remitos : [],
    descartables: Array.isArray(data.descartables) ? data.descartables : [],
    mascaras: Array.isArray(data.mascaras) ? data.mascaras : [],
    invoices: Array.isArray(data.invoices) ? data.invoices : [],
    equiposNuevos: Array.isArray(data.equiposNuevos) ? data.equiposNuevos : []
  };
}

function loadLocalData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = normalizeData(JSON.parse(saved));
      if (!data.equiposNuevos || data.equiposNuevos.length === 0) {
        data.equiposNuevos = seedEquiposNuevos;
      }
      return data;
    }
  } catch (e) {
    console.error('Error loading data:', e);
  }
  return normalizeData(initialData);
}

// ============================================================================
// SUPABASE = UNICA FUENTE DE VERDAD (single source of truth)
// localStorage solo se usa como cache para modo offline.
// La base de datos SIEMPRE gana: al cargar se lee de Supabase, al guardar
// se escribe a Supabase. Esto evita que cada navegador tenga datos distintos.
// ============================================================================

async function loadRemoteData() {
  const res = await rpc('app_load', { p_token: getSessionToken() });
  if (!res) return { exists: false, data: normalizeData({}), updatedAt: null };
  return {
    exists: true,
    data: normalizeData(res.data || {}),
    updatedAt: res.updated_at || null
  };
}

// Devuelve el updated_at que puso la base. Es el MISMO formato que devuelve
// fetchRemoteTs: antes se guardaba un timestamp armado en el navegador ("...Z")
// que nunca coincidia con el de la base ("...+00:00"), y despues de cada guardado
// propio el latido creia que otro dispositivo habia cambiado algo y bajaba todo.
async function saveRemoteData(data) {
  return rpc('app_save', { p_token: getSessionToken(), p_data: data });
}

// Liviano: solo el timestamp. Sirve para detectar cambios sin bajar todo el blob.
async function fetchRemoteTs() {
  return rpc('app_ts', { p_token: getSessionToken() });
}

function cacheLocal(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    localStorage.setItem(STORAGE_TS_KEY, String(Date.now()));
  } catch (e) {
    // localStorage lleno: guardar version sin imagenes base64 pesadas
    try {
      const slim = {
        ...data,
        equipment: data.equipment.map(eq => ({ ...eq, imageUrl: eq.imageUrl?.startsWith('data:') ? '' : (eq.imageUrl || '') }))
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
      localStorage.setItem(STORAGE_TS_KEY, String(Date.now()));
    } catch (e2) {
      console.error('Error caching local data:', e2);
    }
  }
}

// ============================================================================
// MERGE 3-VIAS POR REGISTRO (anti-clobber multi-dispositivo)
// El estado es un unico blob, pero al guardar NO se pisa entero: se aplican sobre
// lo que hay AHORA en la base solo MIS cambios, medidos contra el estado del que
// salio la edicion (prev -> next). Asi dos dispositivos editando registros
// distintos conservan AMBOS cambios, un borrado ajeno no revive y un alta ajena
// no se borra. (Esto no es el viejo "merge local+remoto" al cargar: al cargar
// manda siempre la base.)
// ============================================================================

const COLLECTIONS = ['patients', 'equipment', 'rentals', 'quotations', 'remitos', 'descartables', 'mascaras', 'invoices', 'equiposNuevos'];

const _dataListeners = new Set();
// Permite que la app reaccione cuando un merge trae cambios de otros dispositivos.
export function onDataChange(fn) {
  _dataListeners.add(fn);
  return () => _dataListeners.delete(fn);
}
function emitData(data) {
  queueMicrotask(() => _dataListeners.forEach(fn => fn(data)));
}

function indexById(arr) {
  const m = new Map();
  (Array.isArray(arr) ? arr : []).forEach(x => { if (x && x.id != null) m.set(x.id, x); });
  return m;
}

// Aplica sobre `remote` los cambios de una coleccion entre `base` (de donde sali) y
// `mine` (adonde llegue). Lo que no toque queda como esta en remoto: si alguien lo
// borro, sigue borrado; si alguien lo agrego o edito, se conserva.
// conBorrados=false: sin base confiable no se borra nada (solo altas/ediciones).
function mergeCollection(base, mine, remote, conBorrados = true) {
  const baseM = indexById(base);
  const mineM = indexById(mine);
  const result = indexById(remote);
  if (conBorrados) {
    for (const id of baseM.keys()) {
      if (!mineM.has(id)) result.delete(id); // lo borre yo
    }
  }
  for (const [id, rec] of mineM) {
    const baseRec = baseM.get(id);
    if (!baseRec || JSON.stringify(baseRec) !== JSON.stringify(rec)) result.set(id, rec); // lo cree o edite yo
  }
  // Mantener el orden: primero el de remoto, despues las altas mias.
  const orden = [...indexById(remote).keys(), ...mineM.keys()];
  const vistos = new Set();
  const out = [];
  for (const id of orden) {
    if (vistos.has(id) || !result.has(id)) continue;
    vistos.add(id); out.push(result.get(id));
  }
  // Registros sin id (no deberia haber) quedan como estan en mine.
  (Array.isArray(mine) ? mine : []).forEach(x => { if (x && x.id == null) out.push(x); });
  return out;
}

// Settings a nivel campo: gana mi valor solo en los campos que cambie.
function mergeSettings(base = {}, mine = {}, remote = {}) {
  const out = { ...remote };
  for (const k of Object.keys(mine || {})) {
    const changedByMe = JSON.stringify((base || {})[k]) !== JSON.stringify(mine[k]);
    if (changedByMe || !(k in out)) out[k] = mine[k];
  }
  return out;
}

export function mergeStates(base, mine, remote, conBorrados = true) {
  const out = { ...remote };
  for (const c of COLLECTIONS) {
    out[c] = mergeCollection(base?.[c], mine?.[c], remote?.[c], conBorrados);
  }
  out.settings = mergeSettings(base?.settings, mine?.settings, remote?.settings);
  return normalizeData(out);
}

function leerJSON(key) {
  try { const raw = localStorage.getItem(key); return raw ? normalizeData(JSON.parse(raw)) : null; } catch { return null; }
}

// ============================================================================
// SINCRONIZACION
// - Cada cambio de la pantalla es un PASO { prev, next }: lo que habia y lo que quedo.
//   Se sube aplicando la diferencia prev -> next sobre lo que hay AHORA en la base.
// - Los pasos sin subir de cada pestana se guardan en localStorage (insersalud_pend_<tab>),
//   asi nada queda solo en la pantalla: si la pestana se cierra o se corta internet, el
//   proximo arranque (o otra pestana, si esta murio) los sube.
// - Todo lo que lee y escribe la base pasa por UN ciclo a la vez en todo el navegador
//   (navigator.locks), asi dos pestanas no se pisan entre si.
// - La pantalla se actualiza con: lo que quedo en la base + mis pasos que todavia no subieron.
// Limite: app_save no tiene compare-and-set. Antes de escribir se vuelve a mirar la version
// de la base (y se rehace la mezcla si cambio), pero entre esa mirada y la escritura queda
// una ventana chica entre DISPOSITIVOS distintos. Se cierra del todo agregando a app_save
// un parametro con el updated_at esperado.
// ============================================================================

const TAB_ID = Math.random().toString(36).slice(2);
const PEND_PREFIX = 'insersalud_pend_';
const VIVO_PREFIX = 'insersalud_vivo_';
const VIVO_VENCE_MS = 2 * 60 * 1000;

let _baseState = null;          // ultimo estado confirmado en la base
let _lastRemoteTs = null;       // su updated_at
let _pasos = [];                // mis cambios sin subir, en orden
let _persistido = false;        // _pasos esta guardado en localStorage
let _enCurso = 0;               // ciclos encolados o corriendo
let _cadena = Promise.resolve();
let _ultimaVista = null;        // ultimo estado que mostro la pantalla (para no emitir de mas)

// ── Pasos como DIFERENCIA ──────────────────────────────────────────────────
// Un paso guarda solo lo que cambio: por coleccion, los registros nuevos/editados (upsert) y
// los ids borrados (remove), y las claves de settings cambiadas. Pesa poco (antes se guardaban
// dos copias enteras de los datos por paso y el localStorage se llenaba en ~14 cambios).
// Cada paso tiene un id: la base guarda los ultimos aplicados en settings._pasosAplicados y un
// paso que ya figura NO se vuelve a aplicar (respuesta perdida, pestana adoptada, reintento).
const CLAVE_APLICADOS = '_pasosAplicados';
const MAX_APLICADOS = 400;
export function calcularDiff(prev, next) {
  const d = { c: {}, s: {} };
  for (const c of COLLECTIONS) {
    const antes = indexById(prev ? prev[c] : []);
    const despues = Array.isArray(next[c]) ? next[c] : [];
    const upsert = despues.filter(r => {
      if (!r || r.id == null) return false;
      const b = antes.get(r.id);
      return !b || (b !== r && JSON.stringify(b) !== JSON.stringify(r));
    });
    const ids = new Set(despues.filter(r => r && r.id != null).map(r => r.id));
    const remove = prev ? [...antes.keys()].filter(id => !ids.has(id)) : [];
    if (upsert.length || remove.length) d.c[c] = { upsert, remove };
  }
  const sp = (prev && prev.settings) || {};
  const sn = next.settings || {};
  for (const k of Object.keys(sn)) {
    if (k === CLAVE_APLICADOS) continue;
    if (!prev || JSON.stringify(sp[k]) !== JSON.stringify(sn[k])) d.s[k] = sn[k];
  }
  return d;
}
export function aplicarDiff(d, estado) {
  const out = { ...estado };
  for (const [c, { upsert = [], remove = [] }] of Object.entries(d.c || {})) {
    const fuera = new Set(remove);
    const nuevos = new Map(upsert.map(r => [r.id, r]));
    const lista = (Array.isArray(estado[c]) ? estado[c] : []).filter(r => !(r && fuera.has(r.id))).map(r => (r && nuevos.has(r.id) ? nuevos.get(r.id) : r));
    const ya = new Set(lista.map(r => r && r.id));
    for (const r of upsert) if (!ya.has(r.id)) lista.push(r);
    out[c] = lista;
  }
  if (d.s && Object.keys(d.s).length) out.settings = { ...(estado.settings || {}), ...d.s };
  return normalizeData(out);
}
// Hash corto (FNV-1a de 32 bits) para ids estables.
function hashTexto(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const nuevoIdPaso = () => TAB_ID + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
// Aplica pasos sobre `sobre` salteando los ya aplicados en la base. marcar=true anota sus ids.
function aplicarPasos(pasos, sobre, marcar = false) {
  const previos = Array.isArray(sobre.settings?.[CLAVE_APLICADOS]) ? sobre.settings[CLAVE_APLICADOS] : [];
  const hechos = new Set(previos);
  let s = sobre;
  const nuevos = [];
  for (const p of pasos) {
    if (hechos.has(p.id)) continue;
    s = aplicarDiff(p.d, s);
    hechos.add(p.id); nuevos.push(p.id);
  }
  if (marcar && nuevos.length) s = { ...s, settings: { ...s.settings, [CLAVE_APLICADOS]: [...previos, ...nuevos].slice(-MAX_APLICADOS) } };
  return s;
}
const pasoValido = (p) => p && p.id && p.d && typeof p.d === 'object';

function clavesPendientes() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PEND_PREFIX)) out.push(k);
    }
  } catch { /* noop */ }
  return out;
}
function marcarVivo() {
  try { localStorage.setItem(VIVO_PREFIX + TAB_ID, String(Date.now())); } catch { /* noop */ }
}
function guardarMisPasos() {
  try {
    if (_pasos.length) localStorage.setItem(PEND_PREFIX + TAB_ID, JSON.stringify({ pasos: _pasos, t: Date.now() }));
    else localStorage.removeItem(PEND_PREFIX + TAB_ID);
    _persistido = _pasos.length > 0;
  } catch {
    // Sin espacio: quedan en memoria y se suben online; se avisa porque si se cierra la pestana
    // sin conexion se perderian.
    _persistido = false;
    setSyncStatus('error', 'No hay espacio en el navegador para guardar los cambios sin conexión.');
  }
  marcarVivo();
}
function leerPasosGuardados(key) {
  try {
    const crudo = localStorage.getItem(key);
    const raw = JSON.parse(crudo);
    if (raw && Array.isArray(raw.pasos)) return { pasos: raw.pasos.filter(pasoValido), t: raw.t || 0, crudo };
  } catch { /* clave corrupta */ }
  return null;
}

// Pasos de pestanas que ya no estan (y el formato de una sola marca de versiones anteriores).
// Una pestana que sigue abierta ("late" hace menos de 2 min) no se toca. Limpia los latidos
// viejos de pestanas que murieron sin avisar.
function pendientesHuerfanos() {
  const out = [];
  const ahora = Date.now();
  const vivoDe = (id) => { try { return Number(localStorage.getItem(VIVO_PREFIX + id)) || 0; } catch { return 0; } };
  const conPend = new Set();
  for (const k of clavesPendientes()) {
    const id = k.slice(PEND_PREFIX.length);
    conPend.add(id);
    if (id === TAB_ID) continue;
    const vivo = vivoDe(id);
    if (vivo && ahora - vivo < VIVO_VENCE_MS) continue;
    const g = leerPasosGuardados(k);
    if (g && g.pasos.length) out.push({ key: k, vivo: VIVO_PREFIX + id, crudo: g.crudo, pasos: g.pasos, t: g.t });
    else { try { localStorage.removeItem(k); } catch { /* noop */ } }
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(VIVO_PREFIX)) continue;
      const id = k.slice(VIVO_PREFIX.length);
      if (id !== TAB_ID && !conPend.has(id) && ahora - (Number(localStorage.getItem(k)) || 0) > VIVO_VENCE_MS) localStorage.removeItem(k);
    }
  } catch { /* noop */ }
  return out.sort((a, b) => a.t - b.t);
}

// Cambios sin subir del formato de versiones anteriores (marca insersalud_dirty + base +
// cache): se convierten UNA vez, antes de que nada reescriba la cache, en un pendiente normal
// con id fijo. Asi el id no cambia aunque despues cambie la cache (se aplicaba dos veces).
function migrarPendienteViejo() {
  try {
    if (!localStorage.getItem(DIRTY_KEY)) return;
    const next = leerJSON(STORAGE_KEY);
    if (next) {
      const d = calcularDiff(leerJSON(BASE_KEY), next);
      const paso = { id: 'legacy-' + hashTexto(JSON.stringify(d)), d };
      localStorage.setItem(PEND_PREFIX + 'legacy', JSON.stringify({ pasos: [paso], t: -1 }));
    }
    localStorage.removeItem(DIRTY_KEY);
    localStorage.removeItem(BASE_KEY);
  } catch { /* sin espacio: queda la marca y se reintenta al proximo arranque */ }
}
migrarPendienteViejo();

// Un ciclo de sincronizacion a la vez en TODO el navegador (todas las pestanas).
function conCandado(fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (locks && typeof locks.request === 'function') return locks.request('insersalud-sync', fn);
  // Sin navigator.locks (navegadores viejos, tests): candado compartido en este proceso.
  const g = globalThis;
  const run = g.__insersaludCandado = (g.__insersaludCandado || Promise.resolve()).then(fn, fn);
  return run;
}
function encolar(opts = {}) {
  _enCurso++;
  const p = _cadena.then(() => conCandado(() => ciclo(opts)));
  _cadena = p.catch(() => {}).finally(() => { _enCurso--; });
  return p;
}

// Error de la base que no se arregla reintentando (4xx que no es de sesion): por ejemplo
// app_save rechazando un guardado que deja la base sin pacientes.
// Solo errores de validacion: 408 (timeout) y 429 (demasiadas peticiones) se reintentan.
const esRechazoDefinitivo = (e) => e && e.code !== 'AUTH' && [400, 409, 422].includes(e.status);

async function bajarBase(usarCache) {
  if (usarCache && _baseState) {
    const ts = await fetchRemoteTs();
    if (ts && ts === _lastRemoteTs) return { data: _baseState, ts };
  }
  const r = await loadRemoteData();
  return { data: r.exists ? r.data : null, ts: r.updatedAt };
}

// Guarda `calcular(base)` sobre la base. Justo antes de escribir vuelve a mirar la version: si
// otro dispositivo guardo en el medio, rehace la mezcla sobre lo nuevo (hasta 3 veces).
async function guardarSobreBase(base, calcular) {
  let actual = base;
  for (let intento = 0; intento < 3; intento++) {
    const resultado = calcular(actual.data);
    const ts = await fetchRemoteTs();
    if (actual.ts && ts && ts !== actual.ts) { actual = await bajarBase(false); continue; }
    const nuevoTs = await saveRemoteData(resultado);
    return { data: resultado, ts: nuevoTs };
  }
  const resultado = calcular(actual.data);
  return { data: resultado, ts: await saveRemoteData(resultado) };
}

// El ciclo: sube mis pasos y los de pestanas muertas, y deja la pantalla al dia.
// opts.latido: solo baja si la base cambio. opts.carga: devuelve la vista inicial.
async function ciclo(opts = {}) {
  marcarVivo();
  // (Si otra pestana adopto mis pasos mientras esta estuvo congelada, se vuelven a enviar pero
  // la base los saltea por id.)
  // Pasos guardados de esta pestana que no estan en memoria (cerro sesion y volvio a entrar).
  if (!_pasos.length) {
    const g = leerPasosGuardados(PEND_PREFIX + TAB_ID);
    if (g && g.pasos.length) { _pasos = g.pasos; _persistido = true; }
  }
  const huerfanos = pendientesHuerfanos();
  const nPropios = _pasos.length;
  const aSubir = [...huerfanos.flatMap(h => h.pasos), ..._pasos.slice(0, nPropios)];

  if (!aSubir.length && opts.latido && _baseState) {
    const ts = await fetchRemoteTs();
    if (!ts || ts === _lastRemoteTs) return null;
  }
  setSyncStatus(aSubir.length ? 'saving' : 'loading');
  let base = await bajarBase(!opts.carga && !opts.forzar && !opts.latido);
  if (!base.data) base = { data: normalizeData(loadLocalData()), ts: null };

  // Quita de pendientes los pasos ya subidos (o descartados): los mios de memoria y los de
  // pestanas muertas. La clave de un huerfano se borra solo si nadie la reescribio mientras
  // tanto (si su pestana revivio y agrego cambios, queda y se sube despues; lo ya subido se
  // saltea por id).
  const resueltos = new Set();
  const limpiarResueltos = () => {
    _pasos = _pasos.filter(p => !resueltos.has(p.id));
    guardarMisPasos();
    for (const h of huerfanos) {
      if (!h.pasos.every(p => resueltos.has(p.id))) continue;
      try {
        if (localStorage.getItem(h.key) === h.crudo) {
          localStorage.removeItem(h.key);
          if (h.vivo) localStorage.removeItem(h.vivo);
          if (h.extra) localStorage.removeItem(h.extra);
        }
      } catch { /* noop */ }
    }
  };

  let final = base;
  if (aSubir.length) {
    try {
      final = await guardarSobreBase(base, (d) => aplicarPasos(aSubir, d, true));
      aSubir.forEach(p => resueltos.add(p.id));
    } catch (e) {
      if (!esRechazoDefinitivo(e)) throw e;
      // Algun paso lo rechaza la base: se prueban de a uno y se descarta solo el rechazado.
      // Cada paso que entra se quita de pendientes en el momento (si se corta la red a mitad,
      // no se vuelve a aplicar).
      console.error('La base rechazo un cambio:', e);
      let actual = await bajarBase(false);
      for (const paso of aSubir) {
        try {
          actual = await guardarSobreBase(actual, (d) => aplicarPasos([paso], d, true));
          _baseState = actual.data; _lastRemoteTs = actual.ts;
        } catch (e2) {
          if (!esRechazoDefinitivo(e2)) { limpiarResueltos(); throw e2; }
          console.error('Cambio descartado (la base lo rechazo):', e2);
          setTimeout(() => setSyncStatus('error', 'La base rechazó un cambio y no se guardó.'), 0);
        }
        resueltos.add(paso.id);
        limpiarResueltos();
      }
      final = actual;
    }
    limpiarResueltos();
  }
  _baseState = final.data;
  _lastRemoteTs = final.ts;
  // La pantalla: lo que quedo en la base + mis cambios que todavia no subieron.
  const vista = aplicarPasos(_pasos, final.data);
  cacheLocal(vista);
  if (_syncStatus.state !== 'error' || !aSubir.length) setSyncStatus('ok');
  if (!opts.carga && JSON.stringify(vista) !== JSON.stringify(_ultimaVista)) {
    _ultimaVista = vista;
    emitData(vista);
  }
  _ultimaVista = vista;
  return vista;
}

// ── Aligerado de datos ──────────────────────────────────────────────────────
// El estado entero se sube en CADA guardado. Con fotos en base64 el blob habia
// llegado a 4,2 MB y un guardado tardaba ~24 s: parecia que no guardaba y habia
// que guardar dos veces. Estas migraciones corren una sola vez al cargar.

// 1) Los documentos guardados (cotizaciones/facturas/remitos) copiaban la foto
//    base64 de cada producto. El PDF ya se genero; en el historial no hace falta.
function quitarFotosDeDocumentos(data) {
  let quitadas = 0;
  const limpiar = (arr) => (Array.isArray(arr) ? arr.map(it => {
    if (it && typeof it.imageUrl === 'string' && it.imageUrl.startsWith('data:')) {
      quitadas++;
      return { ...it, imageUrl: '' };
    }
    return it;
  }) : arr);
  ['quotations', 'invoices', 'remitos'].forEach(k => {
    if (!Array.isArray(data[k])) return;
    data[k] = data[k].map(doc => ({ ...doc, items: limpiar(doc.items), cartItems: limpiar(doc.cartItems) }));
  });
  return quitadas;
}

// 2) Comprime una foto base64 con canvas (mismo criterio que usa la app al subir).
// 480 px alcanza para las tarjetas (~260 px) y para los PDF (fotos de 17 mm).
// Con 900 px las 14 fotos de mascarillas sumaban 957 KB de los 1,16 MB del blob.
function comprimirFotoBase64(dataUrl, maxW = 480, quality = 0.72) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const ratio = Math.min(maxW / img.width, 1);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const out = canvas.toDataURL('image/jpeg', quality);
          resolve(out.length < dataUrl.length ? out : dataUrl);
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch { resolve(dataUrl); }
  });
}

async function comprimirFotosDeProductos(data) {
  let comprimidas = 0;
  for (const col of ['mascaras', 'equipment', 'equiposNuevos', 'descartables']) {
    if (!Array.isArray(data[col])) continue;
    const nuevos = [];
    for (const it of data[col]) {
      const u = it?.imageUrl;
      // Solo fotos base64 grandes (las chicas ya estan bien).
      if (typeof u === 'string' && u.startsWith('data:image') && u.length > 40000) {
        const out = await comprimirFotoBase64(u);
        if (out !== u) { comprimidas++; nuevos.push({ ...it, imageUrl: out }); continue; }
      }
      nuevos.push(it);
    }
    data[col] = nuevos;
  }
  return comprimidas;
}

// Corre las migraciones y devuelve true si hubo cambios que convenga guardar.
// Solo corre en la app publicada: ni en local ni en las vistas previas de Vercel
// (usan la base real y no deben reescribir datos solo por abrirlas para probar).
const HOSTS_PRODUCCION = ['aplicacion-beta.vercel.app', 'app.insersalud.com'];
async function aligerarDatos(data) {
  if (import.meta.env?.DEV || typeof window === 'undefined' || !HOSTS_PRODUCCION.includes(window.location.hostname)) return false;
  const quitadas = quitarFotosDeDocumentos(data);
  const comprimidas = await comprimirFotosDeProductos(data);
  if (quitadas || comprimidas) {
    console.info(`Datos aligerados: ${quitadas} fotos duplicadas quitadas de documentos, ${comprimidas} fotos comprimidas.`);
    return true;
  }
  return false;
}

export async function loadData() {
  migrarPendienteViejo();
  setSyncStatus('loading');
  _baseState = null;
  _lastRemoteTs = null;
  try {
    let data = await encolar({ carga: true });
    // Sembrar el catalogo de equipos nuevos UNA sola vez (si la base nunca tuvo): se sube
    // como un cambio mas. Antes se mostraba sin guardarlo y, si se borraba todo el
    // catalogo, volvia a aparecer al recargar.
    if ((!data.equiposNuevos || data.equiposNuevos.length === 0) && !data.settings?.equiposNuevosSembrados) {
      const sembrado = { ...data, equiposNuevos: seedEquiposNuevos, settings: { ...data.settings, equiposNuevosSembrados: true } };
      saveData(sembrado, data);
      data = sembrado;
    }
    // Aligerar el blob (una sola vez), despues del arranque y solo si nadie cambio nada.
    const cargado = _baseState;
    setTimeout(async () => {
      try {
        const copia = JSON.parse(JSON.stringify(cargado));
        if (!(await aligerarDatos(copia))) return;
        if (_pasos.length || _enCurso > 0 || _baseState !== cargado) return; // queda para la proxima carga
        await saveData(copia, cargado);
      } catch (e) { console.error('No se pudo aligerar los datos:', e); }
    }, 1500);
    return data;
  } catch (e) {
    // Sesion vencida o sin contraseña: no mostrar datos, volver al ingreso.
    if (e.code === 'AUTH') {
      setSyncStatus('error', e.message);
      throw e;
    }
    // Sin conexion: cache local + cambios sin subir (mios y de pestanas cerradas); se suben
    // en el latido cuando vuelva la conexion.
    console.error('Sync error on load (usando cache local):', e);
    setSyncStatus('error', e.message);
    if (!_pasos.length) {
      const g = leerPasosGuardados(PEND_PREFIX + TAB_ID);
      if (g) { _pasos = g.pasos; _persistido = true; }
    }
    const vista = aplicarPasos([...pendientesHuerfanos().flatMap(h => h.pasos), ..._pasos], loadLocalData());
    _ultimaVista = vista;
    return vista;
  }
}

// prevState = el estado del que salio la edicion (lo que tenia la pantalla).
export function saveData(nextState, prevState) {
  const next = normalizeData(nextState);
  const prev = prevState ? normalizeData(prevState) : (_ultimaVista || _baseState);
  const d = calcularDiff(prev, next);
  if (Object.keys(d.c).length || Object.keys(d.s).length) _pasos = [..._pasos, { id: nuevoIdPaso(), d }];
  _ultimaVista = next;
  guardarMisPasos();
  cacheLocal(next);
  return encolar().catch(e => {
    console.error('Sync error on save:', e);
    setSyncStatus('error', e.message);
  });
}

// Re-sincronizar desde la base (al volver a la pestana / reconexion).
export function refreshFromRemote() {
  return encolar({ forzar: true }).catch(e => setSyncStatus('error', e.message));
}

// Latido barato: mira solo la version de la base y baja todo si cambio. Si hay cambios sin
// subir (mios o de una pestana cerrada) los sube primero.
export function syncIfRemoteChanged() {
  if (_enCurso > 0) return Promise.resolve();
  return encolar({ latido: true }).catch(e => setSyncStatus('error', e.message));
}

// En el navegador: latir cada 20 s y, si hay cambios sin subir, reintentarlos aunque la
// pestana este oculta (el latido de la app corre solo con la pestana visible).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  marcarVivo();
  setInterval(() => {
    marcarVivo();
    if (_pasos.length && _enCurso === 0 && getSessionToken()) encolar().catch(() => {});
  }, 20000);
  window.addEventListener('pagehide', () => { try { localStorage.removeItem(VIVO_PREFIX + TAB_ID); } catch { /* noop */ } });
  window.addEventListener('pageshow', marcarVivo);
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Numero de documento (COT-/REM-/FAC-) con apellido del cliente para que el
// PDF descargado y el historial se encuentren facil. Ej: COT-PEREZ-MQ874DYD.
// Apellido: lo que esta antes de la coma ("PEREZ, JOSE") o la ultima palabra
// ("Jose Perez"). Sin nombre de cliente, queda solo prefijo + timestamp.
export function generateDocNumber(prefix, clientName = '') {
  // Timestamp + 2 caracteres al azar: con solo el milisegundo, dos documentos del mismo
  // cliente generados a la vez (dos dispositivos o doble clic) repetian numero.
  const ts = Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  const raw = String(clientName || '').trim();
  if (!raw) return `${prefix}-${ts}`;
  const base = raw.includes(',') ? raw.split(',')[0] : raw.split(/\s+/).pop();
  const slug = base
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sin acentos
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  return slug ? `${prefix}-${slug}-${ts}` : `${prefix}-${ts}`;
}

import { toLocalDateStr, getToday } from './fechas.js';
export { toLocalDateStr, getToday };

// new Date('YYYY-MM-DD') parsea como medianoche UTC (= dia anterior 21:00 en
// Argentina). Parsear como medianoche LOCAL para que no se corra un dia.
export function parseLocalDate(dateString) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return new Date(`${dateString}T00:00:00`);
  return new Date(dateString);
}

export function formatDate(dateString) {
  if (!dateString) return '-';
  return parseLocalDate(dateString).toLocaleDateString('es-AR');
}

export function getDaysUntilEnd(endDate) {
  if (!endDate) return 0;
  const end = parseLocalDate(endDate);
  const today = parseLocalDate(getToday());
  return Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function formatCurrency(amount) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
  }).format(amount || 0);
}

// Fecha de una celda de Excel a YYYY-MM-DD: numero de serie de Excel (dias desde
// 1899-12-30), Date, "dd/mm/aaaa", "dd-mm-aaaa" o "aaaa-mm-dd". '' si no se entiende.
// Antes se guardaba crudo (ej. 45900) y rompia toda la logica de vencimientos.
export function fechaDeExcel(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return toLocalDateStr(v);
  if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000) {
    const d = new Date(1899, 11, 30 + Math.floor(v));
    return toLocalDateStr(d);
  }
  const t = String(v).trim();
  // Solo fechas que existen (31/02 o mes 13 se rechazan).
  const valida = (y, mes, dia) => {
    const d = new Date(y, mes - 1, dia);
    return d.getFullYear() === y && d.getMonth() === mes - 1 && d.getDate() === dia
      ? `${y}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}` : '';
  };
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valida(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return valida(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[2]), Number(m[1]));
  return '';
}

// Nombre para comparar: sin acentos, sin mayusculas ni espacios de mas.
const claveNombre = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Importe de una celda: numero, o texto como "25.000", "$ 25.000,50" o "25000". 0 si no se
// entiende (antes "25.000" se leia como 25 y "$ 25.000" como NaN).
export function importeDeExcel(v) {
  if (typeof v === 'number') return isFinite(v) && v > 0 ? v : 0;
  const t = String(v ?? '').replace(/[^\d.,]/g, '');
  if (!t) return 0;
  let n;
  if (t.includes(',') && t.includes('.') && t.lastIndexOf('.') > t.lastIndexOf(',')) {
    n = Number(t.replace(/,/g, '')); // "1,500.00": coma de miles y punto decimal
  } else if (/^\d{1,3}(,\d{3}){2,}$/.test(t)) {
    n = Number(t.replace(/,/g, '')); // "1,500,000": comas de miles (formato US)
  } else if (t.includes(',')) {
    // Formato argentino: punto = miles, coma = decimales ("1.012,50").
    n = Number(t.replace(/\./g, '').replace(',', '.'));
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    n = Number(t.replace(/\./g, '')); // "25.000" o "1.500.000": puntos de miles
  } else {
    n = Number(t); // "1070.5" o "25000.50": punto decimal
  }
  return isFinite(n) && n > 0 ? n : 0;
}

const COLS_NOMBRE = ['NOMBRE', 'NOMBRE Y APELLIDO', 'paciente', 'NOMBRECliente'];
const valorCol = (row, cols) => { for (const c of cols) if (row[c] !== undefined && row[c] !== null && row[c] !== '') return row[c]; return ''; };

// existingRentals: para no asignar una unidad que ya esta alquilada a otro paciente.
export function parseExcelData(data, existingPatients = [], existingEquipment = [], existingRentals = []) {
  if (!data || data.length === 0) return { patients: [], equipment: [], rentals: [] };

  // Hay alquileres si CUALQUIER fila tiene fecha de alta (antes solo se miraba la primera).
  const hasRentalData = data.some(r => r && (r['FECHA ALTA'] || r['INICIO']));

  const patients = [];
  const equipment = [];
  const rentals = [];
  const hoy = getToday();
  // Unidades ocupadas: alquileres en curso de la base + las ya asignadas en esta importacion.
  const ocupadas = new Set((existingRentals || []).filter(r => r && r.status !== 'finalizado').map(r => r.equipmentId));

  // Coincidencia EXACTA (normalizada) de nombre. Antes se buscaba por la primera palabra
  // y el alquiler de "Juan Perez" quedaba a nombre de "Juan Gomez".
  const buscarPaciente = (name) => {
    const k = claveNombre(name);
    if (!k) return null;
    return patients.find(p => claveNombre(p.name) === k) || existingPatients.find(p => claveNombre(p.name) === k) || null;
  };
  const porSerie = (sr) => equipment.find(e => String(e.serialNumber || '').trim() === sr) || existingEquipment.find(e => String(e.serialNumber || '').trim() === sr) || null;
  const nuevaUnidad = (name, serie, row, index) => {
    const eq = {
      id: generateId(),
      serialNumber: String(serie || '').trim() || 'EQ-' + (index + 1),
      name: String(name).trim(),
      type: 'otro',
      status: 'disponible',
      images: [],
      description: row['DESCRIPCION'] || row['descripcion'] || '',
      available: true
    };
    equipment.push(eq);
    return eq;
  };
  // Unidad para una fila. Con serie manda la serie (si no existe, es otra unidad). Sin serie,
  // una unidad LIBRE del mismo modelo, o una nueva: antes dos pacientes podian quedar con la
  // misma unidad fisica (incluso una ya alquilada).
  const unidadParaFila = (name, serie, row, index, paraAlquiler) => {
    const k = claveNombre(name);
    const sr = String(serie || '').trim();
    if (sr) return porSerie(sr) || (k ? nuevaUnidad(name, sr, row, index) : null);
    if (!k) return null;
    const mismas = [...equipment, ...existingEquipment].filter(e => claveNombre(e.name) === k);
    const libre = paraAlquiler ? mismas.find(e => !ocupadas.has(e.id)) : mismas[0];
    return libre || nuevaUnidad(name, '', row, index);
  };

  data.forEach((row, index) => {
    if (!row) return;

    const name = valorCol(row, COLS_NOMBRE);
    let patient = null;
    if (name && typeof name === 'string' && name.trim().length > 2) {
      const dni = String(row['DNI'] || row['dni'] || '').replace(/\.+$/, '');
      const phone = String(row['TELEFONO'] || row['telefono'] || row['CELULAR'] || row['telefonoCliente'] || '');
      const address = row['DIRECCION'] || row['direccion'] || row['DOMICILIO'] || row['direccionCliente'] || '';
      // Una persona con varias filas (varios equipos) es UN paciente.
      patient = buscarPaciente(name);
      if (!patient) {
        patient = {
          id: generateId(),
          name: name.trim(),
          dni: dni,
          phone: phone,
          address: address,
          observations: row['OBSERVACIONES'] || row['observaciones'] || '',
          documents: [],
          createdAt: hoy
        };
        patients.push(patient);
      }
    }

    const equipName = row['EQUIPO'] || row['equipo'] || '';
    const serie = row['SERIE'] ?? row['serie'] ?? '';
    const esAlquiler = hasRentalData && Boolean(row['FECHA ALTA'] || row['INICIO'] || row['fecha'] || row['VENCIMIENTO'] || row['FIN'] || row['fechaFin'] || importeDeExcel(row['importe'] || row['IMPORTE'] || row['PRECIO'] || row['precio']));
    let equip = null;
    if (equipName && typeof equipName === 'string' && equipName.trim().length > 2) {
      equip = unidadParaFila(equipName, serie, row, index, esAlquiler);
    }

    if (!esAlquiler || !(patient || equip)) return;
    const startDate = fechaDeExcel(row['FECHA ALTA'] || row['INICIO'] || row['fecha']) || hoy;
    const endDate = fechaDeExcel(row['VENCIMIENTO'] || row['FIN'] || row['fechaFin']);
    const price = importeDeExcel(row['importe'] || row['IMPORTE'] || row['PRECIO'] || row['precio']);
    if (!(price > 0 || endDate)) return;
    if (equip) ocupadas.add(equip.id);
    rentals.push({
      id: generateId(),
      patientId: patient?.id || '',
      equipmentId: equip?.id || '',
      period: 'mensual',
      startDate,
      endDate: endDate || '',
      price,
      // Comparacion de fechas como texto local (vence hoy = vencido).
      status: endDate && endDate <= hoy ? 'vencido' : 'activo',
      notes: row['OBSERVACIONES'] || row['observaciones'] || '',
      createdAt: hoy
    });
  });

  return { patients, equipment, rentals };
}

export function sendWhatsApp(phone, message) {
  const cleaned = phone.replace(/\D/g, '');
  const formattedPhone = cleaned.startsWith('54') ? cleaned : '54' + cleaned;
  const encodedMessage = encodeURIComponent(message);
  window.open(`https://wa.me/${formattedPhone}?text=${encodedMessage}`, '_blank');
}

function loadImageAsBase64(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 100;
        canvas.height = img.naturalHeight || img.height || 100;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Corta la espera de una foto: si no llega a tiempo, el PDF sale igual (sin esa
// foto) en vez de quedarse colgado o fallar. Cada intento tiene su propio tope.
function conTopeDeTiempo(promesa, ms) {
  return Promise.race([promesa, new Promise(res => setTimeout(() => res(null), ms))]);
}

async function toBase64Image(url) {
  try {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    // 1) Carga directa (sirve para same-origin o CDNs que permiten CORS).
    let result = await conTopeDeTiempo(loadImageAsBase64(url), 5000);
    if (result) return result;
    if (/^https?:\/\//.test(url)) {
      // 2) Proxy propio (funcion de Vercel, same-origin: sin problema de CORS).
      //    Necesario porque cdn.zyrosite.com no manda Access-Control-Allow-Origin
      //    y el canvas queda "tainted": la foto no llegaba al PDF.
      result = await conTopeDeTiempo(loadImageAsBase64(`/api/server?img=${encodeURIComponent(url)}`), 6000);
      if (result) return result;
      // 3) Fallback universal: proxy publico de imagenes con CORS.
      result = await conTopeDeTiempo(loadImageAsBase64(`https://wsrv.nl/?url=${encodeURIComponent(url)}`), 6000);
      if (result) return result;
    }
    return null;
  } catch {
    return null; // una foto nunca debe impedir que se genere el documento
  }
}

export async function generateInvoicePDF(invoiceData, settings, type = 'factura') {
  const { jsPDF } = await import('jspdf');

  // allSettled + tope global: ninguna foto puede tumbar ni colgar el documento.
  const resultados = await conTopeDeTiempo(Promise.allSettled([
    toBase64Image(window.location.origin + '/logo.jpg'),
    ...invoiceData.items.map(item => toBase64Image(item.imageUrl || ''))
  ]), 20000);
  const fotos = Array.isArray(resultados)
    ? resultados.map(r => (r.status === 'fulfilled' ? r.value : null))
    : new Array(invoiceData.items.length + 1).fill(null);
  const [logoBase64, ...itemImages] = fotos;
  const hasAnyImage = itemImages.some(Boolean);

  const doc = new jsPDF('p', 'mm', 'a4');
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const isCotizacion = type === 'cotizacion';
  const isRemito = type === 'remito';
  const title = isRemito ? 'REMITO' : (isCotizacion ? 'COTIZACION' : 'FACTURA');

  // ── Header ──────────────────────────────────────────────────────────────
  doc.setFillColor(30, 90, 168);
  doc.rect(0, 0, width, 48, 'F');

  if (logoBase64) {
    try { doc.addImage(logoBase64, 'JPEG', 6, 4, 38, 38); } catch {}
  }

  const cx = logoBase64 ? width / 2 + 15 : width / 2;
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont(undefined, 'bold');
  doc.text(settings.companyName || 'INSER SALUD', cx, 18, { align: 'center' });
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  let hy = 25;
  if (settings.companyPhone) { doc.text(`Tel: ${settings.companyPhone}`, cx, hy, { align: 'center' }); hy += 5; }
  if (settings.companyAddress) { doc.text(settings.companyAddress, cx, hy, { align: 'center' }); hy += 5; }
  if (settings.companyEmail) { doc.text(settings.companyEmail, cx, hy, { align: 'center' }); hy += 5; }
  doc.setFont(undefined, 'bold');
  doc.text(settings.companyWebsite || 'inser.ar', cx, hy, { align: 'center' });
  doc.setFont(undefined, 'normal');

  // ── Title ────────────────────────────────────────────────────────────────
  let y = 56;
  doc.setTextColor(30, 90, 168);
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text(title, width / 2, y, { align: 'center' });
  if (!isCotizacion && !isRemito) {
    // Aclaracion legal en letra chica debajo del titulo FACTURA.
    y += 5;
    doc.setTextColor(120, 120, 120);
    doc.setFontSize(7.5);
    doc.setFont(undefined, 'normal');
    doc.text('Documento sin validez fiscal', width / 2, y, { align: 'center' });
    y += 5;
  } else {
    y += 10;
  }

  // ── Doc info ─────────────────────────────────────────────────────────────
  doc.setTextColor(60, 60, 60);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`Fecha: ${formatDate(invoiceData.date)}`, 20, y);
  if (invoiceData.invoiceNumber) doc.text(`N°: ${invoiceData.invoiceNumber}`, width - 20, y, { align: 'right' });
  y += 10;
  doc.setDrawColor(30, 90, 168);
  doc.setLineWidth(0.5);
  doc.line(20, y, width - 20, y);
  y += 8;

  // ── Client ───────────────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('CLIENTE', 20, y);
  y += 7;
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  if (invoiceData.clientName) doc.text(invoiceData.clientName, 20, y);
  if (invoiceData.clientPhone) doc.text(`Tel: ${invoiceData.clientPhone}`, width - 20, y, { align: 'right' });
  y += 6;
  if (invoiceData.clientAddress) { doc.text(`Dir: ${invoiceData.clientAddress}`, 20, y); y += 6; }
  y += 8;

  // ── Items ────────────────────────────────────────────────────────────────
  if (isRemito) {
    // REMITO: only photo + description, no prices
    invoiceData.items.forEach((item, i) => {
      const imgData = itemImages[i];
      doc.setFontSize(10);
      // El nombre se parte en lineas (antes, sin foto, se salia del margen derecho) y el
      // renglon crece segun las lineas.
      const lineasNombre = doc.splitTextToSize(String(item.name || ''), imgData ? 140 : width - 44);
      const rh = Math.max(imgData ? 20 : 9, lineasNombre.length * 4.5 + 4);
      if (y + rh > height - 25) { doc.addPage(); y = 20; }
      if (i % 2 === 0) {
        doc.setFillColor(248, 250, 252);
        doc.rect(20, y - 5, width - 40, rh, 'F');
      }
      if (imgData) {
        try { doc.addImage(imgData, 'JPEG', 22, y - 4, 17, 17); } catch {}
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(60, 60, 60);
        doc.text(lineasNombre, 43, y + 2);
      } else {
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(60, 60, 60);
        doc.text(lineasNombre, 22, y);
      }
      y += rh;
    });
  } else {
    // COTIZACION / FACTURA: full table with prices
    const rowH = hasAnyImage ? 18 : 8;
    const textX = hasAnyImage ? 42 : 22;
    const descW = hasAnyImage ? 70 : 85;
    doc.setFillColor(240, 245, 250);
    doc.rect(20, y - 4, width - 40, 8, 'F');
    doc.setFontSize(9);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(30, 90, 168);
    doc.text('Descripcion', textX, y);
    doc.text('Cant.', 120, y, { align: 'center' });
    doc.text('P. Unit.', 150, y, { align: 'center' });
    doc.text('Subtotal', width - 22, y, { align: 'right' });
    y += 8;
    doc.setFont(undefined, 'normal');
    doc.setTextColor(60, 60, 60);
    // Misma cantidad y precio que usa el total (sin "|| 1": antes una cantidad 0 se
    // imprimia como 1 y las filas no sumaban el TOTAL).
    const cantDe = (it) => Number(it.quantity) || 0;
    const precioDe = (it) => Number(it.price) || 0;
    let sumaFilas = 0;
    invoiceData.items.forEach((item, i) => {
      const subtotal = precioDe(item) * cantDe(item);
      sumaFilas += subtotal;
      const nameLines = doc.splitTextToSize(String(item.name || ''), descW);
      // El renglon crece con las lineas del nombre (antes se encimaba con el de abajo).
      const rh = Math.max(rowH, nameLines.length * 4.5 + 3);
      if (y + rh > height - 25) { doc.addPage(); y = 20; }
      if (i % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(20, y - 4, width - 40, rh, 'F');
      }
      const imgData = itemImages[i];
      if (imgData) { try { doc.addImage(imgData, 'JPEG', 22, y - 3, 16, 16); } catch {} }
      doc.text(nameLines, textX, y + (hasAnyImage ? 3 : 0));
      const rowMid = hasAnyImage ? y + 5 : y;
      doc.text(String(cantDe(item)), 120, rowMid, { align: 'center' });
      doc.text(formatCurrency(precioDe(item)), 150, rowMid, { align: 'center' });
      doc.text(formatCurrency(subtotal), width - 22, rowMid, { align: 'right' });
      y += rh;
    });
    if (y + 16 > height - 20) { doc.addPage(); y = 20; }
    y += 3;
    doc.setDrawColor(30, 90, 168);
    doc.line(20, y, width - 20, y);
    y += 8;
    doc.setFont(undefined, 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30, 90, 168);
    // El TOTAL impreso es la suma de las filas impresas.
    doc.text(`TOTAL: ${formatCurrency(sumaFilas)}`, width - 22, y, { align: 'right' });
  }

  if (invoiceData.notes) {
    y += 12;
    if (y > height - 30) { doc.addPage(); y = 20; }
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 100, 100);
    doc.text('Observaciones:', 20, y);
    y += 5;
    // Observaciones largas: salto de pagina en vez de cortarse al final de la hoja.
    const splitNotes = doc.splitTextToSize(invoiceData.notes, 170);
    splitNotes.forEach(linea => {
      if (y > height - 20) { doc.addPage(); y = 20; }
      doc.text(linea, 20, y);
      y += 4.5;
    });
  }

  // Signature block for remito
  if (isRemito) {
    if (y > height - 70) { doc.addPage(); y = 20; }
    y += 18;
    doc.setDrawColor(30, 90, 168);
    doc.setLineWidth(0.4);
    doc.line(20, y, width - 20, y);
    y += 8;
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(30, 90, 168);
    doc.text('RECIBI CONFORME', width / 2, y, { align: 'center' });
    y += 12;
    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(60, 60, 60);
    doc.text('FIRMA:', 20, y);
    const firmaVal = invoiceData.sigFirma ? ` ${invoiceData.sigFirma}` : '';
    doc.line(45, y, width - 20, y);
    if (firmaVal) doc.text(firmaVal.trim(), 47, y - 1);
    y += 10;
    doc.text('ACLARACION:', 20, y);
    doc.line(52, y, width - 20, y);
    if (invoiceData.sigAclaracion) doc.text(invoiceData.sigAclaracion, 54, y - 1);
    y += 10;
    doc.text('DNI:', 20, y);
    doc.line(35, y, width - 20, y);
    if (invoiceData.sigDni) doc.text(invoiceData.sigDni, 37, y - 1);
  }

  // Footer - "Sin valor fiscal" for facturas
  if (!isCotizacion && !isRemito) {
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.setFont(undefined, 'italic');
    doc.text('Sin valor fiscal', width / 2, height - 10, { align: 'center' });
  }

  return doc;
}

export function downloadInvoicePDF(doc, number, type = 'factura') {
  const prefix = type === 'remito' ? 'Remito' : (type === 'cotizacion' ? 'Cotizacion' : 'Factura');
  doc.save(`${prefix}_${number}.pdf`);
}

/**
 * Remito automatico de ENTREGA (al crear un alquiler) o RETIRO (al eliminarlo).
 * data: { tipo:'entrega'|'retiro', paciente, direccion, telefono, dni,
 *         equipos:[{name, serialNumber}], fecha, numero }
 * Devuelve el doc de jsPDF (para descargar con downloadInvoicePDF).
 */
export async function generateRemitoEquipoPDF(data, settings = {}) {
  const { jsPDF } = await import('jspdf');
  const { firmaGerente, firmaRatio } = await import('./firmaGerente.js');
  const logoBase64 = await toBase64Image(window.location.origin + '/logo.jpg');

  const doc = new jsPDF('p', 'mm', 'a4');
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const esRetiro = data.tipo === 'retiro';

  // ── Cabecera ────────────────────────────────────────────────────────────
  doc.setFillColor(30, 90, 168);
  doc.rect(0, 0, width, 48, 'F');
  if (logoBase64) { try { doc.addImage(logoBase64, 'JPEG', 6, 4, 38, 38); } catch { /* sin logo */ } }
  const cx = logoBase64 ? width / 2 + 15 : width / 2;
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont(undefined, 'bold');
  doc.text(settings.companyName || 'INSER SALUD', cx, 18, { align: 'center' });
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  let hy = 25;
  if (settings.companyPhone) { doc.text(`Tel: ${settings.companyPhone}`, cx, hy, { align: 'center' }); hy += 5; }
  if (settings.companyAddress) { doc.text(settings.companyAddress, cx, hy, { align: 'center' }); hy += 5; }
  if (settings.companyEmail) { doc.text(settings.companyEmail, cx, hy, { align: 'center' }); hy += 5; }
  doc.setFont(undefined, 'bold');
  doc.text(settings.companyWebsite || 'inser.ar', cx, hy, { align: 'center' });
  doc.setFont(undefined, 'normal');

  // ── Titulo ──────────────────────────────────────────────────────────────
  let y = 58;
  doc.setTextColor(30, 90, 168);
  doc.setFontSize(17);
  doc.setFont(undefined, 'bold');
  doc.text(esRetiro ? 'REMITO DE RETIRO' : 'REMITO DE ENTREGA', width / 2, y, { align: 'center' });
  y += 10;

  doc.setTextColor(60, 60, 60);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`Fecha: ${formatDate(data.fecha || getToday())}`, 20, y);
  if (data.numero) doc.text(`N°: ${data.numero}`, width - 20, y, { align: 'right' });
  y += 8;
  doc.setDrawColor(30, 90, 168);
  doc.setLineWidth(0.5);
  doc.line(20, y, width - 20, y);
  y += 10;

  // ── Paciente ────────────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('PACIENTE', 20, y);
  y += 7;
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.text(String(data.paciente || '-'), 20, y);
  if (data.telefono) doc.text(`Tel: ${data.telefono}`, width - 20, y, { align: 'right' });
  y += 6;
  if (data.direccion) { doc.text(`Dir: ${data.direccion}`, 20, y); y += 6; }
  if (data.dni) { doc.text(`DNI: ${data.dni}`, 20, y); y += 6; }
  y += 6;

  // ── Equipos ─────────────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(30, 90, 168);
  doc.text(esRetiro ? 'EQUIPO/S RETIRADO/S' : 'EQUIPO/S ENTREGADO/S', 20, y);
  y += 8;
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.setTextColor(60, 60, 60);
  (data.equipos || []).forEach((eq, i) => {
    if (y > height - 90) { doc.addPage(); y = 20; }
    const serie = eq.serialNumber ? `  (N° de serie: ${eq.serialNumber})` : '';
    // Periodo del alquiler, cuando viene: queda escrito en el remito.
    const periodo = eq.periodo === 'quincenal' ? '  — Alquiler por 15 dias' : (eq.periodo === 'mensual' ? '  — Alquiler mensual' : '');
    const lines = doc.splitTextToSize(`${i + 1}. ${eq.name || 'Equipo'}${serie}${periodo}`, width - 45);
    doc.text(lines, 24, y);
    y += lines.length * 5 + 2;
  });
  y += 6;

  // ── Leyenda ─────────────────────────────────────────────────────────────
  if (y > height - 85) { doc.addPage(); y = 20; }
  doc.setDrawColor(30, 90, 168);
  doc.setLineWidth(0.4);
  doc.line(20, y, width - 20, y);
  y += 8;
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.setTextColor(60, 60, 60);
  const leyenda = esRetiro
    ? 'Se deja constancia de que en la fecha indicada SE RETIRO el/los equipo/s detallado/s del domicilio del paciente, finalizando el alquiler correspondiente.'
    : 'Se deja constancia de que en la fecha indicada SE ENTREGO el/los equipo/s detallado/s, EN PERFECTO ESTADO DE FUNCIONAMIENTO, con las indicaciones de uso correspondientes.';
  doc.text(doc.splitTextToSize(leyenda, width - 40), 20, y);
  y += 16;

  // ── Firmas ──────────────────────────────────────────────────────────────
  if (y > height - 75) { doc.addPage(); y = 20; }
  y += 14;
  // Firma del paciente (izquierda)
  doc.setFontSize(9);
  doc.line(22, y + 18, 92, y + 18);
  doc.text('Firma del paciente / familiar', 22, y + 23);
  doc.text('Aclaracion: ____________________', 22, y + 30);
  doc.text('DNI: ____________________', 22, y + 36);

  // Firma de la gerente (derecha): la imagen va ARRIBA del nombre, apoyada sobre la linea.
  const fx = width - 92;                       // inicio del bloque de firma
  const fw = 58;                               // ancho de la firma en mm
  const fh = fw / (firmaRatio || 2.5);         // alto proporcional (sin deformar)
  const lineY = y + 18;                        // linea sobre la que "apoya" la firma
  try { doc.addImage(firmaGerente, 'JPEG', fx, lineY - fh - 1, fw, fh); } catch { /* sin firma */ }
  doc.line(fx, lineY, fx + 70, lineY);
  doc.setFont(undefined, 'bold');
  doc.text('MARCELA CORDERO', fx, lineY + 5);
  doc.setFont(undefined, 'normal');
  doc.text('Gerente', fx, lineY + 11);

  return doc;
}

export function sendInvoiceByEmail(email, invoiceNumber, clientName, total) {
  if (!email) {
    alert('Ingrese un correo electronico');
    return;
  }

  const subject = encodeURIComponent(`Factura ${invoiceNumber}`);
  const body = encodeURIComponent(`Estimado/a ${clientName},\n\nAdjunto encontrara su factura N° ${invoiceNumber} por un total de ${total}.\n\nSaludos cordiales.`);

  window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
}
