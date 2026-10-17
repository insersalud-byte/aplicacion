// Pruebas de la logica de baja. Correr con: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarBaja, marcarRemitoRetiro, reactivarAlquiler, sellarFinalizacion, estadoRemitoRetiro, datosRemitoRetiro } from '../src/data/bajas.js';

const base = () => ({
  patients: [{ id: 'p1', name: 'PEREZ, Ana', phone: '351111', address: 'Calle 1', dni: '30111222' }],
  equipment: [{ id: 'e1', name: 'CPAP X', serialNumber: 'SN1' }, { id: 'e2', name: 'Mochila', serialNumber: 'SN2' }],
  rentals: [
    { id: 'r1', patientId: 'p1', equipmentId: 'e1', status: 'vencido', period: 'quincenal', endDate: '2026-10-10' },
    { id: 'r2', patientId: 'p1', equipmentId: 'e2', status: 'activo', period: 'mensual', endDate: '2026-11-10' },
  ],
  settings: {},
});
const AHORA = '2026-10-17T20:00:00.000Z';
const gen = (prefijo, nombre) => `${prefijo}-${nombre.split(',')[0].toUpperCase()}-X1`;

test('aplicarBaja finaliza, sella la fecha y deja el remito pendiente sin tocar el resto', () => {
  const d = base();
  const n = aplicarBaja(d, 'r1', AHORA);
  const r1 = n.rentals.find(r => r.id === 'r1');
  assert.equal(r1.status, 'finalizado');
  assert.equal(r1.finalizedAt, AHORA);
  assert.equal(r1.remitoRetiroPendiente, true);
  assert.equal(n.rentals.find(r => r.id === 'r2').status, 'activo');
  assert.equal(d.rentals[0].status, 'vencido', 'no muta el original');
  assert.equal(estadoRemitoRetiro(r1), 'pendiente');
});

test('aplicarBaja sobre un alquiler ya finalizado o inexistente devuelve el mismo objeto', () => {
  const d = aplicarBaja(base(), 'r1', AHORA);
  assert.equal(aplicarBaja(d, 'r1', '2030-01-01T00:00:00.000Z'), d);
  assert.equal(d.rentals.find(r => r.id === 'r1').finalizedAt, AHORA, 'no pisa la fecha de baja');
  assert.equal(aplicarBaja(d, 'no-existe', AHORA), d);
  const sinLista = { patients: [] };
  assert.equal(aplicarBaja(sinLista, 'r1', AHORA), sinLista);
});

test('marcarRemitoRetiro saca el pendiente y guarda numero y fecha', () => {
  const baja = aplicarBaja(base(), 'r1', AHORA);
  const n = marcarRemitoRetiro(baja, 'r1', { numero: 'RET-PEREZ-X1', fecha: '2026-10-17' });
  const r1 = n.rentals.find(r => r.id === 'r1');
  assert.equal(r1.remitoRetiroPendiente, undefined);
  assert.deepEqual(r1.remitoRetiro, { numero: 'RET-PEREZ-X1', fecha: '2026-10-17' });
  assert.equal(estadoRemitoRetiro(r1), 'emitido');
  assert.equal(n.rentals.find(r => r.id === 'r2').remitoRetiro, undefined);
});

test('estadoRemitoRetiro: en curso no aplica y una baja vieja es "sin dato"', () => {
  assert.equal(estadoRemitoRetiro({ status: 'activo' }), null);
  assert.equal(estadoRemitoRetiro(null), null);
  assert.equal(estadoRemitoRetiro({ status: 'finalizado', finalizedAt: AHORA }), 'sin dato');
});

test('reactivar limpia las marcas: la proxima baja genera un remito nuevo', () => {
  const emitido = marcarRemitoRetiro(aplicarBaja(base(), 'r1', AHORA), 'r1', { numero: 'RET-A', fecha: '2026-10-17' });
  const r = reactivarAlquiler({ ...emitido.rentals[0], status: 'activo' });
  assert.equal(r.remitoRetiro, undefined);
  assert.equal(r.remitoRetiroPendiente, undefined);
  const segunda = aplicarBaja({ ...emitido, rentals: [r, emitido.rentals[1]] }, 'r1', '2026-11-01T12:00:00.000Z');
  assert.equal(datosRemitoRetiro(segunda, segunda.rentals[0], { hoy: '2026-11-01', generarNumero: () => 'RET-B' }).numero, 'RET-B');
});

