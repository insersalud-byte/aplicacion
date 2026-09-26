/* global Buffer */
// Funcion serverless de Vercel. vercel.json reescribe /api/* hacia aca.
// Usos:
//  1) Proxy de imagenes para los PDF: GET /api/server?img=<url>
//     (cdn.zyrosite.com no manda CORS y el canvas quedaba "tainted")
//  2) API de vencimientos para integraciones (Hermes):
//     GET /api/server?vencimientos=1&key=<clave generada en Configuracion>
//     La clave se valida contra settings.apiKey guardada en Supabase.
//  3) API de precios: GET /api/server?precios=1&key=<clave>
//  4) API contable de SOLO LECTURA para el agente contador de Santi (Hermes):
//     GET /api/server?contabilidad=1&key=<clave>
//     Devuelve facturas, cotizaciones, alquileres con su cobranza, parque de equipos,
//     catalogo de venta (con costo USD si esta cargado), mascaras, descartables y los
//     parametros de la pestaña Contabilidad. Nunca escribe en la base.

const ALLOWED_HOSTS = new Set([
  'cdn.zyrosite.com',
  'www.inser.ar',
  'inser.ar',
  'www.insersalud.com',
  'insersalud.com',
]);

const SUPABASE_URL = 'https://gvharyztavhugqiaihjq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wTO5X4JfeoHP0zg7qq4azQ_OJ3jxfwL';

// Fecha de hoy en zona horaria argentina (YYYY-MM-DD).
// new Date().toISOString() seria UTC: desde las 21:00 ya marcaria "manana".
function hoyArgentina() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Cordoba' }).format(new Date());
}

