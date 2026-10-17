// Aviso "el remito esta listo". Quien arma un remito (Inicio, Alquileres) lo publica
// aca y la app muestra una ventana con el boton Descargar: un clic del usuario siempre
// puede bajar el PDF, aunque el navegador haya bloqueado la descarga automatica.

const _oyentes = new Set();

export function onRemitoListo(fn) {
  _oyentes.add(fn);
  return () => _oyentes.delete(fn);
}

export function avisarRemitoListo(info) {
  _oyentes.forEach(fn => fn(info));
}
