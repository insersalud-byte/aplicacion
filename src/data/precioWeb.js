// Precio de venta en insersalud.com de los Equipos nuevos y las Mascarillas (pedido 27-nov-2026).
// Cada registro puede llevar: webSlug (ficha de la web, ver webCatalogo.js), webPrecio (numero
// entero) y webMoneda ('ARS' o 'USD'). Todos los dias a las 10:20 una tarea lee estos campos y
// pasa los precios a la web (scripts/sync-precios-app.mjs del repo INSER). Logica pura: se prueba
// con node (tests/precioWeb.test.js).

const miles = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// "$520.000" -> { webPrecio: 520000, webMoneda: 'ARS' } · "U$S 1.400" -> { 1400, 'USD' }
export function precioDeTexto(txt) {
  const s = String(txt || '').trim();
  const usd = s.match(/^U\$S\s?([\d.]+)$/);
  if (usd) return { webPrecio: Number(usd[1].replace(/\./g, '')), webMoneda: 'USD' };
  const ars = s.match(/^\$([\d.]+)$/);
  if (ars) return { webPrecio: Number(ars[1].replace(/\./g, '')), webMoneda: 'ARS' };
  return null;
}

// Como se ve en la web: "$520.000" o "U$S 758".
export const textoPrecioWeb = (r) => (r && r.webSlug && Number(r.webPrecio) > 0
  ? (r.webMoneda === 'USD' ? `U$S ${miles(r.webPrecio)}` : `$${miles(r.webPrecio)}`)
  : '');

// Precio que se propone al elegir un producto de la web: el que ya tienen los otros registros
// de ese producto (si no, se pisarian al guardar); si no hay ninguno, el de referencia de la web.
export function precioPropuesto(slug, registros, textoReferencia) {
  const hermano = (registros || []).find(r => r && r.webSlug === slug && Number(r.webPrecio) > 0);
  if (hermano) return { webPrecio: Math.round(Number(hermano.webPrecio)), webMoneda: hermano.webMoneda === 'USD' ? 'USD' : 'ARS' };
  return precioDeTexto(textoReferencia);
}

// Cambiaron el producto o el precio de la web respecto de como estaba el registro.
export const cambioCamposWeb = (antes, despues) => ['webSlug', 'webPrecio', 'webMoneda']
  .some(k => String((antes || {})[k] ?? '') !== String((despues || {})[k] ?? ''));

// Aviso extra al guardar un precio web muy distinto del anterior (mas de 40% o cambio de moneda):
// suele ser un error de tipeo. Todo precio web que se guarda desde el formulario queda marcado
// como confirmado (webConfirmado = webPrecio): la tarea diaria solo frena saltos grandes que NO
// pasaron por un guardado confirmado en la app.
export function saltoPrecioWeb(antes, despues) {
  if (!antes || !despues || !antes.webSlug || antes.webSlug !== despues.webSlug) return '';
  if ((antes.webMoneda || 'ARS') !== (despues.webMoneda || 'ARS')) {
    return `El precio en la web cambia de moneda: de ${textoPrecioWeb(antes)} a ${textoPrecioWeb(despues)}. ¿Es correcto?`;
  }
  const a = Number(antes.webPrecio), b = Number(despues.webPrecio);
  if (!(a > 0) || !(b > 0) || Math.abs(b / a - 1) <= 0.4) return '';
  return `El precio en la web pasa de ${textoPrecioWeb(antes)} a ${textoPrecioWeb(despues)} (cambia más de 40%). ¿Es correcto?`;
}

// Deja los campos prolijos antes de guardar: sin producto de la web no queda nada de la web.
export function normalizarCamposWeb(form) {
  const o = { ...form };
  const slug = String(o.webSlug || '').trim();
  if (!slug) {
    delete o.webSlug; delete o.webPrecio; delete o.webMoneda; delete o.webConfirmado;
    return o;
  }
  o.webSlug = slug;
  o.webPrecio = Math.round(Number(o.webPrecio) || 0);
  o.webMoneda = o.webMoneda === 'USD' ? 'USD' : 'ARS';
  return o;
}

// Error para mostrar si el formulario quedo a medias (producto elegido sin precio).
export function errorCamposWeb(form) {
  if (String(form.webSlug || '').trim() && !(Number(form.webPrecio) > 0)) {
    return 'Cargá el precio de venta en la web, o elegí "No se publica en la web".';
  }
  return '';
}

// Varios registros pueden ser el mismo producto de la web (unidades con su N° de serie, talles
// de una mascara). Al guardar uno, los demas toman el mismo precio: si no, la web no sabria cual
// vale y la tarea diaria no lo actualizaria.
export function igualarPrecioWeb(data, rec) {
  if (!rec || !rec.webSlug || !(Number(rec.webPrecio) > 0)) return data;
  const igualar = (lista) => {
    if (!Array.isArray(lista)) return lista;
    let cambio = false;
    const out = lista.map(x => {
      if (x.id === rec.id || x.webSlug !== rec.webSlug) return x;
      if (Number(x.webPrecio) === Number(rec.webPrecio) && x.webMoneda === rec.webMoneda && x.webConfirmado === rec.webConfirmado) return x;
      cambio = true;
      const y = { ...x, webPrecio: rec.webPrecio, webMoneda: rec.webMoneda };
      if (rec.webConfirmado === undefined) delete y.webConfirmado; else y.webConfirmado = rec.webConfirmado;
      return y;
    });
    return cambio ? out : lista;
  };
  const equiposNuevos = igualar(data.equiposNuevos);
  const mascaras = igualar(data.mascaras);
  if (equiposNuevos === data.equiposNuevos && mascaras === data.mascaras) return data;
  return { ...data, equiposNuevos, mascaras };
}

// Lo que se publica: un item por registro vinculado (lo usa la tarea diaria).
export function productosParaWeb(data) {
  const out = [];
  for (const [tabla, lista] of [['equiposNuevos', data.equiposNuevos], ['mascaras', data.mascaras]]) {
    for (const r of lista || []) {
      if (!r || !r.webSlug) continue;
      const monto = Math.round(Number(r.webPrecio) || 0);
      out.push({ slug: r.webSlug, moneda: r.webMoneda === 'USD' ? 'USD' : 'ARS', monto, nombreApp: r.name || '', tabla, confirmado: Number(r.webConfirmado) === monto && monto > 0 });
    }
  }
  return out;
}
