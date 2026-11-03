// Logica PURA de precios de alquiler y stock de ventas (sin React). Tests: tests/stock.test.js
import { periodoDe } from './periodos.js';

// Precio MENSUAL de alquiler de un equipo (mismo criterio que la API de precios de Santi):
// 1) su precio propio; 2) un alquiler MENSUAL de ese equipo (primero los en curso); 3) otro
// equipo con el mismo nombre y precio propio; 4) un alquiler mensual de otro equipo con el
// mismo nombre. Los quincenales no cuentan: su precio es por 15 dias.
export function precioMensualEquipo(equip, equipment = [], rentals = []) {
  if (!equip) return 0;
  if (Number(equip.rentalPrice) > 0) return Number(equip.rentalPrice);
  const mensualCon = (pred) => {
    const cands = (rentals || []).filter(r => pred(r) && periodoDe(r) === 'mensual' && Number(r.price) > 0);
    const r = cands.find(x => x.status !== 'finalizado') || cands[0];
    return r ? Number(r.price) : 0;
  };
  const propio = mensualCon(r => r.equipmentId === equip.id);
  if (propio) return propio;
  if (!equip.name) return 0;
  const mismoNombre = (equipment || []).filter(e => e.id !== equip.id && e.name === equip.name);
  const conPrecio = mismoNombre.find(e => Number(e.rentalPrice) > 0);
  if (conPrecio) return Number(conPrecio.rentalPrice);
  const ids = new Set(mismoNombre.map(e => e.id));
  return mensualCon(r => ids.has(r.equipmentId));
}

// Stock que maneja la app: mascarillas, descartables y equipos nuevos (los de alquiler no).
export const CATS_STOCK = { mascarillas: 'mascaras', descartables: 'descartables', equiposNuevos: 'equiposNuevos' };
export const tieneStock = (it) => it && it.stock !== undefined && it.stock !== null && it.stock !== '';
// Descuenta del stock lo facturado y devuelve { next, items }. TODO item de una categoria con
// stock queda marcado:
// - `_descontado`: lo que REALMENTE se desconto (0 si el producto no maneja stock o no existe;
//   si se vendio de mas, solo lo que habia). Al borrar o editar la factura vuelve exactamente eso.
// - `_sinDescontar`: unidades facturadas que NO se descontaron (no habia stock, o venian de una
//   factura vieja que nunca las desconto). En una edicion tampoco se descuentan: editar sin
//   cambios deja el stock igual.
export function descontarStock(cur, items) {
  const next = { ...cur };
  const salida = (items || []).map(c => {
    if (!c || !CATS_STOCK[c._cat]) return { ...c };
    const q = Math.max(0, Number(c.quantity) || 0);
    const pide = c._aDescontar !== undefined ? Math.max(0, Number(c._aDescontar) || 0) : q;
    return { ...c, _descontado: 0, _sinDescontar: Math.max(0, q - pide), _pide: pide };
  });
  Object.entries(CATS_STOCK).forEach(([cat, key]) => {
    if (!salida.some(c => c._cat === cat)) return;
    next[key] = (cur[key] || []).map(it => {
      if (!tieneStock(it)) return it;
      let stock = Number(it.stock) || 0;
      salida.forEach(c => {
        if (c._cat !== cat || c.id !== it.id) return;
        const quita = Math.min(stock, c._pide);
        c._descontado = quita;
        stock -= quita;
      });
      return stock === Number(it.stock) ? it : { ...it, stock };
    });
  });
  salida.forEach(c => { if (CATS_STOCK[c._cat]) c._sinDescontar = Math.max(0, (Math.max(0, Number(c.quantity) || 0)) - c._descontado); delete c._aDescontar; delete c._pide; if (!c._sinDescontar) delete c._sinDescontar; });
  return { next, items: salida };
}
// Devuelve al stock lo que desconto una factura guardada. Items nuevos: su `_descontado`.
// Items viejos (sin esa marca): mascarillas y descartables su cantidad (era lo unico que se
// descontaba); los equipos nuevos no se descontaban y no se devuelven.
export function devolverStock(cur, items) {
  const next = { ...cur };
  Object.entries(CATS_STOCK).forEach(([cat, key]) => {
    const delCat = (items || []).filter(c => c && c._cat === cat);
    if (!delCat.length) return;
    next[key] = (cur[key] || []).map(it => {
      if (!tieneStock(it)) return it;
      const vuelve = delCat.filter(c => c.id === it.id).reduce((s, c) => s + cuantoDevuelve(c), 0);
      return vuelve ? { ...it, stock: (Number(it.stock) || 0) + vuelve } : it;
    });
  });
  return next;
}
function cuantoDevuelve(c) {
  if (c._descontado !== undefined) return Number(c._descontado) || 0;
  return c._cat === 'equiposNuevos' ? 0 : (Number(c.quantity) || 0);
}

// Al regenerar una factura: las unidades que la version anterior NUNCA desconto (`_sinDescontar`,
// o equipos nuevos de facturas viejas sin marca) tampoco se descuentan ahora (si no, una edicion
// sin cambios bajaba el stock). Devuelve los items con `_aDescontar`.
export function itemsADescontar(cart, previoItems) {
  const yaEstaban = new Map();
  (previoItems || []).filter(c => c && CATS_STOCK[c._cat]).forEach(c => {
    const sinDescontar = c._descontado === undefined ? (c._cat === 'equiposNuevos' ? (Number(c.quantity) || 0) : 0) : (Number(c._sinDescontar) || 0);
    if (sinDescontar) yaEstaban.set(c._cat + '|' + c.id, (yaEstaban.get(c._cat + '|' + c.id) || 0) + sinDescontar);
  });
  if (!yaEstaban.size) return cart;
  return (cart || []).map(c => {
    const k = c._cat + '|' + c.id;
    if (!CATS_STOCK[c._cat] || !yaEstaban.get(k)) return c;
    const libres = yaEstaban.get(k);
    const q = Number(c.quantity) || 0;
    const usa = Math.min(libres, q);
    yaEstaban.set(k, libres - usa);
    return { ...c, _aDescontar: q - usa };
  });
}

// Items que superan el stock disponible (devueltos = items de la version anterior que se
// reemplaza: lo que devuelven cuenta como disponible y lo que no se va a descontar no pide).
export function faltantesDeStock(data, items, devueltos = []) {
  const aPedir = itemsADescontar(items || [], devueltos);
  return aPedir.filter(c => CATS_STOCK[c._cat]).map(c => {
    const it = (data[CATS_STOCK[c._cat]] || []).find(x => x.id === c.id);
    if (!tieneStock(it)) return null;
    const devuelto = devueltos.filter(a => a.id === c.id && a._cat === c._cat).reduce((s, a) => s + cuantoDevuelve(a), 0);
    const disponible = (Number(it.stock) || 0) + devuelto;
    const pide = c._aDescontar !== undefined ? c._aDescontar : Number(c.quantity);
    return pide > disponible ? `${c.name}: pedís ${pide}, hay ${disponible}` : null;
  }).filter(Boolean);
}