function diasEntre(desde, hasta) {
  const a = new Date(`${desde}T00:00:00Z`);
  const b = new Date(`${hasta}T00:00:00Z`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Lee la base validando la clave API. Devuelve el objeto data o null (y ya
// respondio el error en res).
async function getAuthorizedData(req, res) {
  const key = req.query?.key;
  if (!key) {
    res.status(401).json({ error: 'Falta la clave API (parametro key)' });
    return null;
  }
  const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/inser_app_data?id=eq.1&select=data`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!dbRes.ok) {
    res.status(502).json({ error: 'No se pudo leer la base de datos' });
    return null;
  }
  const rows = await dbRes.json();
  const data = rows?.[0]?.data || {};
  const apiKey = data.settings?.apiKey;
  if (!apiKey || key !== apiKey) {
    res.status(403).json({ error: 'Clave API invalida' });
    return null;
  }
  return data;
}

async function handleVencimientos(req, res) {
  const data = await getAuthorizedData(req, res);
  if (!data) return;

  const hoy = hoyArgentina();
  const patients = data.patients || [];
  const equipment = data.equipment || [];
  const rentals = data.rentals || [];

  const item = (r) => {
    const p = patients.find((x) => x.id === r.patientId);
    const e = equipment.find((x) => x.id === r.equipmentId);
    return {
      paciente: p?.name || 'Sin paciente',
      telefono: p?.phone || '',
      direccion: p?.address || '',
      equipo: e?.name || 'Sin equipo',
      numero_serie: e?.serialNumber || '',
      fecha_inicio: r.startDate || '',
      fecha_vencimiento: r.endDate || '',
      // periodo: 'mensual' o 'quincenal' (15 dias). precio_mensual se conserva por compatibilidad;
      // precio_periodo es el que se cobra por cada periodo del alquiler.
      periodo: r.period === 'quincenal' ? 'quincenal' : 'mensual',
      precio_periodo: Number(r.price) || 0,
      precio_mensual: Number(r.price) || 0,
      estado: r.status || '',
      dias: diasEntre(hoy, r.endDate), // negativo = dias vencido, positivo = dias restantes
    };
  };

  const activos = rentals.filter((r) => r.status !== 'finalizado' && r.endDate);
  const vencidos = activos.filter((r) => r.endDate < hoy).map(item)
    .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));
  const vencenHoy = activos.filter((r) => r.endDate === hoy).map(item);
  const en7 = new Date(`${hoy}T00:00:00Z`);
  en7.setUTCDate(en7.getUTCDate() + 7);
  const hasta7 = en7.toISOString().slice(0, 10);
  const proximos = activos.filter((r) => r.endDate > hoy && r.endDate <= hasta7).map(item)
    .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    generado: new Date().toISOString(),
    hoy,
    resumen: {
      vencidos: vencidos.length,
      vencen_hoy: vencenHoy.length,
      proximos_7_dias: proximos.length,
      alquileres_activos: activos.length,
    },
    vencidos,
    vencen_hoy: vencenHoy,
    proximos_7_dias: proximos,
  });
}

async function handlePrecios(req, res) {
  const data = await getAuthorizedData(req, res);
  if (!data) return;

  const equipment = data.equipment || [];
  const equiposNuevos = data.equiposNuevos || [];
  const mascaras = data.mascaras || [];
  const rentals = data.rentals || [];

  // Precio de alquiler de un equipo: campo propio -> alquiler activo del mismo
  // equipo -> alquiler de otro equipo con el mismo nombre (mismo criterio que la app).
  const precioAlquiler = (e) => {
    if (Number(e.rentalPrice) > 0) return Number(e.rentalPrice);
    const r = rentals.find((x) => x.equipmentId === e.id && x.status !== 'finalizado' && Number(x.price) > 0);
    if (r) return Number(r.price);
    const r2 = rentals.find((x) => {
      const re = equipment.find((q) => q.id === x.equipmentId);
      return re && re.name === e.name && Number(x.price) > 0;
    });
    return r2 ? Number(r2.price) : 0;
  };

  const equipos_alquiler = equipment
    .map((e) => ({ nombre: e.name, precio_mensual: precioAlquiler(e) }))
    .filter((x) => x.precio_mensual > 0)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const equipos_venta = equiposNuevos
    .map((e) => ({ nombre: e.name, precio: Number(e.price) || 0 }))
    .filter((x) => x.precio > 0)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const mascaras_venta = mascaras
    .map((m) => ({ nombre: m.name, precio: Number(m.precio) || 0, talle: m.talle || '', stock: Number(m.stock) || 0 }))
    .filter((x) => x.precio > 0)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  // Filtro opcional por categoria para respuestas mas chicas: ?cat=alquiler|venta|mascaras
  const cat = (req.query?.cat || '').toString().toLowerCase();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const out = {
    generado: new Date().toISOString(),
    resumen: {
      equipos_alquiler: equipos_alquiler.length,
      equipos_venta: equipos_venta.length,
      mascaras_venta: mascaras_venta.length,
    },
  };
  if (!cat || cat === 'alquiler') out.equipos_alquiler = equipos_alquiler;
  if (!cat || cat === 'venta') out.equipos_venta = equipos_venta;
  if (!cat || cat === 'mascaras') out.mascaras_venta = mascaras_venta;
  res.status(200).json(out);
}

// Datos contables normalizados, sin calculos: los indicadores (cobrado, contratado,
// ganancia, MRR, ocupacion) los calcula el agente con las MISMAS reglas que la pestaña
// Contabilidad de la app (periodosCobradosEnMes, vigenteEnMes, resumenDeMes en App.jsx).
async function handleContabilidad(req, res) {
  const data = await getAuthorizedData(req, res);
  if (!data) return;

  const num = (v) => Number(v) || 0;
  const txt = (v) => String(v ?? '').trim();
  const patients = data.patients || [];
  const equipment = data.equipment || [];
  const rentals = data.rentals || [];

  const fechaDoc = (d) => txt(d.date || d.createdAt).slice(0, 10);
  const itemsDoc = (d) => (d.items || []).map((it) => ({
    nombre: txt(it.name),
    precio: num(it.price),
    cantidad: num(it.quantity) || 1,
  }));
  const doc = (d) => ({
    numero: txt(d.invoiceNumber),
    fecha: fechaDoc(d),
    cliente: txt(d.clientName || d.customerName),
    telefono: txt(d.clientPhone || d.customerPhone),
    total: num(d.total),
    notas: txt(d.notes),
    items: itemsDoc(d),
  });

  const alquileres = rentals.map((r) => {
    const p = patients.find((x) => x.id === r.patientId);
    const e = equipment.find((x) => x.id === r.equipmentId);
    return {
      id: r.id,
      paciente: p?.name || 'Sin paciente',
      telefono: p?.phone || '',
      equipo_id: r.equipmentId || '',
      equipo: e?.name || 'Sin equipo',
      serie: e?.serialNumber || '',
      propiedad: e?.ownership || 'propio',
      periodo: r.period === 'quincenal' ? 'quincenal' : 'mensual',
      precio: num(r.price),
      inicio: txt(r.startDate),
      vencimiento: txt(r.endDate),
      estado: txt(r.status),
      baja: txt(r.finalizedAt).slice(0, 10),
      pagos: r.paymentStatusByMonth || {},
      notas: txt(r.notes),
    };
  });

  const equipos = equipment.map((e) => ({
    id: e.id,
    nombre: txt(e.name),
    serie: txt(e.serialNumber),
    tipo: txt(e.type),
    estado: txt(e.status),
    propiedad: e.ownership || 'propio',
    precio_mensual: num(e.rentalPrice),
    precio_quincenal: num(e.rentalPrice15),
  }));

  // En la app "Precio USD" (priceUsd) es el costo y "Venta USD" (priceVentaUsd) el precio de venta.
  const venta = (data.equiposNuevos || []).map((e) => ({
    nombre: txt(e.name),
    precio: num(e.price),
    costo_usd: num(e.priceUsd),
    venta_usd: num(e.priceVentaUsd),
    stock: num(e.stock),
  }));
  const mascaras = (data.mascaras || []).map((m) => ({
    nombre: txt(m.name),
    precio: num(m.precio || m.price),
    stock: num(m.stock),
    stock_minimo: num(m.minStock),
    talle: txt(m.talle),
  }));
  const descartables = (data.descartables || []).map((d) => ({
    nombre: txt(d.name),
    precio: num(d.price),
    stock: num(d.stock),
    stock_minimo: num(d.minStock),
  }));

  const c = data.settings?.contabilidad || {};
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    generado: new Date().toISOString(),
    hoy: hoyArgentina(),
    parametros: {
      margen_bruto_pct: c.margenBruto ?? 30,
      margen_neto_pct: c.margenNeto ?? 20,
      gasto_entrega: num(c.gastoEntrega),
    },
    resumen: {
      facturas: (data.invoices || []).length,
      cotizaciones: (data.quotations || []).length,
      remitos: (data.remitos || []).length,
      alquileres: alquileres.length,
      equipos: equipos.length,
      venta: venta.length,
      mascaras: mascaras.length,
      descartables: descartables.length,
    },
    facturas: (data.invoices || []).map(doc),
    cotizaciones: (data.quotations || []).map(doc),
    alquileres,
    equipos,
    venta,
    mascaras,
    descartables,
  });
}

async function handleImageProxy(req, res) {
  const img = req.query?.img;
  let target;
  try {
    target = new URL(img);
  } catch {
    res.status(400).json({ error: 'URL invalida' });
    return;
  }

  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.host)) {
    res.status(403).json({ error: 'Host no permitido' });
    return;
  }

  try {
    const upstream = await fetch(target.href, { redirect: 'follow' });
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream ${upstream.status}` });
      return;
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      res.status(415).json({ error: 'No es una imagen' });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Error bajando imagen', detail: String(e?.message || e) });
  }
}

export default async function handler(req, res) {
  if (req.query?.vencimientos) {
    try {
      await handleVencimientos(req, res);
    } catch (e) {
      res.status(500).json({ error: 'Error interno', detail: String(e?.message || e) });
    }
    return;
  }
  if (req.query?.precios) {
    try {
      await handlePrecios(req, res);
    } catch (e) {
      res.status(500).json({ error: 'Error interno', detail: String(e?.message || e) });
    }
    return;
  }
  if (req.query?.contabilidad) {
    try {
      await handleContabilidad(req, res);
    } catch (e) {
      res.status(500).json({ error: 'Error interno', detail: String(e?.message || e) });
    }
    return;
  }
  if (req.query?.img) {
    await handleImageProxy(req, res);
    return;
  }
  res.status(400).json({ error: 'Parametro requerido: img, vencimientos, precios o contabilidad' });
}
