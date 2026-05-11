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
    invoices: Array.isArray(data.invoices) ? data.invoices : []
  };
}

function loadLocalData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return normalizeData(JSON.parse(saved));
    }
  } catch (e) {
    console.error('Error loading data:', e);
  }
  return normalizeData(initialData);
}

function hasDataEntries(data) {
  return ['patients', 'equipment', 'rentals', 'quotations', 'descartables', 'mascaras', 'invoices']
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

export async function generateInvoicePDF(invoiceData, settings) {
  const { jsPDF } = await import('jspdf');
  const html2canvas = (await import('html2canvas')).default;

  const doc = new jsPDF('p', 'mm', 'a4');
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  
  let y = 20;
  
  // Encabezado
  doc.setFontSize(20);
  doc.text(settings.companyName || 'FACTURA', width / 2, y, { align: 'center' });
  y += 15;
  
  doc.setFontSize(10);
  doc.text(`Fecha: ${formatDate(invoiceData.date)}`, 20, y);
  doc.text(`N°: ${invoiceData.invoiceNumber}`, width - 40, y);
  y += 10;
  
  if (settings.companyPhone) {
    doc.text(`Tel: ${settings.companyPhone}`, 20, y);
  }
  if (settings.companyAddress) {
    doc.text(`${settings.companyAddress}`, 20, y + 5);
  }
  y += 15;
  
  // Cliente
  doc.setFontSize(11);
  doc.text('CLIENTE:', 20, y);
  y += 7;
  doc.setFontSize(10);
  doc.text(invoiceData.clientName, 20, y);
  if (invoiceData.clientPhone) {
    doc.text(`Tel: ${invoiceData.clientPhone}`, 20, y + 5);
  }
  if (invoiceData.clientAddress) {
    doc.text(`Dir: ${invoiceData.clientAddress}`, 20, y + 10);
  }
  y += 20;
  
  // Tabla de ítems
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.text('Descripción', 20, y);
  doc.text('Cant.', 120, y, { align: 'center' });
  doc.text('Precio Unit.', 150, y, { align: 'center' });
  doc.text('Total', 190, y, { align: 'right' });
  y += 8;
  
  doc.setFont(undefined, 'normal');
  invoiceData.items.forEach(item => {
    const subtotal = item.price * item.quantity;
    doc.text(item.name.substring(0, 60), 20, y);
    doc.text(String(item.quantity), 120, y, { align: 'center' });
    doc.text(formatCurrency(item.price), 150, y, { align: 'center' });
    doc.text(formatCurrency(subtotal), 190, y, { align: 'right' });
    y += 6;
  });
  
  y += 5;
  doc.setDrawColor(220, 220, 220);
  doc.line(20, y, 200, y);
  y += 8;
  
  // Totales
  doc.setFont(undefined, 'bold');
  doc.setFontSize(11);
  doc.text(`TOTAL: ${formatCurrency(invoiceData.total)}`, width - 20, y, { align: 'right' });
  
  if (invoiceData.notes) {
    y += 15;
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.text('Observaciones:', 20, y);
    y += 5;
    const splitNotes = doc.splitTextToSize(invoiceData.notes, 170);
    doc.text(splitNotes, 20, y);
  }
  
  return doc;
}

export function downloadInvoicePDF(doc, invoiceNumber) {
  doc.save(`Factura_${invoiceNumber}.pdf`);
}

export function sendInvoiceByEmail(email, invoiceNumber, clientName, total) {
  if (!email) {
    alert('Ingrese un correo electrónico');
    return;
  }
  
  const subject = encodeURIComponent(`Factura ${invoiceNumber}`);
  const body = encodeURIComponent(`Estimado/a ${clientName},\n\nAdjunto encontrará su factura N° ${invoiceNumber} por un total de ${total}.\n\nSaludos cordiales.`);
  
  window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
}
