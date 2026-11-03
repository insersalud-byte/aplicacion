// Tests de stock de ventas y precio mensual de alquiler (src/data/stock.js). Correr: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descontarStock, devolverStock, faltantesDeStock, precioMensualEquipo, itemsADescontar as itemsADescontarImp } from '../src/data/stock.js';

const datos = () => ({
  mascaras: [{ id: 'm1', name: 'Nasal', stock: 2 }],
  descartables: [{ id: 'd1', name: 'Filtro', stock: 10 }],
  equiposNuevos: [{ id: 'e1', name: 'CPAP', stock: 1 }, { id: 'e2', name: 'Sin stock cargado' }],
});
const stockDe = (d, key, id) => d[key].find(x => x.id === id).stock;

test('facturar descuenta y borrar devuelve lo mismo', () => {
  const items = [{ id: 'm1', _cat: 'mascarillas', quantity: 1 }, { id: 'd1', _cat: 'descartables', quantity: 3 }, { id: 'e1', _cat: 'equiposNuevos', quantity: 1 }];
  const { next, items: conMarca } = descontarStock(datos(), items);
  assert.equal(stockDe(next, 'mascaras', 'm1'), 1);
  assert.equal(stockDe(next, 'descartables', 'd1'), 7);
  assert.equal(stockDe(next, 'equiposNuevos', 'e1'), 0);
  const vuelta = devolverStock(next, conMarca);
  assert.deepEqual(vuelta, { ...datos() });
});

test('vender de mas: al borrar vuelve solo lo que habia (R2C-1)', () => {
  const { next, items } = descontarStock(datos(), [{ id: 'm1', _cat: 'mascarillas', quantity: 5 }]);
  assert.equal(stockDe(next, 'mascaras', 'm1'), 0);
  assert.equal(stockDe(devolverStock(next, items), 'mascaras', 'm1'), 2);
});

test('editar: devolver la version vieja y descontar la nueva', () => {
  const v1 = descontarStock(datos(), [{ id: 'm1', _cat: 'mascarillas', quantity: 5 }]);
  const devuelto = devolverStock(v1.next, v1.items);
  const v2 = descontarStock(devuelto, [{ id: 'm1', _cat: 'mascarillas', quantity: 1 }]);
  assert.equal(stockDe(v2.next, 'mascaras', 'm1'), 1);
});

test('facturas viejas sin marca: no devuelven equipos nuevos (R2C-2)', () => {
  const viejo = [{ id: 'e1', _cat: 'equiposNuevos', quantity: 1 }, { id: 'm1', _cat: 'mascarillas', quantity: 1 }];
  const d = devolverStock(datos(), viejo);
  assert.equal(stockDe(d, 'equiposNuevos', 'e1'), 1);
  assert.equal(stockDe(d, 'mascaras', 'm1'), 3);
});

test('items sin stock cargado no se tocan', () => {
  const { next } = descontarStock(datos(), [{ id: 'e2', _cat: 'equiposNuevos', quantity: 1 }]);
  assert.equal(stockDe(next, 'equiposNuevos', 'e2'), undefined);
});

test('aviso de stock insuficiente cuenta lo que devuelve la version anterior', () => {
  const d = datos();
  assert.deepEqual(faltantesDeStock(d, [{ id: 'm1', name: 'Nasal', _cat: 'mascarillas', quantity: 3 }]), ['Nasal: pedís 3, hay 2']);
  assert.deepEqual(faltantesDeStock(d, [{ id: 'm1', name: 'Nasal', _cat: 'mascarillas', quantity: 3 }], [{ id: 'm1', _cat: 'mascarillas', quantity: 1, _descontado: 1 }]), []);
});

test('precio mensual: ignora quincenales y prefiere alquileres en curso', () => {
  const equipment = [{ id: 'a', name: 'CPAP' }, { id: 'b', name: 'CPAP', rentalPrice: 0 }];
  const rentals = [
    { equipmentId: 'a', period: 'quincenal', price: 20000, status: 'activo' },
    { equipmentId: 'a', price: 50000, status: 'finalizado' },
    { equipmentId: 'a', price: 60000, status: 'activo' },
  ];
  assert.equal(precioMensualEquipo(equipment[0], equipment, rentals), 60000);
  assert.equal(precioMensualEquipo(equipment[1], equipment, rentals), 60000);
  assert.equal(precioMensualEquipo({ id: 'z', name: 'Otro' }, equipment, rentals), 0);
});

