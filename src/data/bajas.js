// Baja de un alquiler: logica pura, sin React ni red, para poder probarla sola.
//
// Una baja SIEMPRE deja rastro en el alquiler:
//   status 'finalizado' + finalizedAt  -> el alquiler pasa a Finalizados y el equipo
//                                         queda libre (la disponibilidad se deriva de los alquileres).
//   remitoRetiroPendiente: true        -> todavia no se genero el remito de retiro.
//   remitoRetiro: { numero, fecha }    -> el remito ya se genero (queda el numero para reimprimirlo igual).
// Asi, si el remito no sale (error, descarga bloqueada), la lista lo muestra como pendiente
// y se puede emitir despues. Borrar el alquiler, en cambio, no deja nada.

function sinMarcasDeRemito(rental) {
  const copia = { ...rental };
  delete copia.remitoRetiro;
  delete copia.remitoRetiroPendiente;
  return copia;
}

const hayLista = (data) => Boolean(data) && Array.isArray(data.rentals);

// Marca el alquiler como finalizado. Si no existe o ya estaba finalizado devuelve
// el MISMO objeto `data` (no pisa finalizedAt ni genera un segundo remito).
export function aplicarBaja(data, rentalId, ahoraIso) {
  if (!hayLista(data) || rentalId == null) return data;
  const rental = data.rentals.find(r => r.id === rentalId);
  if (!rental || rental.status === 'finalizado') return data;
  return {
    ...data,
    rentals: data.rentals.map(r => (r.id === rentalId
      ? { ...sinMarcasDeRemito(r), status: 'finalizado', finalizedAt: ahoraIso, remitoRetiroPendiente: true }
      : r)),
  };
}

// Anota el remito de retiro que se genero: guarda numero y fecha (asi una nueva copia
// sale con el MISMO numero) y saca el pendiente. Si el navegador no dejo bajar el PDF
// (`pendiente: true`) el numero queda guardado pero el alquiler sigue pendiente.
// Solo marca alquileres finalizados; si no hay nada que cambiar devuelve el MISMO `data`.
// `equipos` (opcional) es el detalle impreso en el remito: se guarda para que una copia
// posterior diga lo mismo aunque despues se borre o renombre el equipo.
export function marcarRemitoRetiro(data, rentalId, { numero, fecha, pendiente = false, equipos }) {
  if (!hayLista(data)) return data;
  const objetivo = data.rentals.find(r => r.id === rentalId);
  if (!objetivo || objetivo.status !== 'finalizado') return data;
  const previo = objetivo.remitoRetiro;
  const igual = previo && previo.numero === numero && previo.fecha === fecha && (!equipos || Boolean(previo.equipos));
  if (igual && Boolean(objetivo.remitoRetiroPendiente) === pendiente) return data;
  return {
    ...data,
    rentals: data.rentals.map(r => {
      if (r.id !== rentalId) return r;
      const copia = { ...r, remitoRetiro: equipos && equipos.length ? { numero, fecha, equipos } : { numero, fecha } };
      if (pendiente) copia.remitoRetiroPendiente = true;
      else delete copia.remitoRetiroPendiente;
      return copia;
    }),
  };
}

// Un alquiler que vuelve a estar en curso deja de tener baja: se borran su fecha de baja
// y las marcas del remito de retiro. Si se da de baja otra vez, corresponde una fecha y un
// remito nuevos (antes quedaba la fecha vieja y el remito salia con ella).
export function reactivarAlquiler(rental) {
  const copia = sinMarcasDeRemito(rental);
  delete copia.finalizedAt;
  return copia;
}

