/* global Buffer */
// Funcion serverless de Vercel. vercel.json reescribe /api/* hacia aca.
// Uso actual: proxy de imagenes para los PDF (cotizacion/factura/remito).
// Los CDN de las fotos (cdn.zyrosite.com) no mandan Access-Control-Allow-Origin,
// el canvas del navegador queda "tainted" y la foto no podia incrustarse en el
// PDF. Este proxy baja la imagen del lado del servidor y la sirve same-origin.

const ALLOWED_HOSTS = new Set([
  'cdn.zyrosite.com',
  'www.inser.ar',
  'inser.ar',
  'www.insersalud.com',
  'insersalud.com',
]);

export default async function handler(req, res) {
  const img = req.query?.img;
  if (!img) {
    res.status(400).json({ error: 'Falta parametro img' });
    return;
  }

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