test('fechas de Excel: serie, texto y fechas imposibles (R2C-3)', async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { fechaDeExcel, parseExcelData } = await import('../src/data/database.js');
  assert.equal(fechaDeExcel(45900), '2025-08-31');
  assert.equal(fechaDeExcel('05/10/2026'), '2026-10-05');
  assert.equal(fechaDeExcel('31/02/2026'), '');
  assert.equal(fechaDeExcel('2026-13-45'), '');
  assert.equal(fechaDeExcel('29/02/2028'), '2028-02-29');
  // Alquileres aunque la primera fila no tenga fecha (R2C-4), y nombre exacto (no "primera palabra").
  const r = parseExcelData([{ NOMBRE: 'Ana Diaz', EQUIPO: 'CPAP' }, { NOMBRE: 'Juan Perez', EQUIPO: 'CPAP', 'FECHA ALTA': '01/10/2026', importe: 100 }], [{ id: 'g', name: 'Juan Gomez' }], []);
  assert.equal(r.rentals.length, 1);
  assert.notEqual(r.rentals[0].patientId, 'g');
});

test('Excel: misma marca con dos series son dos equipos (R2B-5)', async () => {
  const { parseExcelData } = await import('../src/data/database.js');
  const r = parseExcelData([
    { NOMBRE: 'Ana Diaz', EQUIPO: 'CPAP Resmed S9', SERIE: 'AAA111', 'FECHA ALTA': '01/10/2026', importe: 100 },
    { NOMBRE: 'Juan Perez', EQUIPO: 'CPAP Resmed S9', SERIE: 'BBB222', 'FECHA ALTA': '01/10/2026', importe: 100 },
  ], [], []);
  assert.equal(r.equipment.length, 2);
  assert.notEqual(r.rentals[0].equipmentId, r.rentals[1].equipmentId);
});

test('Excel: sin serie no reusa una unidad alquilada; NOMBRECliente; importes con puntos (R3C-3/4/5)', async () => {
  const { parseExcelData, importeDeExcel } = await import('../src/data/database.js');
  assert.equal(importeDeExcel('25.000'), 25000);
  assert.equal(importeDeExcel('$ 25.000,50'), 25000.5);
  assert.equal(importeDeExcel(18000), 18000);
  assert.equal(importeDeExcel('x'), 0);
  const existentes = [{ id: 'eqA', name: 'CPAP Tango', serialNumber: '001' }];
  const r = parseExcelData([
    { NOMBRECliente: 'Ana Diaz', EQUIPO: 'CPAP Tango', 'FECHA ALTA': '01/10/2026', importe: '25.000' },
    { NOMBRE: 'Juan Perez', EQUIPO: 'CPAP Tango', 'FECHA ALTA': '01/10/2026', importe: 100 },
  ], [], existentes, [{ equipmentId: 'eqA', status: 'activo' }]);
  assert.equal(r.rentals.length, 2);
  assert.ok(r.rentals.every(x => x.equipmentId && x.equipmentId !== 'eqA'));
  assert.notEqual(r.rentals[0].equipmentId, r.rentals[1].equipmentId);
  assert.ok(r.rentals[0].patientId);
  assert.equal(r.rentals[0].price, 25000);
  assert.ok(r.equipment.every(e => typeof e.serialNumber === 'string'));
});

test('importes con punto decimal o de miles (R4B-2)', async () => {
  const { importeDeExcel } = await import('../src/data/database.js');
  assert.equal(importeDeExcel('1070.5'), 1070.5);
  assert.equal(importeDeExcel('25000.50'), 25000.5);
  assert.equal(importeDeExcel('1.500.000'), 1500000);
  assert.equal(importeDeExcel('1.012,00'), 1012);
  assert.equal(importeDeExcel('25.000'), 25000);
});

test('importe con coma de miles y punto decimal (R5B-5)', async () => {
  const { importeDeExcel } = await import('../src/data/database.js');
  assert.equal(importeDeExcel('1,500.00'), 1500);
});

