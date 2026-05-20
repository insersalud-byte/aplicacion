import { seedEquiposNuevos } from './seedEquiposNuevos';

const STORAGE_KEY = 'insersalud_db';
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export const initialData = {
  patients: [],
  equipment: [],
  rentals: [],
  quotations: [],
  descartables: [],
  mascaras: [],
  invoices: [],
  equiposNuevos: seedEquiposNuevos,
  settings: {
    companyName: 'Inser Salud',
    companyPhone: '+54 11 1234-5678',
    companyAddress: 'Buenos Aires, Argentina',
    companyEmail: 'info@insersalud.com',
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
  return ['patients', 'equipment', 'rentals', 'quotations', 'descartables', 'mascaras', 'invoices', 'equiposNuevos']
    .some(key => Array.isArray(data[key]) && data[key].length > 0);
}

function mergeCollection(localItems = [], remoteItems = [], identityKeys = []) {
  const merged = [];
  const seen = new Set();

  const buildKey = (item) => {
    if (!item) return null;
    if (item.id) return `id:${item.id}`;

    const identity = identityKeys
      .map(key => `${key}:${String(item[key] ?? '').trim().toLowerCase()}`)
      .join('|');

    return identity ? `identity:${identity}` : null;
  };

  for (const item of [...localItems, ...remoteItems]) {
    const key = buildKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

function mergeDataSources(localData, remoteData) {
  return normalizeData({
    patients: mergeCollection(localData.patients, remoteData.patients, ['name', 'phone', 'dni']),
    equipment: mergeCollection(localData.equipment, remoteData.equipment, ['serialNumber', 'name']),
    rentals: mergeCollection(localData.rentals, remoteData.rentals, ['patientId', 'equipmentId', 'startDate', 'endDate']),
    quotations: mergeCollection(localData.quotations, remoteData.quotations, ['customerName', 'customerPhone', 'equipmentId', 'createdAt']),
    descartables: mergeCollection(localData.descartables, remoteData.descartables, ['name', 'category', 'supplier']),
    mascaras: mergeCollection(localData.mascaras, remoteData.mascaras, ['name', 'type']),
    invoices: mergeCollection(localData.invoices, remoteData.invoices, ['invoiceNumber', 'date']),
    equiposNuevos: mergeCollection(localData.equiposNuevos, remoteData.equiposNuevos, ['name', 'price']),
    settings: {
      ...remoteData.settings,
      ...localData.settings
    }
  });
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    throw new Error(`API ${response.status}`);
  }

  return response.status === 204 ? null : response.json();
}

export async function loadData() {
  const localData = loadLocalData();

  try {
    const remoteData = normalizeData(await requestJson('/db'));
    const mergedData = mergeDataSources(localData, remoteData);

    if (!hasDataEntries(remoteData) && hasDataEntries(localData)) {
      await requestJson('/db', {
        method: 'PUT',
        body: JSON.stringify(localData)
      });
      return localData;
    }

    if (JSON.stringify(mergedData) !== JSON.stringify(remoteData)) {
      await requestJson('/db', {
        method: 'PUT',
        body: JSON.stringify(mergedData)
      });
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedData));
    return mergedData;
  } catch (e) {
    console.error('Error loading remote data, using local storage:', e);
    return localData;
  }
}

export async function saveData(data) {
  const normalized = normalizeData(data);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (e) {
    console.error('Error saving data:', e);
  }

  try {
    await requestJson('/db', {
      method: 'PUT',
      body: JSON.stringify(normalized)
    });
  } catch (e) {
    console.error('Error saving remote data:', e);
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

export async function generateInvoicePDF(invoiceData, settings, type = 'factura') {
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF('p', 'mm', 'a4');
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const isCotizacion = type === 'cotizacion';
  const title = isCotizacion ? 'COTIZACION' : 'FACTURA';

  let y = 15;

  // Logo / Company name
  doc.setFillColor(30, 90, 168);
  doc.rect(0, 0, width, 45, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(26);
  doc.setFont(undefined, 'bold');
  doc.text(settings.companyName || 'INSER SALUD', width / 2, y + 5, { align: 'center' });
  y += 12;
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  if (settings.companyPhone) doc.text(`Tel: ${settings.companyPhone}`, width / 2, y + 5, { align: 'center' });
  y += 5;
  if (settings.companyAddress) doc.text(settings.companyAddress, width / 2, y + 5, { align: 'center' });
  y += 5;
  if (settings.companyEmail) doc.text(settings.companyEmail, width / 2, y + 5, { align: 'center' });

  // Title bar
  y = 52;
  doc.setTextColor(30, 90, 168);
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text(title, width / 2, y, { align: 'center' });
  y += 10;

  // Doc info
  doc.setTextColor(60, 60, 60);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`Fecha: ${formatDate(invoiceData.date)}`, 20, y);
  if (invoiceData.invoiceNumber) doc.text(`N°: ${invoiceData.invoiceNumber}`, width - 20, y, { align: 'right' });
  y += 10;

  // Separator
  doc.setDrawColor(30, 90, 168);
  doc.setLineWidth(0.5);
  doc.line(20, y, width - 20, y);
  y += 8;

  // Client
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

  // Table header
  doc.setFillColor(240, 245, 250);
  doc.rect(20, y - 4, width - 40, 8, 'F');
  doc.setFontSize(9);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(30, 90, 168);
  doc.text('Descripcion', 22, y);
  doc.text('Cant.', 120, y, { align: 'center' });
  doc.text('P. Unit.', 150, y, { align: 'center' });
  doc.text('Subtotal', width - 22, y, { align: 'right' });
  y += 8;

  // Table rows
  doc.setFont(undefined, 'normal');
  doc.setTextColor(60, 60, 60);
  invoiceData.items.forEach((item, i) => {
    const subtotal = item.price * (item.quantity || 1);
    if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(20, y - 4, width - 40, 7, 'F');
    }
    doc.text(String(item.name || '').substring(0, 55), 22, y);
    doc.text(String(item.quantity || 1), 120, y, { align: 'center' });
    doc.text(formatCurrency(item.price), 150, y, { align: 'center' });
    doc.text(formatCurrency(subtotal), width - 22, y, { align: 'right' });
    y += 7;
  });

  y += 3;
  doc.setDrawColor(30, 90, 168);
  doc.line(20, y, width - 20, y);
  y += 8;

  // Total
  doc.setFont(undefined, 'bold');
  doc.setFontSize(13);
  doc.setTextColor(30, 90, 168);
  doc.text(`TOTAL: ${formatCurrency(invoiceData.total)}`, width - 22, y, { align: 'right' });

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

  // Footer - "Sin valor fiscal" for facturas
  if (!isCotizacion) {
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.setFont(undefined, 'italic');
    doc.text('Sin valor fiscal', width / 2, height - 10, { align: 'center' });
  }

  return doc;
}

export function downloadInvoicePDF(doc, number, type = 'factura') {
  const prefix = type === 'cotizacion' ? 'Cotizacion' : 'Factura';
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
