import { seedEquiposNuevos } from './seedEquiposNuevos';

const STORAGE_KEY = 'insersalud_db';
const STORAGE_TS_KEY = 'insersalud_db_ts';
const DIRTY_KEY = 'insersalud_dirty';   // hay cambios locales que todavia no llegaron a la base
const BASE_KEY = 'insersalud_base';     // ultimo estado sincronizado (base del merge si se cierra offline)
const SUPABASE_URL = 'https://gvharyztavhugqiaihjq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wTO5X4JfeoHP0zg7qq4azQ_OJ3jxfwL';

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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/inser_app_data?id=eq.1&select=data,updated_at`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  if (!response.ok) throw new Error(`Supabase GET ${response.status}`);
  const rows = await response.json();
  if (!rows || rows.length === 0) return { exists: false, data: normalizeData({}), updatedAt: null };
  return {
    exists: true,
    data: normalizeData(rows[0].data || {}),
    updatedAt: rows[0].updated_at || null
  };
}

async function saveRemoteData(data) {
  const ts = new Date().toISOString();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/inser_app_data?id=eq.1`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ data, updated_at: ts }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase PATCH ${response.status}: ${text}`);
  }
  return ts;
}

// GET liviano: solo el timestamp. Sirve para detectar cambios sin bajar todo el blob.
async function fetchRemoteTs() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/inser_app_data?id=eq.1&select=updated_at`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  if (!response.ok) throw new Error(`Supabase TS ${response.status}`);
  const rows = await response.json();
  return rows && rows[0] ? rows[0].updated_at : null;
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
// El estado es un unico blob, pero al guardar NO se pisa entero: se fusiona
// base (ultimo estado sincronizado) + mine (mi estado local) + remote (lo que
// hay ahora en la base). Asi dos dispositivos editando registros distintos al
// mismo tiempo conservan AMBOS cambios, y un borrado real no reaparece.
// ============================================================================

const COLLECTIONS = ['patients', 'equipment', 'rentals', 'quotations', 'remitos', 'descartables', 'mascaras', 'invoices', 'equiposNuevos'];

let _baseState = null;                 // ultimo estado confirmado en la base (base del merge)
let _pendingLocal = null;              // cambios locales aun no confirmados (para reintentar)
let _writeChain = Promise.resolve();   // serializa escrituras: nunca se pisan ni reordenan
let _lastRemoteTs = null;              // updated_at que ya aplicamos (para detectar cambios ajenos)

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

