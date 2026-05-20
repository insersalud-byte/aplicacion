const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(process.cwd(), 'dist');
const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'database.json');
const PORT = Number(process.env.PORT) || 3000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const initialData = {
  patients: [],
  equipment: [],
  rentals: [],
  quotations: [],
  descartables: [],
  mascaras: [],
  invoices: [],
  equiposNuevos: [],
  settings: {
    companyName: 'Inser Salud',
    companyPhone: '+54 11 1234-5678',
    companyAddress: 'Buenos Aires, Argentina',
    companyEmail: 'info@insersalud.com',
    monthlyRentalPrice: 15000,
    dailyRentalPrice: 500,
    salePriceMultiplier: 3.5,
  },
};

const collectionNames = [
  'patients',
  'equipment',
  'rentals',
  'quotations',
  'descartables',
  'mascaras',
  'invoices',
  'equiposNuevos',
];

const settingsFields = [
  'companyName',
  'companyPhone',
  'companyAddress',
  'companyEmail',
  'monthlyRentalPrice',
  'dailyRentalPrice',
  'salePriceMultiplier',
];

const collectionFieldMap = {
  patients: ['id', 'name', 'dni', 'phone', 'address', 'observations', 'documents', 'createdAt'],
  equipment: ['id', 'serialNumber', 'name', 'type', 'status', 'images', 'description', 'available', 'imageUrl', 'ownership'],
  rentals: ['id', 'patientId', 'equipmentId', 'startDate', 'endDate', 'price', 'status', 'notes', 'createdAt', 'paymentStatusByMonth'],
  quotations: ['id', 'customerName', 'customerPhone', 'equipmentId', 'equipment', 'type', 'price', 'period', 'notes', 'createdAt'],
  descartables: ['id', 'name', 'category', 'unit', 'price', 'stock', 'minStock', 'supplier', 'description', 'updatedAt'],
  mascaras: ['id', 'name', 'type', 'stock', 'minStock', 'description', 'precio', 'createdAt'],
  invoices: ['id', 'invoiceNumber', 'date', 'patientId', 'clientName', 'clientPhone', 'clientAddress', 'items', 'total', 'notes', 'status', 'createdAt'],
  equiposNuevos: ['id', 'name', 'description', 'price', 'priceUsd', 'priceVentaUsd', 'imageUrl', 'stock', 'createdAt'],
};

function pickAllowedFields(source, allowedFields) {
  const sanitized = {};

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      sanitized[field] = source[field];
    }
  }

  return sanitized;
}

function sanitizeCollectionItem(resource, payload = {}, currentItem = null) {
  const allowedFields = collectionFieldMap[resource] || [];
  const base = currentItem ? pickAllowedFields(currentItem, allowedFields) : {};
  const sanitizedPayload = pickAllowedFields(payload, allowedFields);

  return {
    ...base,
    ...sanitizedPayload,
  };
}

function sanitizeSettings(payload = {}, currentSettings = initialData.settings) {
  return {
    ...pickAllowedFields(currentSettings, settingsFields),
    ...pickAllowedFields(payload, settingsFields),
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

function normalizeData(data = {}) {
  const normalizedSettings = sanitizeSettings(data.settings || {}, initialData.settings);
  const normalizedCollections = Object.fromEntries(
    collectionNames.map(name => [
      name,
      Array.isArray(data[name])
        ? data[name].map(item => sanitizeCollectionItem(name, item))
        : [],
    ])
  );

  return {
    ...initialData,
    settings: normalizedSettings,
    ...normalizedCollections,
  };
}

function readDatabase() {
  ensureDataFile();

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalizeData(JSON.parse(raw));
  } catch (error) {
    console.error('Error reading database:', error);
    return normalizeData(initialData);
  }
}

function writeDatabase(data) {
  ensureDataFile();
  const normalized = normalizeData(data);
  fs.writeFileSync(DATA_FILE, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(message);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function isInitialDatabase(data) {
  return collectionNames.every(name => Array.isArray(data[name]) && data[name].length === 0);
}

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    sendText(res, 204, '');
    return true;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/db') {
    if (req.method === 'GET') {
      sendJson(res, 200, readDatabase());
      return true;
    }

    if (req.method === 'PUT') {
      try {
        const body = await parseBody(req);
        const data = writeDatabase(normalizeData(body));
        sendJson(res, 200, data);
      } catch (error) {
        sendJson(res, 400, { error: 'JSON invalido' });
      }
      return true;
    }
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') {
    return false;
  }

  const resource = segments[1];
  const itemId = segments[2];
  const database = readDatabase();

  if (resource === 'settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, database.settings);
      return true;
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      try {
        const body = await parseBody(req);
        const nextDatabase = {
          ...database,
          settings: sanitizeSettings(body, database.settings),
        };
        writeDatabase(nextDatabase);
        sendJson(res, 200, nextDatabase.settings);
      } catch (error) {
        sendJson(res, 400, { error: 'JSON invalido' });
      }
      return true;
    }

    sendJson(res, 405, { error: 'Metodo no permitido' });
    return true;
  }

  if (!collectionNames.includes(resource)) {
    sendJson(res, 404, { error: 'Recurso no encontrado' });
    return true;
  }

  const collection = database[resource];

  if (!itemId) {
    if (req.method === 'GET') {
      sendJson(res, 200, collection);
      return true;
    }

    if (req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const item = {
          ...sanitizeCollectionItem(resource, body),
          id: body.id || createId(),
          createdAt: body.createdAt || new Date().toISOString().slice(0, 10),
        };
        const nextDatabase = {
          ...database,
          [resource]: [...collection, item],
        };
        writeDatabase(nextDatabase);
        sendJson(res, 201, item);
      } catch (error) {
        sendJson(res, 400, { error: 'JSON invalido' });
      }
      return true;
    }

    sendJson(res, 405, { error: 'Metodo no permitido' });
    return true;
  }

  const item = collection.find(entry => String(entry.id) === itemId);

  if (!item) {
    sendJson(res, 404, { error: 'Item no encontrado' });
    return true;
  }

  if (req.method === 'GET') {
    sendJson(res, 200, item);
    return true;
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    try {
      const body = await parseBody(req);
      const nextItem = req.method === 'PUT'
        ? {
            ...sanitizeCollectionItem(resource, body, item),
            id: item.id,
            createdAt: item.createdAt || body.createdAt,
          }
        : {
            ...sanitizeCollectionItem(resource, body, item),
            id: item.id,
            createdAt: item.createdAt,
          };
      const nextDatabase = {
        ...database,
        [resource]: collection.map(entry => (
          String(entry.id) === itemId ? nextItem : entry
        )),
      };
      writeDatabase(nextDatabase);
      sendJson(res, 200, nextItem);
    } catch (error) {
      sendJson(res, 400, { error: 'JSON invalido' });
    }
    return true;
  }

  if (req.method === 'DELETE') {
    const nextDatabase = {
      ...database,
      [resource]: collection.filter(entry => String(entry.id) !== itemId),
    };
    writeDatabase(nextDatabase);
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: 'Metodo no permitido' });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);

    if (!fs.existsSync(filePath)) {
      filePath = path.join(DIST_DIR, 'index.html');
    }

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error) {
    console.error('Server error:', error);
    sendText(res, 500, 'Error');
  }
});

ensureDataFile();

const currentDb = readDatabase();
if (isInitialDatabase(currentDb)) {
  writeDatabase(currentDb);
}

server.listen(PORT, () => {
  console.log('========================================');
  console.log('Inser Salud App');
  console.log('========================================');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/db`);
  console.log('========================================');
});