test('editar factura vieja no descuenta de nuevo equipos nuevos (R6B-1)', async () => {
  const { itemsADescontar, devolverStock: dev, descontarStock: des } = await import('../src/data/stock.js');
  const d = { equiposNuevos: [{ id: 'e', stock: 2 }], mascaras: [{ id: 'm', stock: 5 }] };
  const viejo = [{ id: 'e', _cat: 'equiposNuevos', quantity: 1 }, { id: 'm', _cat: 'mascarillas', quantity: 1 }];
  const r = des(dev(d, viejo), itemsADescontar(viejo, viejo));
  assert.equal(r.next.equiposNuevos[0].stock, 2);
  assert.equal(r.next.mascaras[0].stock, 5);
  assert.equal(r.items[0].quantity, 1);
  assert.equal(r.items[0]._descontado, 0);
  // Si se agrega una unidad mas del equipo, esa SI se descuenta.
  const r2 = des(dev(d, viejo), itemsADescontar([{ ...viejo[0], quantity: 2 }], viejo));
  assert.equal(r2.next.equiposNuevos[0].stock, 1);
});

test('importe 1,500,000 (R6B-3)', async () => {
  const { importeDeExcel } = await import('../src/data/database.js');
  assert.equal(importeDeExcel('1,500,000'), 1500000);
});

test('factura nueva mixta editada no devuelve stock de mas (R7-1)', () => {
  const d = { equiposNuevos: [{ id: 'e1', stock: 5 }, { id: 'e2', name: 'sin stock' }] };
  const items = [{ id: 'e1', _cat: 'equiposNuevos', quantity: 1 }, { id: 'e2', _cat: 'equiposNuevos', quantity: 1 }];
  const f1 = descontarStock(d, items);
  assert.equal(f1.next.equiposNuevos[0].stock, 4);
  let estado = f1.next; let guardados = f1.items;
  for (let i = 0; i < 3; i++) {
    const r = descontarStock(devolverStock(estado, guardados), itemsADescontarImp(items, guardados));
    estado = r.next; guardados = r.items;
    assert.equal(estado.equiposNuevos[0].stock, 4);
  }
  assert.equal(devolverStock(estado, guardados).equiposNuevos[0].stock, 5);
});

test('factura vieja editada dos veces y borrada (R7-2/R7-3)', () => {
  const d = { equiposNuevos: [{ id: 'e1', name: 'CPAP', stock: 5 }], mascaras: [{ id: 'm', stock: 5 }] };
  const viejo = [{ id: 'e1', name: 'CPAP', _cat: 'equiposNuevos', quantity: 2 }, { id: 'm', _cat: 'mascarillas', quantity: 1 }];
  let estado = d; let guardados = viejo;
  for (let i = 0; i < 2; i++) {
    const r = descontarStock(devolverStock(estado, guardados), itemsADescontarImp(viejo, guardados));
    estado = r.next; guardados = r.items;
    assert.equal(estado.equiposNuevos[0].stock, 5);
    assert.equal(estado.mascaras[0].stock, 5);
  }
  assert.equal(devolverStock(estado, guardados).equiposNuevos[0].stock, 5);
  // Sin aviso falso de stock al editarla (no se va a descontar nada del equipo).
  assert.deepEqual(faltantesDeStock({ equiposNuevos: [{ id: 'e1', stock: 1 }], mascaras: [{ id: 'm', stock: 5 }] }, viejo, viejo), []);
});

test('vendido de mas y luego repuesto: editar sin cambios no descuenta lo que falto (R8-1)', () => {
  const d = { mascaras: [{ id: 'm', name: 'Nasal', stock: 2 }] };
  const items = [{ id: 'm', name: 'Nasal', _cat: 'mascarillas', quantity: 5 }];
  const f = descontarStock(d, items);
  assert.equal(f.next.mascaras[0].stock, 0);
  const repuesto = { mascaras: [{ ...f.next.mascaras[0], stock: 10 }] };
  const e = descontarStock(devolverStock(repuesto, f.items), itemsADescontarImp(items, f.items));
  assert.equal(e.next.mascaras[0].stock, 10);
  assert.equal(devolverStock(e.next, e.items).mascaras[0].stock, 12);
});
