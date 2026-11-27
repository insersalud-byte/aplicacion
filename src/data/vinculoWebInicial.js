// Vinculo inicial (una sola vez, 27-nov-2026) de los Equipos nuevos y Mascarillas de la app con
// los productos de insersalud.com. Decision del dueño: arrancar con los precios que HOY tiene la
// web, para que la primera sincronizacion diaria no cambie nada; desde ahi manda la app.
// Solo completa registros que todavia no tienen producto web, y crea los 4 productos que estan en
// la web pero no en la app (con stock 0). Se puede correr mas de una vez sin duplicar nada.
import { WEB_CATALOGO } from './webCatalogo.js';
import { precioDeTexto } from './precioWeb.js';

const E = (n) => `ev_1776894626872_${n}`;

// slug de la web -> registros de la app (todas las unidades del mismo producto).
export const VINCULO_WEB = [
  // Equipos nuevos
  { tabla: 'equiposNuevos', slug: 'cpap-resmed-airsense-10', ids: [E(21)] },
  { tabla: 'equiposNuevos', slug: 'cpap-bmc-g2s', ids: ['mwnn7vtk4d1u9yoibeh'] },
  { tabla: 'equiposNuevos', slug: 'oferta-autocpap-bmc-g2s-m1-mini-con-almohadillas-nasales-con-humidificador-p2h-', ids: [E(25)] },
  { tabla: 'equiposNuevos', slug: 'bipap-bmc-g2-con-frecuencia-respiratoria-y-humidificador', ids: [E(6)] },
  { tabla: 'equiposNuevos', slug: 'concentrador-de-oxigeno-bmc-estacionario', ids: [E(7)] },
  { tabla: 'equiposNuevos', slug: 'concentrador-portatil-gce-zen-o-con-carrito-y-2-baterias', ids: [E(31)] },
  { tabla: 'equiposNuevos', slug: 'autocpap-bmc-g2s', ids: [E(10), 'mt4qko4vi3ka5t8suu', 'mt4qpwhg9yezk34ccsd', 'mwjp80i0me6ou36qmv', 'mwnn7191chhkh9cc3kq'] },
  { tabla: 'equiposNuevos', slug: 'autocpap-philips-dreamstation-con-humidificador-y-conectividad-', ids: [E(8)] },
  { tabla: 'equiposNuevos', slug: 'cpap-philips-dreamstation-con-humidificador-y-conectividad-', ids: [E(19)] },
  { tabla: 'equiposNuevos', slug: 'autocpap-resmed-airsense-10-con-nube', ids: [E(23)] },
  { tabla: 'equiposNuevos', slug: 'stellar-50-resmed-con-humidificador-y-bateria', ids: [E(109)] },
  { tabla: 'equiposNuevos', slug: 'cough-asisst-asistente-tos', ids: [E(3)] },
  { tabla: 'equiposNuevos', slug: 'concentrador-de-oxigeno-estacionario1', ids: [E(100)] },
  { tabla: 'equiposNuevos', slug: 'cpap-yuwell-yh-360-con-humidificador', ids: [E(18)] },
  { tabla: 'equiposNuevos', slug: 'poligrafo-bmc-yh-600b-pro-', ids: [E(99)] },
  { tabla: 'equiposNuevos', slug: 'concentrador-de-oxigeno-portatil-simplygo', ids: [E(29)] },
  { tabla: 'equiposNuevos', slug: 'mochila-de-oxigeno-tubo-de0415-regulador-bolso-carga', ids: [E(107)] },
  { tabla: 'equiposNuevos', slug: 'concentrador-de-oxigeno-yuwell-7f-5b', crear: { name: 'Concentrador de oxígeno Yuwell 7F-5B 5 L', description: 'Yuwell 7F-5B, 5 L/min', imageUrl: 'https://insersalud.com/artifacts/products/concentrador_yuwell_5l.jpg', price: 0, priceUsd: 0, priceVentaUsd: 0, stock: 0, serialNumber: '' } },
  { tabla: 'equiposNuevos', slug: 'concentrador-de-oxigeno-yuwell-10-litros', crear: { name: 'Concentrador de oxígeno Yuwell 10 L (alto flujo)', description: 'Yuwell 10 L/min', imageUrl: 'https://insersalud.com/artifacts/products/concentrador_yuwell_10l_2.jpg', price: 0, priceUsd: 0, priceVentaUsd: 0, stock: 0, serialNumber: '' } },
  // Mascarillas y consumibles
  { tabla: 'mascaras', slug: 'mascarilla-nasal-cpap', ids: ['excel_1776893009285_4'] },
  { tabla: 'mascaras', slug: 'mascara-nasal-para-cpap-y-bipap', ids: ['excel_1776893009285_2'] },
  { tabla: 'mascaras', slug: 'mascarilla-nasobucal-dreamwear-philips-cpap', ids: ['17774972264853b981442'] },
  { tabla: 'mascaras', slug: 'mascara-cpap-bipap-bmc-f6-nasobucal-con-apoya-frontal-', ids: ['excel_1776893009286_27'] },
  { tabla: 'mascaras', slug: 'mascara-buconasal-bmc-f2-codo-azul', ids: ['mrqkpvct9op8dsv61ed'] },
  { tabla: 'mascaras', slug: 'nascara-nasal-peditrica-jirafa-philips-respironics', ids: ['mssy0oydc12nc45gewa'] },
  { tabla: 'mascaras', slug: 'nascara-nasal-con-apoya-frente-bmc-n4-talle-m-l', ids: ['17774972264948403cdf'] },
  { tabla: 'mascaras', slug: 'buconasal-con-apoya-frente-yuwell-cpapbpap', ids: ['1777497226480f0e453e'] },
  { tabla: 'mascaras', slug: 'buconasal-sin-apoya-frente-yuwell-yf02-cpapbpap', ids: ['1777497226481cb83736'] },
  { tabla: 'mascaras', slug: 'nascara-nasal-pediatrica-nasal-hsiner-cirri-mini-s-m-l-xs', ids: ['excel_1776893009286_13'] },
  { tabla: 'mascaras', slug: 'nascara-nasal-sin-apoya-frente-bmc-n5a-talles-swsm-', ids: ['17774972264952e83be82'] },
  { tabla: 'mascaras', slug: 'buconasal-sin-apoya-frente-bmc-sml-f5a-cpapbpap', ids: ['17774972264973aea09af'] },
  { tabla: 'mascaras', slug: '-mascara-nasal-airfit-mimimo-contacto-talles-swsm-resmed', ids: ['1777497226510853559b'] },
  { tabla: 'mascaras', slug: 'mascarilla-nasobucal-airfit-f30-resmed-cpapbpap', ids: ['17774972265071bd5ba50'] },
  { tabla: 'mascaras', slug: 'mascara-nasal-yuwell-pillow-l-o-m-yp-01-para-cpap-y-bipap', ids: ['17774972264821b0950cd'] },
  { tabla: 'mascaras', slug: 'nascara-nasal-pediatrica-infant-cpap-kit-00-0-1-2-3-4-5', crear: { name: 'Infant CPAP Kit neonatal (tallas 00 a 5)', type: 'mascarilla', stock: 0, minStock: 0, description: 'Kit pediátrico, tallas 00, 0, 1, 2, 3, 4 y 5', precio: 0, imageUrl: '' } },
  { tabla: 'mascaras', slug: 'tubuladura-para-cpap-bipap', crear: { name: 'Tubuladura para CPAP / BiPAP (22 mm, 1,8 m)', type: 'tubuladura', stock: 0, minStock: 0, description: 'Tubuladura estándar de 22 mm y 1,8 m', precio: 0, imageUrl: 'https://insersalud.com/artifacts/products/tubuladura_cpap_bipap.jpg' } },
];