test('datosRemitoRetiro arma el remito con paciente, equipo y periodo', () => {
  const d = base();
  const datos = datosRemitoRetiro(d, d.rentals[0], { hoy: '2026-10-17', generarNumero: gen });
  assert.equal(datos.tipo, 'retiro');
  assert.equal(datos.paciente, 'PEREZ, Ana');
  assert.equal(datos.dni, '30111222');
  assert.deepEqual(datos.equipos, [{ name: 'CPAP X', serialNumber: 'SN1', periodo: 'quincenal' }]);
  assert.equal(datos.fecha, '2026-10-17');
  assert.equal(datos.numero, 'RET-PEREZ-X1');
  assert.equal(datos.faltaEquipo, false);
});

test('datosRemitoRetiro reutiliza numero y fecha de un remito ya emitido', () => {
  const d = marcarRemitoRetiro(aplicarBaja(base(), 'r1', AHORA), 'r1', { numero: 'RET-ORIGINAL', fecha: '2026-10-17' });
  const datos = datosRemitoRetiro(d, d.rentals[0], { hoy: '2026-12-31', generarNumero: () => 'RET-NUEVO' });
  assert.equal(datos.numero, 'RET-ORIGINAL');
  assert.equal(datos.fecha, '2026-10-17');
});

test('datosRemitoRetiro sin equipo en el sistema avisa y no deja el remito en blanco', () => {
  const d = base();
  const datos = datosRemitoRetiro(d, { ...d.rentals[0], equipmentId: 'borrado' }, { hoy: '2026-10-17', generarNumero: gen });
  assert.equal(datos.faltaEquipo, true);
  assert.equal(datos.equipos.length, 1);
  assert.match(datos.equipos[0].name, /no encontrado/i);
});

test('datosRemitoRetiro sin paciente usa un nombre por defecto', () => {
  const d = base();
  const datos = datosRemitoRetiro(d, { ...d.rentals[0], patientId: 'borrado' }, { hoy: '2026-10-17', generarNumero: gen });
  assert.equal(datos.paciente, 'Sin paciente');
  assert.equal(datos.telefono, '');
});

test('con datos nulos o sin lista las funciones no inventan un estado vacio', () => {
  assert.equal(aplicarBaja(null, 'r1', AHORA), null);
  assert.equal(aplicarBaja(undefined, 'r1', AHORA), undefined);
  assert.equal(marcarRemitoRetiro(null, 'r1', { numero: 'X', fecha: '2026-10-17' }), null);
  const sinLista = { patients: [] };
  assert.equal(marcarRemitoRetiro(sinLista, 'r1', { numero: 'X', fecha: '2026-10-17' }), sinLista);
});

test('aplicarBaja ignora un id indefinido', () => {
  const d = { rentals: [{ id: undefined, status: 'activo' }] };
  assert.equal(aplicarBaja(d, undefined, AHORA), d);
});

test('marcarRemitoRetiro no toca alquileres que no estan finalizados ni inexistentes', () => {
  const d = base();
  assert.equal(marcarRemitoRetiro(d, 'r2', { numero: 'X', fecha: '2026-10-17' }), d, 'activo: no se marca');
  assert.equal(marcarRemitoRetiro(d, 'no-existe', { numero: 'X', fecha: '2026-10-17' }), d);
});

test('marcarRemitoRetiro con la misma marca devuelve el mismo objeto (no hay guardado de mas)', () => {
  const emitido = marcarRemitoRetiro(aplicarBaja(base(), 'r1', AHORA), 'r1', { numero: 'RET-A', fecha: '2026-10-17' });
  assert.equal(marcarRemitoRetiro(emitido, 'r1', { numero: 'RET-A', fecha: '2026-10-17' }), emitido);
});

test('si el navegador no dejo bajar el PDF el numero se guarda pero sigue pendiente', () => {
  const baja = aplicarBaja(base(), 'r1', AHORA);
  const n = marcarRemitoRetiro(baja, 'r1', { numero: 'RET-A', fecha: '2026-10-17', pendiente: true });
  const r1 = n.rentals.find(r => r.id === 'r1');
  assert.equal(r1.remitoRetiro.numero, 'RET-A');
  assert.equal(r1.remitoRetiroPendiente, true);
  assert.equal(estadoRemitoRetiro(r1), 'pendiente');
  // Al reintentar con exito: mismo numero (datosRemitoRetiro lo reutiliza) y ya no esta pendiente.
  const datos = datosRemitoRetiro(n, r1, { hoy: '2026-10-20', generarNumero: () => 'OTRO' });
  assert.equal(datos.numero, 'RET-A');
  assert.equal(datos.esCopia, false, 'reintentar un pendiente no es una copia');
  const ok = marcarRemitoRetiro(n, 'r1', { numero: datos.numero, fecha: datos.fecha });
  assert.equal(estadoRemitoRetiro(ok.rentals.find(r => r.id === 'r1')), 'emitido');
});