// Como queda un alquiler al GUARDAR el formulario de edicion. `anterior` es el registro
// tal como esta en la base (undefined si es un alta) y `nuevo` el que sale del formulario.
//  - pasa de en curso a finalizado: se sella la fecha y queda el remito de retiro pendiente
//  - ya estaba finalizado: conserva su fecha de baja y sus marcas, tomadas del registro de
//    la base (el formulario pudo abrirse antes de que el remito se marcara)
//  - vuelve a estar en curso: se limpian las marcas del remito
export function sellarFinalizacion(anterior, nuevo, ahoraIso) {
  if (nuevo.status !== 'finalizado') {
    return anterior && anterior.status === 'finalizado' ? reactivarAlquiler(nuevo) : nuevo;
  }
  if (!anterior) return { ...nuevo, finalizedAt: nuevo.finalizedAt || ahoraIso };
  if (anterior.status === 'finalizado') {
    const resultado = { ...sinMarcasDeRemito(nuevo), finalizedAt: anterior.finalizedAt || nuevo.finalizedAt || ahoraIso };
    if (anterior.remitoRetiro) resultado.remitoRetiro = anterior.remitoRetiro;
    if (anterior.remitoRetiroPendiente) resultado.remitoRetiroPendiente = anterior.remitoRetiroPendiente;
    return resultado;
  }
  return { ...reactivarAlquiler(nuevo), finalizedAt: ahoraIso, remitoRetiroPendiente: true };
}

// Estado del remito de retiro de un alquiler finalizado:
//   'pendiente' -> se dio de baja y el remito no llego a generarse o a bajarse
//   'emitido'   -> hay numero guardado y se genero bien
//   'sin dato'  -> bajas anteriores a esta marca (no se sabe)
export function estadoRemitoRetiro(rental) {
  if (!rental || rental.status !== 'finalizado') return null;
  if (rental.remitoRetiroPendiente) return 'pendiente';
  if (rental.remitoRetiro && rental.remitoRetiro.numero) return 'emitido';
  return 'sin dato';
}

// Dia (YYYY-MM-DD, hora local) en que se dio de baja. null si no se sabe.
function diaDeBaja(finalizedAt) {
  const d = new Date(finalizedAt);
  if (!finalizedAt || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Datos para generateRemitoEquipoPDF. El remito deja constancia del retiro, asi que lleva la
// fecha de la baja (o la de hoy si no se sabe) aunque se genere dias despues. Si ya se emitio,
// conserva su numero y su fecha: una copia es el MISMO documento, no uno nuevo. `hoy` y
// `generarNumero` vienen de afuera para que esta funcion siga siendo pura.
export function datosRemitoRetiro(data, rental, { hoy, generarNumero }) {
  const patients = Array.isArray(data && data.patients) ? data.patients : [];
  const equipment = Array.isArray(data && data.equipment) ? data.equipment : [];
  const p = patients.find(x => x.id === rental.patientId);
  const e = equipment.find(x => x.id === rental.equipmentId);
  const previo = rental.remitoRetiro && rental.remitoRetiro.numero ? rental.remitoRetiro : null;
  const congelado = previo && Array.isArray(previo.equipos) && previo.equipos.length ? previo.equipos : null;
  return {
    tipo: 'retiro',
    paciente: (p && p.name) || 'Sin paciente',
    telefono: (p && p.phone) || '',
    direccion: (p && p.address) || '',
    dni: (p && p.dni) || '',
    // Un remito ya emitido sale con el detalle que tenia. Sin equipo no se puede dejar el
    // remito en blanco: sale con una linea que lo avisa.
    equipos: congelado
      ? congelado
      : e
        ? [{ name: e.name, serialNumber: e.serialNumber, periodo: rental.period === 'quincenal' ? 'quincenal' : 'mensual' }]
        : [{ name: 'Equipo no encontrado en el sistema (revisar)' }],
    faltaEquipo: !congelado && !e,
    fecha: (previo && previo.fecha) || diaDeBaja(rental.finalizedAt) || hoy,
    numero: previo ? previo.numero : generarNumero('RET', (p && p.name) || ''),
    // Copia = otra impresion de un remito que ya se bajo bien (no el reintento de uno pendiente).
    esCopia: Boolean(previo) && !rental.remitoRetiroPendiente,
  };
}