const precioHoy = (slug) => precioDeTexto(WEB_CATALOGO.find(p => p.slug === slug)?.precio);
const tieneSlug = (data, slug) => ['equiposNuevos', 'mascaras'].some(t => (data[t] || []).some(r => r.webSlug === slug));

// Cuantos vinculos faltan aplicar (para mostrar o no el boton).
// Es de una sola vez: aplicado, queda la marca settings.webVinculoInicial y el cartel no vuelve
// aunque despues se desvincule o se borre algun producto a proposito.
export function vinculosPendientes(data) {
  if (data?.settings?.webVinculoInicial) return 0;
  let n = 0;
  for (const v of VINCULO_WEB) {
    if (v.crear) { if (!tieneSlug(data, v.slug)) n++; continue; }
    if (v.ids.some(id => (data[v.tabla] || []).some(r => r.id === id && !r.webSlug))) n++;
  }
  return n;
}

// Aplica el vinculo. nuevoId: generador de ids de la app. Devuelve el MISMO objeto si no hay nada.
export function aplicarVinculoWeb(data, nuevoId, hoy = new Date().toISOString().slice(0, 10)) {
  if (data?.settings?.webVinculoInicial) return data;
  let out = data;
  const set = (tabla, lista) => { out = { ...out, [tabla]: lista }; };
  for (const v of VINCULO_WEB) {
    const precio = precioHoy(v.slug);
    if (!precio) continue;
    const campos = { webSlug: v.slug, ...precio };
    if (v.crear) {
      if (!tieneSlug(out, v.slug)) set(v.tabla, [...(out[v.tabla] || []), { ...v.crear, id: nuevoId(), ...campos }]);
      continue;
    }
    const lista = out[v.tabla] || [];
    if (!lista.some(r => v.ids.includes(r.id) && !r.webSlug)) continue;
    set(v.tabla, lista.map(r => (v.ids.includes(r.id) && !r.webSlug ? { ...r, ...campos } : r)));
  }
  return { ...out, settings: { ...(out.settings || {}), webVinculoInicial: hoy } };
}