test('datosRemitoRetiro lleva la fecha de la baja y marca como copia lo ya emitido', () => {
  const d = base();
  const baja = { ...d.rentals[0], status: 'finalizado', finalizedAt: new Date(2026, 9, 13, 10, 0, 0).toISOString() };
  const datos = datosRemitoRetiro(d, baja, { hoy: '2026-10-17', generarNumero: gen });
  assert.equal(datos.fecha, '2026-10-13', 'un remito pendiente generado dias despues lleva la fecha del retiro');
  assert.equal(datos.esCopia, false);
  const emitido = { ...baja, remitoRetiro: { numero: 'RET-OK', fecha: '2026-10-13' } };
  assert.equal(datosRemitoRetiro(d, emitido, { hoy: '2026-10-17', generarNumero: gen }).esCopia, true);
  const sinFecha = datosRemitoRetiro(d, { ...baja, finalizedAt: 'basura' }, { hoy: '2026-10-17', generarNumero: gen });
  assert.equal(sinFecha.fecha, '2026-10-17', 'una fecha ilegible cae en hoy');
});

test('sellarFinalizacion cubre alta, transicion, ya finalizado y reactivacion', () => {
  const activo = { id: 'r1', status: 'activo' };
  // en curso -> finalizado: fecha nueva y remito pendiente
  const t = sellarFinalizacion(activo, { ...activo, status: 'finalizado', finalizedAt: 'vieja' }, AHORA);
  assert.equal(t.finalizedAt, AHORA);
  assert.equal(t.remitoRetiroPendiente, true);
  // ya finalizado: conserva fecha y marcas
  const fin = { id: 'r1', status: 'finalizado', finalizedAt: '2026-10-01T00:00:00.000Z', remitoRetiro: { numero: 'RET-X', fecha: '2026-10-01' } };
  const igual = sellarFinalizacion(fin, { ...fin, notes: 'editado' }, AHORA);
  assert.equal(igual.finalizedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(igual.remitoRetiro.numero, 'RET-X');
  // finalizado sin fecha (baja vieja) editado otra vez: se le pone la de ahora
  assert.equal(sellarFinalizacion({ id: 'r1', status: 'finalizado' }, { id: 'r1', status: 'finalizado' }, AHORA).finalizedAt, AHORA);
  // reactivado: se limpian las marcas del remito
  const react = sellarFinalizacion(fin, { ...fin, status: 'activo' }, AHORA);
  assert.equal(react.remitoRetiro, undefined);
  assert.equal(react.remitoRetiroPendiente, undefined);
  // alta (sin anterior) de un registro en curso: queda igual; finalizado: solo se sella
  const nuevo = { id: 'n1', status: 'activo' };
  assert.equal(sellarFinalizacion(undefined, nuevo, AHORA), nuevo);
  const altaFin = sellarFinalizacion(undefined, { id: 'n2', status: 'finalizado' }, AHORA);
  assert.equal(altaFin.finalizedAt, AHORA);
  assert.equal(altaFin.remitoRetiroPendiente, undefined, 'un alta no genera remito de retiro');
});

test('reactivar borra la fecha de baja: la segunda baja lleva su propia fecha en el remito', () => {
  const d = base();
  const primera = aplicarBaja(d, 'r1', new Date(2026, 9, 1, 10, 0, 0).toISOString());
  const emitida = marcarRemitoRetiro(primera, 'r1', { numero: 'RET-1RA', fecha: '2026-10-01' });
  // se reactiva con Editar y se vuelve a dar de baja
  const reactivado = sellarFinalizacion(emitida.rentals[0], { ...emitida.rentals[0], status: 'activo' }, AHORA);
  assert.equal(reactivado.finalizedAt, undefined);
  assert.equal(reactivado.remitoRetiro, undefined);
  const segunda = aplicarBaja({ ...emitida, rentals: [reactivado, emitida.rentals[1]] }, 'r1', new Date(2026, 9, 17, 18, 0, 0).toISOString());
  const rec = segunda.rentals.find(r => r.id === 'r1');
  const datos = datosRemitoRetiro(segunda, rec, { hoy: '2026-10-17', generarNumero: () => 'RET-2DA' });
  assert.equal(datos.fecha, '2026-10-17');
  assert.equal(datos.numero, 'RET-2DA');
});

test('guardar un formulario viejo de un alquiler finalizado no pisa las marcas del remito de la base', () => {
  const enBase = { id: 'r1', status: 'finalizado', finalizedAt: '2026-10-17T20:00:00.000Z', remitoRetiro: { numero: 'RET-OK', fecha: '2026-10-17' } };
  // el formulario se abrio cuando el remito todavia estaba pendiente
  const formularioViejo = { id: 'r1', status: 'finalizado', finalizedAt: '2026-10-17T20:00:00.000Z', remitoRetiroPendiente: true, notes: 'editado' };
  const r = sellarFinalizacion(enBase, formularioViejo, AHORA);
  assert.deepEqual(r.remitoRetiro, { numero: 'RET-OK', fecha: '2026-10-17' });
  assert.equal(r.remitoRetiroPendiente, undefined);
  assert.equal(r.notes, 'editado');
  // y al reves: si en la base sigue pendiente, el formulario no lo "emite"
  const pendienteEnBase = { id: 'r1', status: 'finalizado', finalizedAt: '2026-10-17T20:00:00.000Z', remitoRetiroPendiente: true };
  const r2 = sellarFinalizacion(pendienteEnBase, { ...pendienteEnBase, remitoRetiro: { numero: 'FALSO', fecha: 'x' }, remitoRetiroPendiente: undefined }, AHORA);
  assert.equal(r2.remitoRetiro, undefined);
  assert.equal(r2.remitoRetiroPendiente, true);
});

test('una copia sale con el detalle que tenia el remito aunque despues se borre el equipo', () => {
  const d = base();
  const baja = aplicarBaja(d, 'r1', AHORA);
  const original = datosRemitoRetiro(baja, baja.rentals[0], { hoy: '2026-10-17', generarNumero: gen });
  const emitido = marcarRemitoRetiro(baja, 'r1', { numero: original.numero, fecha: original.fecha, equipos: original.equipos });
  assert.deepEqual(emitido.rentals[0].remitoRetiro.equipos, [{ name: 'CPAP X', serialNumber: 'SN1', periodo: 'quincenal' }]);
  // despues se elimina el equipo del sistema
  const sinEquipo = { ...emitido, equipment: [] };
  const copia = datosRemitoRetiro(sinEquipo, sinEquipo.rentals[0], { hoy: '2026-12-01', generarNumero: () => 'OTRO' });
  assert.deepEqual(copia.equipos, original.equipos);
  assert.equal(copia.faltaEquipo, false);
  assert.equal(copia.numero, original.numero);
  assert.equal(copia.esCopia, true);
});

test('sin equipo no se congela el aviso: el remito queda pendiente y se rehace cuando el equipo vuelve', () => {
  const d = base();
  const baja = aplicarBaja({ ...d, equipment: [] }, 'r1', AHORA);
  const datos = datosRemitoRetiro(baja, baja.rentals[0], { hoy: '2026-10-17', generarNumero: gen });
  assert.equal(datos.faltaEquipo, true);
  const n = marcarRemitoRetiro(baja, 'r1', { numero: datos.numero, fecha: datos.fecha, pendiente: true, equipos: undefined });
  const r1 = n.rentals[0];
  assert.equal(r1.remitoRetiro.equipos, undefined);
  assert.equal(estadoRemitoRetiro(r1), 'pendiente');
  // el equipo vuelve a existir: mismo numero, ahora con el equipo real, y se congela
  const rehecho = datosRemitoRetiro({ ...n, equipment: d.equipment }, r1, { hoy: '2026-10-18', generarNumero: () => 'OTRO' });
  assert.equal(rehecho.numero, datos.numero);
  assert.equal(rehecho.faltaEquipo, false);
  assert.equal(rehecho.equipos[0].name, 'CPAP X');
  const ok = marcarRemitoRetiro(n, 'r1', { numero: rehecho.numero, fecha: rehecho.fecha, equipos: rehecho.equipos });
  assert.equal(estadoRemitoRetiro(ok.rentals[0]), 'emitido');
  assert.equal(ok.rentals[0].remitoRetiro.equipos.length, 1);
});
