/* global Buffer */
// Funcion serverless de Vercel. vercel.json reescribe /api/* hacia aca.
// Usos:
//  1) Proxy de imagenes para los PDF: GET /api/server?img=<url>
//     (cdn.zyrosite.com no manda CORS y el canvas quedaba "tainted")
//  2) API de vencimientos para integraciones (Hermes):
//     GET /api/server?vencimientos=1&key=<clave generada en Configuracion>
//     La clave se valida contra settings.apiKey guardada en Supabase.

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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    generado: new Date().toISOString(),
    resumen: {
      equipos_alquiler: equipos_alquiler.length,
      equipos_venta: equipos_venta.length,
      mascaras_venta: mascaras_venta.length,
    },
    equipos_alquiler,
    equipos_venta,
    mascaras_venta,
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
  if (req.query?.img) {
    await handleImageProxy(req, res);
    return;
  }
  res.status(400).json({ error: 'Parametro requerido: img, vencimientos o precios' });
}
