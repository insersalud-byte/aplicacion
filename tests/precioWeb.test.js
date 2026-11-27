// Precio en insersalud.com de equipos nuevos y mascarillas (src/data/precioWeb.js). Correr: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precioDeTexto, textoPrecioWeb, normalizarCamposWeb, errorCamposWeb, igualarPrecioWeb, productosParaWeb } from '../src/data/precioWeb.js';
import { WEB_CATALOGO } from '../src/data/webCatalogo.js';

test('lee y escribe los precios como se ven en la web', () => {
  assert.deepEqual(precioDeTexto('$520.000'), { webPrecio: 520000, webMoneda: 'ARS' });
  assert.deepEqual(precioDeTexto('U$S 1.400'), { webPrecio: 1400, webMoneda: 'USD' });
  assert.deepEqual(precioDeTexto('U$S 35'), { webPrecio: 35, webMoneda: 'USD' });
  assert.equal(precioDeTexto('consultar'), null);
  assert.equal(textoPrecioWeb({ webSlug: 'x', webPrecio: 520000, webMoneda: 'ARS' }), '$520.000');
  assert.equal(textoPrecioWeb({ webSlug: 'x', webPrecio: 7342, webMoneda: 'USD' }), 'U$S 7.342');
  assert.equal(textoPrecioWeb({ webPrecio: 7342 }), '');
});

test('todos los precios de referencia del catalogo web se leen (sin formatos raros)', () => {
  const slugs = new Set();
  for (const p of WEB_CATALOGO) {
    assert.ok(precioDeTexto(p.precio), `precio ilegible: ${p.slug} ${p.precio}`);
    assert.ok(!slugs.has(p.slug), `slug repetido ${p.slug}`);
    slugs.add(p.slug);
    // ida y vuelta: el texto que arma la app es identico al de la web
    assert.equal(textoPrecioWeb({ webSlug: p.slug, ...precioDeTexto(p.precio) }), p.precio);
  }
});

test('normalizar: sin producto web no deja campos; con producto, numeros prolijos', () => {
  assert.deepEqual(normalizarCamposWeb({ name: 'a', webSlug: '', webPrecio: 5, webMoneda: 'USD' }), { name: 'a' });
  assert.deepEqual(normalizarCamposWeb({ name: 'a', webSlug: 's', webPrecio: '520000.4', webMoneda: 'x' }), { name: 'a', webSlug: 's', webPrecio: 520000, webMoneda: 'ARS' });
  assert.equal(errorCamposWeb({ webSlug: 's', webPrecio: 0 }) !== '', true);
  assert.equal(errorCamposWeb({ webSlug: '', webPrecio: 0 }), '');
});

test('igualar: los otros registros del mismo producto web toman el precio', () => {
  const data = {
    equiposNuevos: [{ id: 1, webSlug: 's', webPrecio: 100, webMoneda: 'ARS' }, { id: 2, webSlug: 's', webPrecio: 90, webMoneda: 'ARS' }, { id: 3, webSlug: 't', webPrecio: 5, webMoneda: 'USD' }],
    mascaras: [{ id: 4, webSlug: 's', webPrecio: 80, webMoneda: 'ARS' }],
  };
  const out = igualarPrecioWeb(data, data.equiposNuevos[0]);
  assert.equal(out.equiposNuevos[1].webPrecio, 100);
  assert.equal(out.mascaras[0].webPrecio, 100);
  assert.equal(out.equiposNuevos[2], data.equiposNuevos[2]);
  // nada que igualar: el mismo objeto (no genera un guardado de mas)
  assert.equal(igualarPrecioWeb(out, out.equiposNuevos[0]), out);
  assert.equal(igualarPrecioWeb(data, { id: 9 }), data);
});

test('productos para la web: solo los vinculados', () => {
  const data = { equiposNuevos: [{ id: 1, name: 'CPAP', webSlug: 's', webPrecio: 520000, webMoneda: 'ARS' }, { id: 2, name: 'x' }], mascaras: [{ id: 3, name: 'F30', webSlug: 'f', webPrecio: 212, webMoneda: 'USD' }] };
  assert.deepEqual(productosParaWeb(data).map(r => { const o = { ...r }; delete o.confirmado; return o; }), [
    { slug: 's', moneda: 'ARS', monto: 520000, nombreApp: 'CPAP', tabla: 'equiposNuevos' },
    { slug: 'f', moneda: 'USD', monto: 212, nombreApp: 'F30', tabla: 'mascaras' },
  ]);
});