// Merge 3-vias de una coleccion por id.
function mergeCollection(base, mine, remote) {
  const baseM = indexById(base);
  const mineM = indexById(mine);
  const result = indexById(remote); // partir de la base remota (incluye cambios de otros dispositivos)

  // 1. Borrados que hice yo: estaban en base y ya no estan en mine -> borrar de verdad.
  for (const id of baseM.keys()) {
    if (!mineM.has(id)) result.delete(id);
  }
  // 2. Altas/ediciones mias: gana mi version SOLO en los registros que toque.
  for (const [id, rec] of mineM) {
    const baseRec = baseM.get(id);
    const changedByMe = !baseRec || JSON.stringify(baseRec) !== JSON.stringify(rec);
    if (changedByMe) {
      result.set(id, rec);        // yo lo cree o edite -> mi version manda
    } else if (!result.has(id)) {
      result.set(id, rec);        // no lo toque pero falta en remoto -> conservarlo
    }
    // no lo toque y existe en remoto -> queda la version remota (toma ediciones ajenas)
  }
  return Array.from(result.values());
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

function mergeStates(base, mine, remote) {
  const out = { ...remote };
  for (const c of COLLECTIONS) {
    out[c] = mergeCollection(base?.[c], mine?.[c], remote?.[c]);
  }
  out.settings = mergeSettings(base?.settings, mine?.settings, remote?.settings);
  return normalizeData(out);
}

// Si quedaron cambios locales sin subir (la app se cerro sin internet), los
// fusiona contra lo que hay ahora en la base y los sube. Devuelve el estado
// final, o null si no habia nada pendiente.
async function flushDirtyLocal(remoteData) {
  let dirty = false;
  try { dirty = localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { /* noop */ }
  if (!dirty) return null;

  const mine = loadLocalData(); // estado local con los cambios sin subir
  let base = remoteData;         // fallback conservador si no tenemos base guardada
  try {
    const baseRaw = localStorage.getItem(BASE_KEY);
    if (baseRaw) base = normalizeData(JSON.parse(baseRaw));
  } catch (e) { /* noop */ }

  const merged = mergeStates(base, mine, remoteData);
  _lastRemoteTs = await saveRemoteData(merged); // si falla, lanza y se mantiene dirty
  _baseState = merged;
  try { localStorage.removeItem(DIRTY_KEY); localStorage.removeItem(BASE_KEY); } catch (e) { /* noop */ }
  cacheLocal(merged);
  setSyncStatus('ok');
  return merged;
}

export async function loadData() {
  try {
    setSyncStatus('loading');
    const remote = await loadRemoteData();

    if (remote.exists) {
      let data = remote.data;

      // Sembrar equiposNuevos solo si la base no tiene ninguno cargado.
      if (!data.equiposNuevos || data.equiposNuevos.length === 0) {
        data = { ...data, equiposNuevos: seedEquiposNuevos };
      }

      // Antes de confiar en lo remoto, subir cambios locales pendientes.
      const recovered = await flushDirtyLocal(data);
      if (recovered) return recovered;

      _baseState = data;
      _lastRemoteTs = remote.updatedAt;
      cacheLocal(data);
      setSyncStatus('ok');
      return data;
    }

    // La base esta vacia (primera vez): subir lo que haya en local como base inicial.
    const localData = loadLocalData();
    _lastRemoteTs = await saveRemoteData(localData);
    _baseState = localData;
    cacheLocal(localData);
    setSyncStatus('ok');
    return localData;
  } catch (e) {
    // Sin conexion a Supabase: usar cache local para no quedar sin datos.
    console.error('Sync error on load (usando cache local):', e);
    setSyncStatus('error', e.message);
    const local = loadLocalData();
    if (!_baseState) _baseState = local;
    return local;
  }
}

export async function saveData(nextState) {
  const mine = normalizeData(nextState);
  _pendingLocal = mine;
  // Marcar "sucio" y, la primera vez del ciclo, guardar el estado base (ultimo
  // sincronizado) ANTES de pisar el cache. Asi, si la app se cierra sin internet,
  // el proximo arranque sabe fusionar y subir el cambio: nunca queda solo en local.
  try {
    if (localStorage.getItem(DIRTY_KEY) !== '1') {
      const lastSynced = localStorage.getItem(STORAGE_KEY);
      if (lastSynced) localStorage.setItem(BASE_KEY, lastSynced);
      localStorage.setItem(DIRTY_KEY, '1');
    }
  } catch (e) { /* sin espacio: igual se reintenta online */ }
  cacheLocal(mine);                    // nunca perder el cambio localmente
  // Encadenar para serializar escrituras (evita reordenamiento de PATCH).
  _writeChain = _writeChain.then(() => _commit(mine));
  return _writeChain;
}

async function _commit(mine) {
  try {
    setSyncStatus('saving');
    // Leer lo ultimo de la base y fusionar antes de escribir (anti-clobber).
    const remote = await loadRemoteData();
    const base = _baseState || remote.data;
    const merged = mergeStates(base, mine, remote.data);

    _lastRemoteTs = await saveRemoteData(merged);
    _baseState = merged;
    if (_pendingLocal === mine) {
      _pendingLocal = null;
      // Confirmado en la base: ya no hay cambios pendientes.
      try { localStorage.removeItem(DIRTY_KEY); localStorage.removeItem(BASE_KEY); } catch (e) { /* noop */ }
    }
    cacheLocal(merged);
    setSyncStatus('ok');

    // Si el merge trajo cambios de otros dispositivos, refrescar la UI.
    if (JSON.stringify(merged) !== JSON.stringify(mine)) {
      emitData(merged);
    }
  } catch (e) {
    // Falla de red/base: queda _pendingLocal para reintentar en el proximo refresh.
    console.error('Sync error on save:', e);
    setSyncStatus('error', e.message);
  }
}

// Re-sincronizar desde la base (focus / intervalo / reconexion).
// Primero empuja cambios pendientes para no perderlos, luego trae lo remoto.
export async function refreshFromRemote() {
  try {
    if (_pendingLocal) {
      await saveData(_pendingLocal); // saveData ya hace merge + emitData
      return;
    }
    const remote = await loadRemoteData();
    if (!remote.exists) return;
    _baseState = remote.data;
    _lastRemoteTs = remote.updatedAt;
    cacheLocal(remote.data);
    setSyncStatus('ok');
    emitData(remote.data);
  } catch (e) {
    setSyncStatus('error', e.message);
  }
}

// Heartbeat barato: cada pocos segundos chequea SOLO el timestamp.
// Si la base cambio (otro dispositivo guardo), baja el estado completo.
// Asi lo que se carga en cualquier dispositivo se refleja en los demas en segundos.
export async function syncIfRemoteChanged() {
  try {
    // Si tengo cambios locales sin confirmar, primero los empujo (no perderlos).
    if (_pendingLocal) {
      await saveData(_pendingLocal);
      return;
    }
    const ts = await fetchRemoteTs();
    if (ts && ts !== _lastRemoteTs) {
      await refreshFromRemote();
    } else if (_syncStatus.state === 'error') {
      setSyncStatus('ok');
    }
  } catch (e) {
    setSyncStatus('error', e.message);
  }
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Numero de documento (COT-/REM-/FAC-) basado en timestamp.
export function generateDocNumber(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

// Fecha local YYYY-MM-DD. NUNCA usar toISOString() para fechas de negocio:
// devuelve UTC, y en Argentina (UTC-3) desde las 21:00 ya es "manana" en UTC,
// lo que marcaba vencimientos un dia antes.
export function toLocalDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getToday() {
  return toLocalDateStr(new Date());
}

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

export function parseExcelData(data, existingPatients = [], existingEquipment = []) {
  if (!data || data.length === 0) return { patients: [], equipment: [], rentals: [] };
  
  const firstRow = data[0];
  const hasRentalData = firstRow['FECHA ALTA'] || firstRow['INICIO'];
  
  const patients = [];
  const equipment = [];
  const rentals = [];
  
  data.forEach((row, index) => {
    if (!row) return;
    
    const name = row['NOMBRE'] || row['NOMBRE Y APELLIDO'] || row['paciente'] || row['NOMBRECliente'] || '';
    if (name && typeof name === 'string' && name.length > 2) {
      const dni = String(row['DNI'] || row['dni'] || '').replace(/\.+$/, '');
      const phone = String(row['TELEFONO'] || row['telefono'] || row['CELULAR'] || row['telefonoCliente'] || '');
      const address = row['DIRECCION'] || row['direccion'] || row['DOMICILIO'] || row['direccionCliente'] || '';
      
      if (!existingPatients.find(p => p.name === name && p.phone === phone)) {
        patients.push({
          id: generateId(),
          name: name.trim(),
          dni: dni,
          phone: phone,
          address: address,
          observations: row['OBSERVACIONES'] || row['observaciones'] || '',
          documents: [],
          createdAt: getToday()
        });
      }
    }
    
    const equipName = row['EQUIPO'] || row['equipo'] || '';
    if (equipName && typeof equipName === 'string' && equipName.length > 2) {
      if (!existingEquipment.find(e => e.name === equipName)) {
        equipment.push({
          id: generateId(),
          serialNumber: row['SERIE'] || row['serie'] || 'EQ-' + (index + 1),
          name: equipName.trim(),
          type: 'otro',
          status: 'disponible',
          images: [],
          description: row['DESCRIPCION'] || row['descripcion'] || '',
          available: true
        });
      }
    }
  });
  
  if (hasRentalData) {
    data.forEach((row) => {
      if (!row) return;
      
      const name = row['NOMBRE'] || row['NOMBRE Y APELLIDO'] || row['paciente'] || '';
      const patient = patients.find(p => p.name === name) || existingPatients.find(p => p.name && name && p.name.toLowerCase().includes(name.toLowerCase().split(' ')[0]));
      
      const equipName = row['EQUIPO'] || row['equipo'] || '';
      const equip = equipment.find(e => e.name === equipName) || existingEquipment.find(e => e.name && equipName && e.name.toLowerCase().includes(equipName.toLowerCase().split(' ')[0]));
      
      if (patient || equip) {
        const startDate = row['FECHA ALTA'] || row['INICIO'] || row['fecha'] || getToday();
        const endDate = row['VENCIMIENTO'] || row['FIN'] || row['fechaFin'] || '';
        const price = Number(row['importe'] || row['IMPORTE'] || row['PRECIO'] || row['precio'] || 0);
        
        if (price > 0 || endDate) {
          rentals.push({
            id: generateId(),
            patientId: patient?.id || '',
            equipmentId: equip?.id || '',
            startDate: startDate,
            endDate: endDate || '',
            price: price,
            status: endDate && new Date(endDate) < new Date() ? 'vencido' : 'activo',
            notes: row['OBSERVACIONES'] || row['observaciones'] || '',
            createdAt: getToday()
          });
        }
      }
    });
  }
  
  return { patients, equipment, rentals };
}

export function sendWhatsApp(phone, message) {
  const cleaned = phone.replace(/\D/g, '');
  const formattedPhone = cleaned.startsWith('54') ? cleaned : '54' + cleaned;
  const encodedMessage = encodeURIComponent(message);
  window.open(`https://wa.me/${formattedPhone}?text=${encodedMessage}`, '_blank');
}

async function toBase64Image(url) {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
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
    img.src = url;
  });
}

export async function generateInvoicePDF(invoiceData, settings, type = 'factura') {
  const { jsPDF } = await import('jspdf');

  const [logoBase64, ...itemImages] = await Promise.all([
    toBase64Image(window.location.origin + '/logo.jpg'),
    ...invoiceData.items.map(item => toBase64Image(item.imageUrl || ''))
  ]);
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
  if (settings.companyEmail) { doc.text(settings.companyEmail, cx, hy, { align: 'center' }); }

  // ── Title ────────────────────────────────────────────────────────────────
  let y = 56;
  doc.setTextColor(30, 90, 168);
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text(title, width / 2, y, { align: 'center' });
  y += 10;

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
      const rh = imgData ? 20 : 9;
      if (i % 2 === 0) {
        doc.setFillColor(248, 250, 252);
        doc.rect(20, y - 5, width - 40, rh, 'F');
      }
      if (imgData) {
        try { doc.addImage(imgData, 'JPEG', 22, y - 4, 17, 17); } catch {}
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(60, 60, 60);
        const lines = doc.splitTextToSize(String(item.name || ''), 140);
        doc.text(lines, 43, y + 2);
      } else {
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(60, 60, 60);
        doc.text(String(item.name || ''), 22, y);
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
    invoiceData.items.forEach((item, i) => {
      const subtotal = item.price * (item.quantity || 1);
      if (i % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(20, y - 4, width - 40, rowH, 'F');
      }
      const imgData = itemImages[i];
      if (imgData) { try { doc.addImage(imgData, 'JPEG', 22, y - 3, 16, 16); } catch {} }
      const nameLines = doc.splitTextToSize(String(item.name || ''), descW);
      doc.text(nameLines, textX, y + (hasAnyImage ? 3 : 0));
      const rowMid = hasAnyImage ? y + 5 : y;
      doc.text(String(item.quantity || 1), 120, rowMid, { align: 'center' });
      doc.text(formatCurrency(item.price), 150, rowMid, { align: 'center' });
      doc.text(formatCurrency(subtotal), width - 22, rowMid, { align: 'right' });
      y += rowH;
    });
    y += 3;
    doc.setDrawColor(30, 90, 168);
    doc.line(20, y, width - 20, y);
    y += 8;
    doc.setFont(undefined, 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30, 90, 168);
    doc.text(`TOTAL: ${formatCurrency(invoiceData.total)}`, width - 22, y, { align: 'right' });
  }

  if (invoiceData.notes) {
    y += 12;
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 100, 100);
    doc.text('Observaciones:', 20, y);
    y += 5;
    const splitNotes = doc.splitTextToSize(invoiceData.notes, 170);
    doc.text(splitNotes, 20, y);
  }

  // Signature block for remito
  if (isRemito) {
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

export function sendInvoiceByEmail(email, invoiceNumber, clientName, total) {
  if (!email) {
    alert('Ingrese un correo electronico');
    return;
  }

  const subject = encodeURIComponent(`Factura ${invoiceNumber}`);
  const body = encodeURIComponent(`Estimado/a ${clientName},\n\nAdjunto encontrara su factura N° ${invoiceNumber} por un total de ${total}.\n\nSaludos cordiales.`);

  window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
}
