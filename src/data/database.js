import { seedEquiposNuevos } from './seedEquiposNuevos';

const STORAGE_KEY = 'insersalud_db';
const STORAGE_TS_KEY = 'insersalud_db_ts';
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

function hasDataEntries(data) {
  return ['patients', 'equipment', 'rentals', 'quotations', 'remitos', 'descartables', 'mascaras', 'invoices', 'equiposNuevos']
    .some(key => Array.isArray(data[key]) && data[key].length > 0);
}

/**
 * Merge two collections. REMOTE WINS for items that exist in both (keyed by id).
 * Items only in local (new, not yet synced) are added.
 * Items only in remote (created by another browser) are kept.
 */
function mergeCollection(localItems = [], remoteItems = []) {
  const remoteById = new Map();
  for (const item of remoteItems) {
    if (item && item.id) remoteById.set(String(item.id), item);
  }

  const localById = new Map();
  for (const item of localItems) {
    if (item && item.id) localById.set(String(item.id), item);
  }

  const merged = [];
  const seen = new Set();

  // Start with ALL remote items (remote is truth for shared items)
  for (const item of remoteItems) {
    if (!item || !item.id) continue;
    const key = String(item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  // Add local-only items (new items not yet in remote)
  for (const item of localItems) {
    if (!item || !item.id) continue;
    const key = String(item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

/**
 * Merge local and remote data. Remote wins for existing records.
 * Local-only records (new, unsynced) are preserved.
 * remoteIsNewer: if true, remote timestamp is more recent, so remote is full authority.
 */
function mergeDataSources(localData, remoteData, remoteIsNewer = false) {
  if (remoteIsNewer) {
    // Remote was saved more recently by another browser. Use remote as base,
    // but add any local-only items that haven't been synced yet.
    const collections = ['patients', 'equipment', 'rentals', 'quotations', 'remitos',
      'descartables', 'mascaras', 'invoices', 'equiposNuevos'];
    const result = { ...remoteData };
    for (const col of collections) {
      result[col] = mergeCollection(localData[col], remoteData[col]);
    }
    result.settings = { ...remoteData.settings };
    return normalizeData(result);
  }

  // Local is newer or same timestamp -- local wins for shared items,
  // but still bring in remote-only items.
  const collections = ['patients', 'equipment', 'rentals', 'quotations', 'remitos',
    'descartables', 'mascaras', 'invoices', 'equiposNuevos'];
  const result = { ...localData };
  for (const col of collections) {
    // Swap order: local items first, then remote-only
    const remoteById = new Map();
    for (const item of (remoteData[col] || [])) {
      if (item && item.id) remoteById.set(String(item.id), item);
    }
    const seen = new Set();
    const merged = [];
    for (const item of (localData[col] || [])) {
      if (!item || !item.id) continue;
      const key = String(item.id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    for (const item of (remoteData[col] || [])) {
      if (!item || !item.id) continue;
      const key = String(item.id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    result[col] = merged;
  }
  result.settings = { ...localData.settings };
  return normalizeData(result);
}

async function loadRemoteData() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/inser_app_data?id=eq.1&select=data,updated_at`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  if (!response.ok) throw new Error(`Supabase GET ${response.status}`);
  const rows = await response.json();
  if (!rows || rows.length === 0) return { data: normalizeData({}), updatedAt: null };
  return {
    data: normalizeData(rows[0].data || {}),
    updatedAt: rows[0].updated_at || null
  };
}

async function saveRemoteData(data) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/inser_app_data?id=eq.1`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase PATCH ${response.status}: ${text}`);
  }
}

export async function loadData() {
  const localData = loadLocalData();

  try {
    setSyncStatus('loading');
    const remote = await loadRemoteData();
    const remoteData = remote.data;
    const remoteTs = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const localTs = Number(localStorage.getItem(STORAGE_TS_KEY) || '0');

    // Determine which source is newer
    const remoteIsNewer = remoteTs > localTs;
    const mergedData = mergeDataSources(localData, remoteData, remoteIsNewer);

    // Save merged result locally with the latest timestamp
    const nowTs = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedData));
    localStorage.setItem(STORAGE_TS_KEY, String(Math.max(remoteTs, localTs, nowTs)));

    // Write back to remote so both sides converge
    if (JSON.stringify(mergedData) !== JSON.stringify(remoteData)) {
      saveRemoteData(mergedData).then(() => setSyncStatus('ok')).catch(() => setSyncStatus('error', 'Sync write failed'));
    } else {
      setSyncStatus('ok');
    }

    return mergedData;
  } catch (e) {
    console.error('Sync error on load:', e);
    setSyncStatus('error', e.message);
    return localData;
  }
}

export async function saveData(data) {
  const normalized = normalizeData(data);
  const nowTs = String(Date.now());

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    localStorage.setItem(STORAGE_TS_KEY, nowTs);
  } catch (e) {
    try {
      const slim = {
        ...normalized,
        equipment: normalized.equipment.map(eq => ({ ...eq, imageUrl: eq.imageUrl?.startsWith('data:') ? '' : (eq.imageUrl || '') }))
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
      localStorage.setItem(STORAGE_TS_KEY, nowTs);
    } catch (e2) {
      console.error('Error saving local data:', e2);
    }
  }

  try {
    setSyncStatus('saving');
    await saveRemoteData(normalized);
    setSyncStatus('ok');
  } catch (e) {
    console.error('Sync error on save:', e);
    setSyncStatus('error', e.message);
  }
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

export function getToday() {
  return new Date().toISOString().split('T')[0];
}

export function formatDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleDateString('es-AR');
}

export function getDaysUntilEnd(endDate) {
  if (!endDate) return 0;
  const end = new Date(endDate);
  const today = new Date();
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
  const hasPatientData = firstRow['NOMBRE'] || firstRow['paciente'] || firstRow['NOMBRE Y APELLIDO'];
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