import { VINCULO_WEB, aplicarVinculoWeb, vinculosPendientes } from '../src/data/vinculoWebInicial.js';

test('vinculo inicial: cubre los 36 productos de la web, una vez cada uno', () => {
  const web = new Set(WEB_CATALOGO.map(p => p.slug));
  const vinc = VINCULO_WEB.map(v => v.slug);
  assert.equal(new Set(vinc).size, vinc.length);
  assert.deepEqual([...web].filter(s => !vinc.includes(s)), []);
  assert.deepEqual(vinc.filter(s => !web.has(s)), []);
  const ids = VINCULO_WEB.flatMap(v => v.ids || []);
  assert.equal(new Set(ids).size, ids.length);
});

test('vinculo inicial: completa sin pisar y se puede repetir', () => {
  let n = 0;
  const nuevoId = () => `nuevo${++n}`;
  const data = {
    equiposNuevos: [{ id: 'mwnn7vtk4d1u9yoibeh', name: 'CPAP BMC G2S', price: 499000 }, { id: 'ev_1776894626872_8', name: 'x', webSlug: 'otro', webPrecio: 1, webMoneda: 'ARS' }],
    mascaras: [{ id: 'excel_1776893009285_2', name: 'RESCOMF' }],
  };
  const out = aplicarVinculoWeb(data, nuevoId);
  assert.deepEqual(out.equiposNuevos[0], { id: 'mwnn7vtk4d1u9yoibeh', name: 'CPAP BMC G2S', price: 499000, webSlug: 'cpap-bmc-g2s', webPrecio: 520000, webMoneda: 'ARS' });
  assert.equal(out.equiposNuevos[1].webSlug, 'otro'); // ya vinculado: no se toca
  assert.deepEqual(out.mascaras[0], { id: 'excel_1776893009285_2', name: 'RESCOMF', webSlug: 'mascara-nasal-para-cpap-y-bipap', webPrecio: 35, webMoneda: 'USD' });
  assert.equal(out.equiposNuevos.filter(r => /^nuevo/.test(r.id)).length, 2);
  assert.equal(out.mascaras.filter(r => /^nuevo/.test(r.id)).length, 2);
  assert.equal(aplicarVinculoWeb(out, nuevoId), out);
  assert.equal(vinculosPendientes(out), 0);
});

import { precioPropuesto, cambioCamposWeb, saltoPrecioWeb } from '../src/data/precioWeb.js';

test('auditoria: el precio propuesto sale de las otras unidades, no del producto anterior', () => {
  const regs = [{ id: 1, webSlug: 'autocpap', webPrecio: 700000, webMoneda: 'ARS' }];
  assert.deepEqual(precioPropuesto('autocpap', regs, '$630.000'), { webPrecio: 700000, webMoneda: 'ARS' });
  assert.deepEqual(precioPropuesto('otro', regs, 'U$S 35'), { webPrecio: 35, webMoneda: 'USD' });
});

test('auditoria: solo se iguala si cambio la parte web; los saltos grandes se confirman', () => {
  const a = { webSlug: 's', webPrecio: 630000, webMoneda: 'ARS' };
  assert.equal(cambioCamposWeb(a, { ...a, serialNumber: 'X' }), false);
  assert.equal(cambioCamposWeb(a, { ...a, webPrecio: 650000 }), true);
  assert.equal(saltoPrecioWeb(a, { ...a, webPrecio: 650000 }), '');
  assert.notEqual(saltoPrecioWeb(a, { ...a, webPrecio: 6300000 }), '');
  assert.notEqual(saltoPrecioWeb(a, { ...a, webMoneda: 'USD', webPrecio: 500 }), '');
  const data = { equiposNuevos: [{ id: 1, name: 'a', webSlug: 's', webPrecio: 900000, webMoneda: 'ARS', webConfirmado: 900000 }, { id: 2, name: 'b', webSlug: 's', webPrecio: 900000, webMoneda: 'ARS', webConfirmado: 630000 }] };
  assert.deepEqual(productosParaWeb(data).map(p => p.confirmado), [true, false]);
});

test('auditoria: el vinculo inicial es de una sola vez', () => {
  const data = { settings: {}, equiposNuevos: [], mascaras: [] };
  const out = aplicarVinculoWeb(data, () => 'id', '2026-11-27');
  assert.equal(out.settings.webVinculoInicial, '2026-11-27');
  const borrado = { ...out, mascaras: [] }; // borraron a proposito los creados
  assert.equal(vinculosPendientes(borrado), 0);
  assert.equal(aplicarVinculoWeb(borrado, () => 'id'), borrado);
});
