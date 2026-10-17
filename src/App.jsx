import { useState, useEffect, useRef, useCallback } from 'react';
import { loadData, saveData, generateId, generateDocNumber, getToday, toLocalDateStr, formatDate, formatCurrency, getDaysUntilEnd, parseExcelData, sendWhatsApp, generateInvoicePDF, downloadInvoicePDF, generateRemitoEquipoPDF, subirFoto, onSyncStatus, getSyncStatus, onDataChange, syncIfRemoteChanged, login, logout, getSessionToken, onAuthRequired, hayCambiosSinSubir, cambiarClave } from './data/database';
import { Icon, EquipoFoto, Avatar } from './ui';
import { aplicarBaja, marcarRemitoRetiro, sellarFinalizacion, estadoRemitoRetiro, datosRemitoRetiro } from './data/bajas';
import { onRemitoListo, avisarRemitoListo } from './data/remitoAviso';
import './App.css';

// ── Remitos de alquiler (entrega / retiro) ──────────────────────────────────
// Baja de un alquiler: finaliza, libera el equipo y emite el remito de retiro.
// Antes habia dos copias de este codigo (Inicio y Alquileres) y el remito se
// descargaba "a ciegas": si el navegador bloqueaba la descarga no pasaba nada.

// Baja el PDF. Devuelve 'descargado', 'pestana' (se abrio en otra pestana) o 'fallo'.
function descargarPDF(doc, nombre) {
  try {
    doc.save(nombre);
    return 'descargado';
  } catch (err) {
    console.error('remito: fallo la descarga', err);
    try {
      const win = window.open(doc.output('bloburl'), '_blank');
      if (win) return 'pestana';
    } catch (err2) {
      console.error('remito: fallo abrir en pestana', err2);
    }
    return 'fallo';
  }
}

// Arma el PDF, lo baja y avisa con una ventana que tiene el boton Descargar.
// Devuelve { ok: true, via } o { ok: false, error }.
async function armarYEntregarRemito(datos, settings, { bajaNueva = false } = {}) {
  let doc;
  try {
    doc = await generateRemitoEquipoPDF(datos, settings || {});
  } catch (err) {
    console.error('remito: fallo al armar el PDF', err);
    return { ok: false, error: err };
  }
  const nombre = `Remito_${datos.tipo === 'retiro' ? 'Retiro' : 'Entrega'}_${datos.numero}.pdf`;
  const via = descargarPDF(doc, nombre);
  avisarRemitoListo({ tipo: datos.tipo, numero: datos.numero, paciente: datos.paciente, esCopia: Boolean(datos.esCopia), bajaNueva, doc, nombre, via });
  return { ok: true, via };
}

// Remito de retiro de un alquiler ya finalizado. Si ya se habia emitido, reutiliza
// el mismo numero y fecha. `rental` es el registro YA finalizado (con su fecha de baja);
// `data` solo aporta paciente, equipo y datos de la empresa.
// `bajaNueva`: la baja se registro recien (cambia el titulo del aviso y el texto del error).
// Si el navegador no dejo bajar el PDF, el numero queda guardado pero el alquiler sigue
// como "Remito pendiente" hasta que se descargue bien.
// Alquileres con un remito de retiro armandose. Armar el PDF puede tardar unos segundos
// (la primera vez carga la libreria): si se toca "Remito" justo entonces, saldria un
// segundo numero para la misma baja.
const remitosEnCurso = new Set();

async function emitirRemitoRetiro(rental, data, updateData, { bajaNueva = false } = {}) {
  if (remitosEnCurso.has(rental.id)) {
    alert('El remito de este alquiler ya se está generando. Esperá unos segundos.');
    return false;
  }
  remitosEnCurso.add(rental.id);
  try {
    const datos = datosRemitoRetiro(data, rental, { hoy: getToday(), generarNumero: generateDocNumber });
    const res = await armarYEntregarRemito(datos, data.settings, { bajaNueva });
    if (!res.ok) {
      alert((bajaNueva ? 'La baja quedó registrada, pero NO se pudo armar el remito de retiro.' : 'NO se pudo armar el remito de retiro.')
        + '\n\nMotivo: ' + (res.error && res.error.message ? res.error.message : res.error)
        + '\n\nPodés reintentarlo con el botón "Remito" del alquiler (en Alquileres, filtro Finalizado).');
      return false;
    }
    // Una copia de un remito ya emitido no cambia nada: el registro ya tiene su numero y fecha.
    // Un remito sin equipo (el equipo ya no existe) tampoco es valido: queda pendiente.
    if (!datos.esCopia) {
      try {
        updateData(cur => marcarRemitoRetiro(cur, rental.id, {
          numero: datos.numero,
          fecha: datos.fecha,
          pendiente: res.via === 'fallo' || datos.faltaEquipo,
          // Se guarda el detalle impreso, salvo el aviso de "equipo no encontrado".
          equipos: datos.faltaEquipo ? undefined : datos.equipos,
        }));
      } catch (err) {
        // La sesion vencio mientras se armaba el PDF: la baja ya estaba guardada y queda "pendiente".
        console.error('remito: no se pudo anotar el numero', err);
      }
    }
    if (datos.faltaEquipo) {
      alert('El remito de retiro salió, pero el equipo de este alquiler ya no existe en el sistema: figura como "Equipo no encontrado". Revisalo antes de entregarlo.'
        + (datos.esCopia ? '' : ' El alquiler queda con "Remito pendiente".'));
    }
    return true;
  } finally {
    remitosEnCurso.delete(rental.id);
  }
}

// Da de baja un alquiler (finaliza + remito de retiro). Los pedidos de confirmacion
// los hace quien llama. Devuelve false si no se pudo dar de baja.
async function darDeBajaAlquiler(rental, data, updateData) {
  let dadoDeBaja = null;
  try {
    updateData(cur => {
      const siguiente = aplicarBaja(cur, rental.id, new Date().toISOString());
      if (siguiente !== cur) dadoDeBaja = siguiente.rentals.find(r => r.id === rental.id);
      return siguiente;
    });
  } catch (err) {
    console.error('baja: sin datos cargados', err);
    alert('No se dio de baja: la sesión venció. Ingresá de nuevo a la app y repetí la baja.');
    return false;
  }
  if (!dadoDeBaja) {
    alert('No se dio de baja: ese alquiler ya estaba dado de baja o ya no existe.');
    return false;
  }
  // El remito se arma con el registro ya finalizado (fecha de baja de ahora, sin marcas viejas).
  return emitirRemitoRetiro(dadoDeBaja, data, updateData, { bajaNueva: true });
}

// Ventana "remito listo": el clic en Descargar siempre puede bajar el PDF. Puede haber
// mas de un remito a la vez (retiro del que se finaliza + entrega de equipos agregados).
function RemitoListoModal({ items, onClose }) {
  const unico = items.length === 1 ? items[0] : null;
  const titulo = !unico ? 'Remitos generados'
    : unico.tipo !== 'retiro' ? 'Remito de entrega generado'
      : unico.bajaNueva ? 'Baja registrada'
        : unico.esCopia ? 'Copia del remito de retiro' : 'Remito de retiro generado';
  // Chrome bloquea en silencio las descargas automaticas que no nacen de un clic, y la app
  // no puede detectarlo: por eso el texto no afirma que se haya descargado.
  const mensajeDe = (via) => (via === 'pestana'
    ? 'No se pudo descargar automáticamente y el remito se abrió en otra pestaña. También podés tocar "Descargar PDF".'
    : via === 'fallo'
      ? 'No se pudo descargar automáticamente. Tocá "Descargar PDF".'
      : 'Se intentó descargar automáticamente. Si no aparece en tus descargas, tocá "Descargar PDF".');
  const descargar = (info) => {
    try { info.doc.save(info.nombre); } catch (e) { console.error(e); alert('No se pudo descargar: ' + (e && e.message ? e.message : e)); }
  };
  useEffect(() => {
    const alTeclear = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [onClose]);
  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 460 }} role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="modal-header">
          <h3 className="modal-title">{titulo}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        {items.map((info, i) => (
          <div key={info.numero + i} style={{ marginBottom: 16, paddingBottom: 14, borderBottom: i < items.length - 1 ? '1px solid var(--line)' : 'none' }}>
            <p style={{ margin: '0 0 4px', fontWeight: 700 }}>{info.tipo === 'retiro' ? 'Remito de retiro' : 'Remito de entrega'} N° {info.numero}</p>
            <p style={{ margin: '0 0 10px', color: 'var(--muted)' }}>{info.paciente}</p>
            <p style={{ margin: '0 0 12px', fontSize: 14 }}>{mensajeDe(info.via)}</p>
            <button className="btn btn-primary btn-block" autoFocus={i === 0} onClick={() => descargar(info)}>
              <Icon name="file" size={16} /> Descargar PDF
            </button>
          </div>
        ))}
        <button className="btn btn-secondary btn-block" onClick={onClose}>Cerrar</button>
      </div>
    </div>
  );
}

// Los documentos guardados (cotizaciones, remitos, facturas) NO deben llevar
// las fotos en base64: cada documento copiaba ~130 KB por producto y el blob
// que se sube en cada guardado crecia a megas, haciendo lentisimo el guardado.
// El PDF ya se genero con la foto; en el historial alcanza con el texto.
const sinFotoPesada = (url) => (typeof url === 'string' && url.startsWith('data:') ? '' : (url || ''));
const itemLiviano = (it) => ({ ...it, imageUrl: sinFotoPesada(it.imageUrl) });

// Numero de serie: distingue unidades que se llaman igual al facturar.
const serieDe = (it) => (it && it.serialNumber ? String(it.serialNumber).trim() : '');
const etiquetaSerie = (it) => { const s = serieDe(it); return s ? `N° serie: ${s}` : ''; };
const nombreConSerie = (it) => { const s = serieDe(it); return s ? `${it.name} (N° de serie: ${s})` : it.name; };
// Stock de lo que se vende. Los equipos de alquiler no tienen stock (son unidades), no se muestra.
const stockDe = (it) => (it && it._cat !== 'equipos' && it.stock !== undefined && it.stock !== null ? Number(it.stock) || 0 : null);
const etiquetaStock = (it) => { const s = stockDe(it); return s === null ? '' : (s > 0 ? `Stock: ${s}` : 'Sin stock'); };

// Los mas nuevos SIEMPRE primero, en listas y en desplegables.
// Desempata por id: los ids se generan con timestamp, asi que el mayor es el
// mas reciente (necesario porque createdAt es solo la fecha, sin hora).
const masNuevoPrimero = (a, b) =>
  String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
  String(b.id || '').localeCompare(String(a.id || ''));
const ordenNuevosPrimero = (arr) => [...(arr || [])].sort(masNuevoPrimero);

// Para buscar por telefono o DNI sin importar espacios, guiones ni parentesis.
const soloDigitos = (v) => String(v || '').replace(/\D/g, '');
// Cada palabra tiene que aparecer en algun lado, asi se pueden combinar terminos.
// Si la palabra es numerica se compara contra los digitos del texto.
const coincideTexto = (campo, consulta) => {
  const palabras = String(consulta || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!palabras.length) return true;
  const texto = String(campo || '').toLowerCase();
  const digitos = soloDigitos(texto);
  return palabras.every(w => {
    if (texto.includes(w)) return true;
    const d = soloDigitos(w);
    return d.length >= 3 && digitos.includes(d);
  });
};

function getMonthKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('es-AR', {
    month: 'long',
    year: 'numeric'
  });
}

function isRentalInMonth(rental, monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
  const rentalStart = rental.startDate ? new Date(`${rental.startDate}T00:00:00`) : null;
  const rentalEnd = rental.endDate ? new Date(`${rental.endDate}T23:59:59`) : null;

  if (!rentalStart) return false;
  if (rental.status === 'finalizado') return false;

  return rentalStart <= monthEnd && (!rentalEnd || rentalEnd >= monthStart);
}

// Pago registrado bajo una clave exacta (mes YYYY-MM o quincena YYYY-MM-DD).
const isPaidKey = (rental, key) => Boolean(rental.paymentStatusByMonth?.[key]?.paid);

function isRentalPaidForMonth(rental, monthKey) {
  const p = rental.paymentStatusByMonth || {};
  if (p[monthKey]?.paid) return true;
  // Quincenal: las claves son fechas; el mes cuenta como cobrado si alguna quincena de ese mes esta paga.
  return Object.entries(p).some(([k, v]) => v && v.paid && k.length === 10 && k.slice(0, 7) === monthKey);
}

// ---- Periodo del alquiler: mensual (por defecto) o quincenal (15 dias) ----
// Los alquileres viejos no tienen el campo y se tratan como mensuales.
const PERIODO_LABEL = { mensual: 'Mensual', quincenal: '15 dias' };
const periodoDe = (r) => (r && r.period === 'quincenal' ? 'quincenal' : 'mensual');
function addDaysStr(dateStr, dias) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + dias);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
// Clave con la que se registra el pago del periodo que vence en dueDate:
// mensual = el mes (YYYY-MM), quincenal = la fecha exacta (YYYY-MM-DD).
const claveDePeriodo = (dueDate, periodo) => (periodo === 'quincenal' ? (dueDate || '') : (dueDate || '').slice(0, 7));
const mesDeClave = (k) => String(k || '').slice(0, 7);
const etiquetaPeriodo = (k) => (String(k || '').length === 10 ? `quincena al ${formatDate(k)}` : formatMonthLabel(k));
// Precio del equipo segun el periodo elegido.
const precioEquipoPorPeriodo = (e, periodo) => (periodo === 'quincenal' ? (Number(e?.rentalPrice15) || 0) : (Number(e?.rentalPrice) || 0));

// Cuantos periodos se cobraron en un mes: los tildados como pagos con clave de ese
// mes, mas el primero (se cobra al iniciar) si el alquiler arranco ese mes. Un
// alquiler ya finalizado solo suma el de alta en meses pasados. Mensual = maximo
// uno por mes (hay datos viejos con el mes de alta tildado ademas).
function periodosCobradosEnMes(rental, monthKey) {
  const p = rental.paymentStatusByMonth || {};
  let cant = Object.entries(p).filter(([k, v]) => v && v.paid && mesDeClave(k) === monthKey).length;
  const mesActual = getToday().slice(0, 7);
  const arranca = (rental.startDate || '').slice(0, 7) === monthKey;
  if (arranca && (monthKey < mesActual || rental.status !== 'finalizado')) cant += 1;
  if (periodoDe(rental) === 'mensual') cant = Math.min(cant, 1);
  return cant;
}
const montoCobradoEnMes = (rental, monthKey) => periodosCobradosEnMes(rental, monthKey) * (Number(rental.price) || 0);

// Cuantos periodos corresponde cobrar en un mes: mensual siempre 1; quincenal, el de
// alta (si arranco ese mes) mas cada vencimiento de 15 dias que cae en el mes.
function periodosContratadosEnMes(rental, monthKey) {
  if (periodoDe(rental) !== 'quincenal') return 1;
  let cant = (rental.startDate || '').slice(0, 7) === monthKey ? 1 : 0;
  let d = addDaysStr(rental.startDate, 15);
  let guard = 0;
  while (d && d.slice(0, 7) <= monthKey && guard < 400) {
    if (d.slice(0, 7) === monthKey) cant += 1;
    d = addDaysStr(d, 15); guard++;
  }
  return Math.max(1, cant);
}

// Dias de anticipacion del aviso "Por vencer" (Inicio y Alquileres). Es el mismo
// plazo que usa el reporte diario de Santi (proximos 7 dias).
const DIAS_AVISO = 7;
const textoDias = (fecha) => {
  const n = getDaysUntilEnd(fecha);
  return n <= 0 ? 'hoy' : n === 1 ? 'mañana' : `en ${n} días`;
};

// Periodos vencidos y sin pagar: cada vencimiento desde el actual hasta hoy
// (hoy inclusive). El pago se registra con la clave del periodo que vence ese
// dia (mensual = el mes del vencimiento, quincenal = la fecha). Un periodo cuyo
// vencimiento todavia no llego NO es deuda.
// Antes el mensual contaba meses calendario: el mes en curso figuraba impago
// aunque su vencimiento fuera dias despues, y new Date('YYYY-MM-01') (UTC) caia
// en el mes anterior en Argentina y sumaba un mes de mas.
function periodosImpagos(rental) {
  if (!rental.endDate) return [];
  const periodo = periodoDe(rental);
  const hoy = getToday();
  const out = [];
  let d = rental.endDate;
  let guard = 0;
  while (d && d <= hoy && guard < 400) {
    const clave = claveDePeriodo(d, periodo);
    if (!isPaidKey(rental, clave)) out.push(clave);
    d = nextDueAfter(d, rental.startDate, periodo); guard++;
  }
  return out;
}

// Vencimiento real: el primer periodo SIN PAGAR a partir del vencimiento guardado.
// Si se pago un periodo atrasado (ej: septiembre pagado en octubre), el
// vencimiento pasa al siguiente en vez de quedar clavado en la fecha vieja.
function primerVencimientoImpago(rental) {
  const periodo = periodoDe(rental);
  const hoy = getToday();
  let d = rental.endDate;
  let guard = 0;
  while (d && d <= hoy && isPaidKey(rental, claveDePeriodo(d, periodo)) && guard < 400) {
    d = nextDueAfter(d, rental.startDate, periodo); guard++;
  }
  return d;
}

// ---- Fuente de verdad unica para estado de alquileres y ocupacion de equipos ----
// Un alquiler ocupa fisicamente el equipo mientras no este finalizado (activo o vencido).
// equipment.available / equipment.status NO son confiables (solo los toca el form de edicion).
function getOccupyingRental(rentals, equipId) {
  return (rentals || []).find(r => r.equipmentId === equipId && r.status !== 'finalizado');
}

// Vencido = no finalizado, con fecha de fin, y esa fecha es hoy o anterior (hoy inclusive).
// Comparacion por string YYYY-MM-DD para evitar el desfase de zona horaria de new Date('YYYY-MM-DD').
function isRentalExpired(rental, todayStr = getToday()) {
  if (!rental || rental.status === 'finalizado' || !rental.endDate) return false;
  return rental.endDate <= todayStr;
}

function getMonthDateFromKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

function getMonthDifferenceInclusive(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return 0;

  return (
    (endDate.getFullYear() - startDate.getFullYear()) * 12 +
    (endDate.getMonth() - startDate.getMonth()) +
    1
  );
}

function getRentalCoveredMonths(rental, referenceMonthKey) {
  if (!rental.startDate) return 0;

  const rentalStart = new Date(`${rental.startDate}T00:00:00`);
  const startMonth = new Date(rentalStart.getFullYear(), rentalStart.getMonth(), 1);
  const referenceMonth = getMonthDateFromKey(referenceMonthKey);
  const rentalEnd = rental.endDate ? new Date(`${rental.endDate}T00:00:00`) : null;
  const endMonth = rentalEnd
    ? new Date(rentalEnd.getFullYear(), rentalEnd.getMonth(), 1)
    : referenceMonth;
  const effectiveEndMonth = endMonth < referenceMonth ? endMonth : referenceMonth;

  return getMonthDifferenceInclusive(startMonth, effectiveEndMonth);
}

function getExplicitPaidMonthsCount(rental, referenceMonthKey) {
  const referenceMonth = getMonthDateFromKey(referenceMonthKey);

  return Object.entries(rental.paymentStatusByMonth || {}).filter(([monthKey, value]) => {
    if (!value?.paid) return false;

    const monthDate = getMonthDateFromKey(monthKey);
    return isRentalInMonth(rental, monthKey) && monthDate <= referenceMonth;
  }).length;
}

function getRentalCollectedMonths(rental, referenceMonthKey) {
  const referenceMonth = getMonthDateFromKey(referenceMonthKey);
  const rentalEnd = rental.endDate ? new Date(`${rental.endDate}T00:00:00`) : null;
  const isUpToDate = rental.status === 'activo' && (!rentalEnd || rentalEnd >= referenceMonth);

  if (isUpToDate || isRentalPaidForMonth(rental, referenceMonthKey)) {
    return getRentalCoveredMonths(rental, referenceMonthKey);
  }

  return getExplicitPaidMonthsCount(rental, referenceMonthKey);
}

function getRentalCollectedAmount(rental, referenceMonthKey) {
  return getRentalCollectedMonths(rental, referenceMonthKey) * Number(rental.price || 0);
}

// Menu: secciones agrupadas. En celular, la barra inferior muestra las 4 mas
// usadas y "Mas" abre el menu completo.
const NAV = [
  { titulo: 'Principal', items: [
    { page: 'home', label: 'Inicio', icon: 'home' },
    { page: 'rentals', label: 'Alquileres', icon: 'clipboard' },
    { page: 'patients', label: 'Pacientes', icon: 'users' },
    { page: 'calendar', label: 'Calendario', icon: 'calendar' },
  ] },
  { titulo: 'Inventario', items: [
    { page: 'equipment', label: 'Equipos', icon: 'device' },
    { page: 'equiposNuevos', label: 'Equipos nuevos', icon: 'tag' },
    { page: 'mascaras', label: 'Mascarillas', icon: 'mask' },
    { page: 'descartables', label: 'Descartables', icon: 'box' },
  ] },
  { titulo: 'Ventas', items: [
    { page: 'quotations', label: 'Cotización / Remito', icon: 'file' },
    { page: 'facturacion', label: 'Facturación', icon: 'cart' },
    { page: 'contabilidad', label: 'Contabilidad', icon: 'chart' },
  ] },
  { titulo: 'Sistema', items: [
    { page: 'settings', label: 'Configuración', icon: 'settings' },
  ] },
];
const NAV_INFERIOR = [
  { page: 'home', label: 'Inicio', icon: 'home' },
  { page: 'rentals', label: 'Alquileres', icon: 'clipboard' },
  { page: 'patients', label: 'Pacientes', icon: 'users' },
  { page: 'equipment', label: 'Equipos', icon: 'device' },
];

function SyncIndicator({ compacto = false }) {
  const [status, setStatus] = useState(() => getSyncStatus());

  useEffect(() => {
    return onSyncStatus(setStatus);
  }, []);

  const label = status.state === 'ok' ? 'Sincronizado'
    : status.state === 'saving' || status.state === 'loading' ? 'Sincronizando...'
    : status.state === 'error' ? 'Sin conexion'
    : '';
  const color = status.state === 'ok' ? '#10B981'
    : status.state === 'error' ? '#EF4444'
    : status.state === 'saving' || status.state === 'loading' ? '#F59E0B'
    : '#94a3b8';

  if (compacto) {
    return <span title={label + (status.error ? ': ' + status.error : '')} style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0, margin: '0 8px' }} />;
  }
  return (
    <div style={{ padding: '8px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}
      title={status.error || ''}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
      <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{label}</span>
    </div>
  );
}

// Pantalla de ingreso. La contraseña se valida en la base (no en el navegador)
// y solo se guarda un token de sesion de 30 dias.
function LoginPage({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password) return;
    setEnviando(true);
    setError('');
    const res = await login(password);
    setEnviando(false);
    if (res.ok) { setPassword(''); onLogin(); return; }
    setError(res.error === 'demasiados_intentos'
      ? 'Demasiados intentos fallidos. Espera 15 minutos y volve a probar.'
      : res.error === 'sin_conexion'
        ? 'No hay conexion con la base de datos. Revisa internet y volve a intentar.'
        : 'Contraseña incorrecta.');
  };

  return (
    <div className="login-wrap">
      <div className="login-foto">
        <div className="login-foto-texto">
          <strong>Equipos respiratorios en casa, bajo control.</strong>
          <span>Alquileres, vencimientos y cobranzas de Inser Salud.</span>
        </div>
      </div>
      <div className="login-panel">
      <form onSubmit={handleSubmit} className="login-card">
        <img className="login-logo" src="/logo.jpg" alt="Inser Salud" onError={e => { e.currentTarget.style.display = 'none'; }} />
        <h1>Gestión de equipos</h1>
        <p className="sub">Ingresá con la contraseña de la app</p>
        <div className="form-group">
          <label className="form-label" htmlFor="app-password">Contraseña</label>
          <input id="app-password" type="password" className="form-input" autoComplete="current-password" autoFocus
            value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        {error && <div role="alert" className="alert alert-error" style={{ fontSize: 13.5, padding: '10px 12px' }}><Icon name="alert" size={18} />{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" disabled={enviando || !password}>
          <Icon name="lock" size={18} />
          {enviando ? 'Ingresando...' : 'Ingresar'}
        </button>
      </form>
      </div>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(() => Boolean(getSessionToken()));
  const [currentPage, setCurrentPage] = useState('home');
  const [menuOpen, setMenuOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [remitosListos, setRemitosListos] = useState([]);

  // Ventana "remito listo" (con boton Descargar) cada vez que se arma un remito.
  useEffect(() => onRemitoListo(info => setRemitosListos(prev => [...prev, info])), []);

  // dataRef refleja siempre el ultimo estado. Se actualiza en cada camino que
  // hace setData (init, updateData, onDataChange), nunca durante el render.
  const dataRef = useRef(null);

  // Si la sesion vence (o se cierra en otro lado), volver a pedir la contraseña.
  useEffect(() => onAuthRequired(() => {
    dataRef.current = null;
    setData(null);
    setAuthed(false);
  }), []);

  useEffect(() => {
    if (!authed) return;
    let active = true;

    const initializeData = async () => {
      try {
        const loaded = await loadData();
        if (!active) return;
        dataRef.current = loaded;
        setData(loaded);
        setLoading(false);
      } catch (e) {
        if (active && e.code === 'AUTH') setAuthed(false);
      }
    };

    initializeData();

    return () => {
      active = false;
    };
  }, [authed]);

  const handleLogout = async () => {
    const aviso = hayCambiosSinSubir()
      ? 'Hay cambios que todavia no se subieron a la base. Se subiran la proxima vez que ingreses en este navegador. ¿Cerrar sesion igual?'
      : '¿Cerrar sesion en este navegador?';
    if (!confirm(aviso)) return;
    await logout();
    dataRef.current = null;
    setData(null);
    setAuthed(false);
  };

  const updateData = useCallback((updater) => {
    // Sin datos cargados (la sesion vencio y se vacio la pantalla) no hay sobre que
    // aplicar el cambio: se avisa con un error (los llamadores lo muestran) en vez de
    // guardar un estado vacio encima de la base o de seguir en silencio.
    if (typeof updater === 'function' && !dataRef.current) {
      throw new Error('La sesión venció: ingresá de nuevo a la app. Este cambio no se guardó.');
    }
    const nextData = typeof updater === 'function' ? updater(dataRef.current) : updater;
    // El updater devolvio el mismo estado: no hubo cambio, no se vuelve a subir todo.
    if (nextData === dataRef.current) return;
    dataRef.current = nextData;
    setData(nextData);
    saveData(nextData);
  }, []);

  // Mantener la app sincronizada con la base entre dispositivos:
  // - onDataChange: cuando llega un cambio de otro dispositivo, refresca la UI.
  // - heartbeat cada 5s (solo el timestamp, liviano): si la base cambio, baja todo.
  // - focus / volver a la pestania / reconexion: el mismo chequeo inmediato. Antes
  //   bajaba el blob entero (~1 MB) cada vez que se volvia a la ventana, aunque
  //   nada hubiera cambiado: consumo de egress de Supabase sin necesidad.
  useEffect(() => {
    if (!authed) return;
    const unsub = onDataChange((incoming) => {
      dataRef.current = incoming;
      setData(incoming);
    });
    const check = () => { if (document.visibilityState === 'visible') syncIfRemoteChanged(); };
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    const iv = setInterval(check, 5000);
    return () => {
      unsub();
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
      clearInterval(iv);
    };
  }, [authed]);

  if (!authed) {
    return <LoginPage onLogin={() => { setLoading(true); setAuthed(true); }} />;
  }

  if (loading || !data) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--muted)' }}>
        <img src="/img/marca.png" alt="" style={{ width: 34 }} />
        <span style={{ fontWeight: 600 }}>Cargando datos...</span>
      </div>
    );
  }

  const renderPage = () => {
    switch (currentPage) {
      case 'home': return <HomePage data={data} updateData={updateData} />;
      case 'patients': return <PatientsPage data={data} updateData={updateData} />;
      case 'rentals': return <RentalsPage data={data} updateData={updateData} />;
      case 'equipment': return <EquipmentPage data={data} updateData={updateData} />;
      case 'mascaras': return <MascarasPage data={data} updateData={updateData} />;
      case 'equiposNuevos': return <EquiposNuevosPage data={data} updateData={updateData} />;
      case 'quotations': return <QuotationsPage data={data} updateData={updateData} />;
      case 'calendar': return <CalendarPage data={data} />;
      case 'descartables': return <DescartablesPage data={data} updateData={updateData} />;
      case 'facturacion': return <FacturacionPage data={data} updateData={updateData} />;
      case 'contabilidad': return <ContabilidadPage data={data} updateData={updateData} />;
      case 'settings': return <SettingsPage data={data} updateData={updateData} />;
      case 'api': return <ApiPage />;
      default: return <HomePage data={data} updateData={updateData} />;
    }
  };

  const irA = (page) => {
    setCurrentPage(page);
    setMenuOpen(false);
    window.scrollTo(0, 0);
  };
  const tituloActual = (NAV.flatMap(g => g.items).find(i => i.page === currentPage) || {}).label || 'Inicio';

  return (
    <div className="app-container">
      <header className="topbar">
        <button className="topbar-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu"><Icon name="menu" size={22} /></button>
        <img src="/img/marca.png" alt="" />
        <div className="topbar-title">{currentPage === 'home' ? 'Inser Salud' : tituloActual}</div>
        <SyncIndicator compacto />
      </header>

      <div className={`drawer-backdrop ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)} />

      <nav className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Menu principal">
        <div className="sidebar-brand">
          <img src="/img/marca.png" alt="" />
          <div>
            <div className="sidebar-logo">Inser Salud</div>
            <div className="sidebar-subtitle">Gestión de equipos respiratorios</div>
          </div>
          <button className="sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Cerrar menu"><Icon name="x" /></button>
        </div>

        {NAV.map(grupo => (
          <div key={grupo.titulo}>
            <div className="nav-section">{grupo.titulo}</div>
            {grupo.items.map(it => (
              <div key={it.page} className={`nav-item ${currentPage === it.page ? 'active' : ''}`} onClick={() => irA(it.page)}>
                <span className="nav-icon"><Icon name={it.icon} /></span>
                <span className="nav-label">{it.label}</span>
              </div>
            ))}
          </div>
        ))}

        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <div className="nav-item" onClick={handleLogout} title="Cerrar sesion en este navegador">
            <span className="nav-icon"><Icon name="logout" /></span>
            <span className="nav-label">Cerrar sesión</span>
          </div>
          <SyncIndicator />
        </div>
      </nav>

      <main className="main-content">
        <div className="page-inner">
          {renderPage()}
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Accesos rapidos">
        {NAV_INFERIOR.map(it => (
          <button key={it.page} className={currentPage === it.page ? 'active' : ''} onClick={() => irA(it.page)}>
            <Icon name={it.icon} size={22} />
            {it.label}
          </button>
        ))}
        <button className={menuOpen ? 'active' : ''} onClick={() => setMenuOpen(true)}>
          <Icon name="menu" size={22} />
          Más
        </button>
      </nav>

      {remitosListos.length > 0 && <RemitoListoModal items={remitosListos} onClose={() => setRemitosListos([])} />}
    </div>
  );
}

function HomePage({ data, updateData }) {
  const { patients, equipment, rentals } = data;
  const today = getToday();
  const currentMonthKey = getMonthKey(new Date());

  const getUnpaidMonthsForRental = (rental) => periodosImpagos(rental);

  useEffect(() => {
    const todayStr = getToday();
    const needsUpdate = rentals.some(r => {
      if (r.status === 'finalizado' || !r.startDate) return false;
      if (!r.endDate) return true; // sin vencimiento -> hay que ponerlo automaticamente
      if (alignDueDay(r.endDate, r.startDate, periodoDe(r)) !== r.endDate) return true; // vencimiento no cae el dia de inicio
      if (cappedDueDate(r) !== r.endDate) return true; // vencimiento a mas de un mes del que corresponde
      if (primerVencimientoImpago(r) !== r.endDate) return true; // el vencimiento guardado ya esta pago
      if ((r.endDate <= todayStr ? 'vencido' : 'activo') !== r.status) return true;
      return false;
    });
    if (!needsUpdate) return;

    updateData(cur => {
      const updated = cur.rentals.map(rental => {
        if (rental.status === 'finalizado' || !rental.startDate) return rental;
        let r = rental;
        // 0) Si no tiene vencimiento, ponerlo automaticamente: dia de inicio, proximo vencimiento desde hoy.
        if (!r.endDate) r = { ...r, endDate: rollingDueDate(r.startDate, periodoDe(r)) };
        if (!r.endDate) return r; // startDate invalido: no se pudo calcular
        // 1) El vencimiento SIEMPRE cae el dia de inicio (corrige desfases automaticamente).
        const aligned = alignDueDay(r.endDate, r.startDate, periodoDe(r));
        if (aligned !== r.endDate) r = { ...r, endDate: aligned };
        // 2) Tope: el vencimiento nunca a mas de un mes del que corresponde por inicio.
        const capped = cappedDueDate(r);
        if (capped !== r.endDate) r = { ...r, endDate: capped };
        // 3) Periodos ya pagos: el vencimiento pasa al primero sin pagar.
        const real = primerVencimientoImpago(r);
        if (real !== r.endDate) r = { ...r, endDate: real };
        // 4) Estado segun la fecha ya normalizada (vence hoy = vencido).
        const estado = r.endDate <= todayStr ? 'vencido' : 'activo';
        if (estado !== r.status) r = { ...r, status: estado };
        return r;
      });
      return { ...cur, rentals: updated };
    });
  }, [rentals, today, updateData]);

  const activeRentals = rentals.filter(r => r.status === 'activo');
  // Por vencer = vencen en los proximos DIAS_AVISO dias (los de hoy ya cuentan como
  // vencidos). Antes solo miraba el mes calendario: el 28 de octubre no avisaba de
  // los que vencian el 1 o el 3 de noviembre, recien aparecian el mismo dia 1.
  const limiteAviso = addDaysStr(today, DIAS_AVISO);
  const expiringRentals = rentals
    .filter(r => r.status !== 'finalizado' && r.endDate && r.endDate > today && r.endDate <= limiteAviso)
    .sort((a, b) => a.endDate.localeCompare(b.endDate));

  // Tarjeta "Vencidos": vencidos (hoy inclusive) con meses sin pagar.
  const expiredRentals = rentals.filter(r => {
    if (r.status === 'finalizado' || !r.endDate || r.endDate > today) return false;
    return getUnpaidMonthsForRental(r).length > 0;
  });
  // Disponibilidad derivada de los alquileres reales, no del campo equipment.available (que esta desactualizado).
  const availableEquipment = equipment.filter(e => e.status !== 'mantenimiento' && !getOccupyingRental(rentals, e.id));
  // Un alquiler cuenta como cobrado del mes si se tildo como pagado ese mes, o si
  // ES NUEVO de este mes (el primer mes se cobra al iniciar; recien vence el mes que viene).
  // Un quincenal puede cobrar dos periodos en el mismo mes: se suma por periodos.
  const isCollectedThisMonth = (r) => periodosCobradosEnMes(r, currentMonthKey) > 0;

  const monthlyRentals = rentals.filter(rental => isRentalInMonth(rental, currentMonthKey));
  const monthlyTotal = monthlyRentals.reduce((sum, rental) => sum + Number(rental.price || 0) * periodosContratadosEnMes(rental, currentMonthKey), 0);
  const monthlyCollected = monthlyRentals.reduce((sum, rental) => sum + montoCobradoEnMes(rental, currentMonthKey), 0);
  const monthlyPending = monthlyTotal - monthlyCollected;

  // Cobrados del mes: tildados como cobrados + altas nuevas del mes.
  const collectedRentals = rentals.filter(isCollectedThisMonth);
  const collectedTotal = collectedRentals.reduce((s, r) => s + montoCobradoEnMes(r, currentMonthKey), 0);

  const [activeFilter, setActiveFilter] = useState(null);

  const hora = new Date().getHours();
  const saludo = hora < 12 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
  const fechaLarga = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const vencenHoy = rentals.filter(r => r.status !== 'finalizado' && r.endDate === today).length;
  const abrirLista = (filtro) => {
    setActiveFilter(filtro);
    setTimeout(() => document.getElementById('lista-inicio')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  return (
    <div>
      <section className="hero">
        <div className="hero-text">
          <div className="hero-kicker">{fechaLarga}</div>
          <div className="hero-title">{saludo}</div>
          <div className="hero-sub">
            {expiredRentals.length === 0 && expiringRentals.length === 0
              ? 'Todo al día: no hay alquileres vencidos ni por vencer esta semana.'
              : 'Esto es lo que necesita atención hoy.'}
          </div>
          <div className="hero-chips">
            <button className="hero-chip" onClick={() => abrirLista('vencidos')}><span className="dot" style={{ background: '#FCA5A5' }} />{expiredRentals.length} vencidos</button>
            {vencenHoy > 0 && <button className="hero-chip" onClick={() => abrirLista('vencidos')}><span className="dot" style={{ background: '#FDBA74' }} />{vencenHoy} vencen hoy</button>}
            <button className="hero-chip" onClick={() => abrirLista('porVencer')}><span className="dot" style={{ background: '#FDE68A' }} />{expiringRentals.length} en los próximos {DIAS_AVISO} días</button>
          </div>
        </div>
        <div className="hero-img" aria-hidden="true" />
      </section>

      <div className="stats-grid">
        <div className="stat-card" style={{ cursor: 'pointer', outline: activeFilter === 'activos' ? '3px solid #1D5FBF' : 'none' }} onClick={() => setActiveFilter(activeFilter === 'activos' ? null : 'activos')}>
          <div className="stat-icon"><Icon name="clipboard" size={22} /></div>
          <div className="stat-value">{activeRentals.length}</div>
          <div className="stat-label">Alquileres activos</div>
        </div>
        <div className="stat-card warning" style={{ cursor: 'pointer', outline: activeFilter === 'porVencer' ? '3px solid #F59E0B' : 'none' }} onClick={() => setActiveFilter(activeFilter === 'porVencer' ? null : 'porVencer')}>
          <div className="stat-icon"><Icon name="clock" size={22} /></div>
          <div className="stat-value">{expiringRentals.length}</div>
          <div className="stat-label">Por vencer ({DIAS_AVISO} días)</div>
        </div>
        <div className="stat-card error" style={{ cursor: 'pointer', outline: activeFilter === 'vencidos' ? '3px solid #EF4444' : 'none' }} onClick={() => setActiveFilter(activeFilter === 'vencidos' ? null : 'vencidos')}>
          <div className="stat-icon"><Icon name="alert" size={22} /></div>
          <div className="stat-value">{expiredRentals.length}</div>
          <div className="stat-label">Vencidos</div>
        </div>
        <div className="stat-card success" style={{ cursor: 'pointer', outline: activeFilter === 'cobrados' ? '3px solid #10B981' : 'none' }} onClick={() => setActiveFilter(activeFilter === 'cobrados' ? null : 'cobrados')}>
          <div className="stat-icon"><Icon name="cash" size={22} /></div>
          <div className="stat-value">{collectedRentals.length}</div>
          <div className="stat-label">Cobrados del mes</div>
        </div>
        <div className="stat-card success">
          <div className="stat-icon"><Icon name="check" size={22} /></div>
          <div className="stat-value">{availableEquipment.length}</div>
          <div className="stat-label">Equipos disponibles</div>
        </div>
      </div>

      {activeFilter && (() => {
        const isCobrados = activeFilter === 'cobrados';
        const list = activeFilter === 'activos' ? activeRentals : activeFilter === 'porVencer' ? expiringRentals : isCobrados ? collectedRentals : expiredRentals;
        const title = activeFilter === 'activos' ? 'Alquileres Activos' : activeFilter === 'porVencer' ? 'Por Vencer' : isCobrados ? `Alquileres Cobrados de ${formatMonthLabel(currentMonthKey)}` : 'Vencidos';
        const color = activeFilter === 'activos' ? '#1E5AA8' : activeFilter === 'porVencer' ? '#F9A825' : isCobrados ? '#2E7D32' : '#E53935';
        const isVencidos = activeFilter === 'vencidos';

        const getUnpaidMonths = (rental) => periodosImpagos(rental);

        const handlePayMonth = (rentalId, mk) => {
          const rentalPay = rentals.find(r => r.id === rentalId);
          const patientPay = patients.find(p => p.id === rentalPay?.patientId);
          if (!confirm(`¿Registrar el pago de ${etiquetaPeriodo(mk)} de ${patientPay?.name || 'este alquiler'}?`)) return;
          updateData(currentData => ({
            ...currentData,
            rentals: currentData.rentals.map(r => {
              if (r.id !== rentalId) return r;
              const updated = { ...r, paymentStatusByMonth: { ...(r.paymentStatusByMonth || {}), [mk]: { paid: true, updatedAt: new Date().toISOString() } } };
              // El vencimiento pasa al primer periodo que siga sin pagar. Si ese
              // todavia no llego, el alquiler vuelve a activo.
              updated.endDate = primerVencimientoImpago(updated);
              updated.status = updated.endDate <= getToday() ? 'vencido' : 'activo';
              return updated;
            })
          }));
        };

        // Baja de alquiler: finaliza el alquiler (sale de las listas y pasa a Finalizados),
        // libera el equipo para volver a alquilarlo y emite el remito de retiro.
        const handleBaja = (r) => {
          const p = patients.find(x => x.id === r.patientId);
          const eq = equipment.find(e => e.id === r.equipmentId);
          const msg = `¿Dar de baja el alquiler de ${p?.name || 'este paciente'}?\n\n`
            + `Equipo: ${eq?.name || 'sin equipo'}\n\n`
            + `- Se genera el remito de retiro (PDF)\n`
            + `- El equipo vuelve al stock para alquilar\n`
            + `- El alquiler pasa a Finalizados`;
          if (!confirm(msg)) return;
          darDeBajaAlquiler(r, data, updateData);
        };

        const handleReminder = (r) => {
          const p = patients.find(x => x.id === r.patientId);
          const eq = equipment.find(e => e.id === r.equipmentId);
          if (!confirm(`¿Enviar recordatorio de vencimiento a ${p?.name || 'este paciente'} por WhatsApp?`)) return;
          const msg = `Hola ${p?.name || ''}, soy Santi de INSER SALUD. Te recuerdo el vencimiento del alquiler del equipo ${eq?.name || ''} (vence el ${formatDate(r.endDate)}). ¡Gracias!`;
          sendWhatsApp(p?.phone || '', msg);
        };

        return list.length > 0 ? (
          <div className="card" id="lista-inicio" style={{ borderTop: `3px solid ${color}`, scrollMarginTop: 70 }}>
            <div className="card-header">
              <h3 className="card-title" style={{ color }}>{title} ({list.length})</h3>
              <button className="btn btn-sm btn-secondary btn-icon" onClick={() => setActiveFilter(null)} aria-label="Cerrar lista"><Icon name="x" size={16} /></button>
            </div>
            {isCobrados && (
              <div style={{ background: '#E8F5E9', border: '1px solid #A5D6A7', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, color: '#2E7D32' }}>Total cobrado</span>
                <strong style={{ fontSize: 18, color: '#2E7D32' }}>{formatCurrency(collectedTotal)}</strong>
              </div>
            )}
            {list.map(r => {
              const pat = patients.find(p => p.id === r.patientId);
              const eq = equipment.find(e => e.id === r.equipmentId);
              const unpaid = isVencidos ? getUnpaidMonths(r) : [];
              return (
                <div key={r.id} className="fila-alquiler">
                  <EquipoFoto equipo={eq} size={52} />
                  <div className="fila-cuerpo">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{pat?.name || 'Sin paciente'}</div>
                      <div style={{ fontSize: 13, color: 'var(--muted)' }}>{eq?.name || 'Sin equipo'}</div>
                      {pat?.phone && <a href={`tel:${pat.phone}`} style={{ fontSize: 13, color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none', marginTop: 2 }}><Icon name="phone" size={13} />{pat.phone}</a>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 600, color }}>{formatCurrency(r.price)}{periodoDe(r) === 'quincenal' ? '/15 dias' : '/mes'}</div>
                      <div style={{ fontSize: 12, color: '#5A6978' }}>Vence: {formatDate(r.endDate)}{activeFilter === 'porVencer' && ` (${textoDias(r.endDate)})`}</div>
                      {isVencidos && unpaid.length > 0 && (
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#E53935', marginTop: 2 }}>{unpaid.length} {periodoDe(r) === 'quincenal' ? (unpaid.length === 1 ? 'quincena' : 'quincenas') : (unpaid.length === 1 ? 'mes' : 'meses')} sin pagar</div>
                      )}
                    </div>
                  </div>
                  {isVencidos && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                      <button className="btn btn-sm" style={{ background: '#16A34A', color: '#fff' }} onClick={() => handleReminder(r)}>
                        <Icon name="whatsapp" size={15} /> Recordatorio
                      </button>
                      {unpaid.map(mk => (
                        <button key={mk} className="btn btn-sm btn-primary" onClick={() => handlePayMonth(r.id, mk)}>
                          <Icon name="check" size={15} /> Pagar {etiquetaPeriodo(mk)}
                        </button>
                      ))}
                      <button className="btn btn-sm btn-danger" title="Dar de baja: genera remito de retiro y libera el equipo" onClick={() => handleBaja(r)}>
                        <Icon name="stop" size={15} /> Dar de baja
                      </button>
                    </div>
                  )}
                  {!isVencidos && !isCobrados && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                      <button className="btn btn-sm btn-danger" title="Dar de baja: genera remito de retiro y libera el equipo" onClick={() => handleBaja(r)}>
                        <Icon name="stop" size={15} /> Dar de baja
                      </button>
                    </div>
                  )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card" style={{ borderTop: `3px solid ${color}`, textAlign: 'center', padding: 20, color: '#5A6978' }}>
            {isCobrados ? `No hay alquileres cobrados en ${formatMonthLabel(currentMonthKey)}` : `No hay alquileres ${title.toLowerCase()}`}
          </div>
        );
      })()}

      <div className="card monthly-summary-card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Resumen mensual</h3>
            <p className="page-subtitle">Control de cobro de {formatMonthLabel(currentMonthKey)}</p>
          </div>
        </div>

        <div className="monthly-summary-grid">
          <div className="monthly-summary-item">
            <span className="monthly-summary-label">Total del mes</span>
            <strong className="monthly-summary-value">{formatCurrency(monthlyTotal)}</strong>
          </div>
          <div className="monthly-summary-item success">
            <span className="monthly-summary-label">Cobrado</span>
            <strong className="monthly-summary-value">{formatCurrency(monthlyCollected)}</strong>
          </div>
          <div className="monthly-summary-item warning">
            <span className="monthly-summary-label">Falta cobrar</span>
            <strong className="monthly-summary-value">{formatCurrency(monthlyPending)}</strong>
          </div>
          <div className="monthly-summary-item">
            <span className="monthly-summary-label">Alquileres del mes</span>
            <strong className="monthly-summary-value">{monthlyRentals.length}</strong>
          </div>
        </div>

      </div>

      {expiringRentals.length > 0 && activeFilter !== 'porVencer' && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title"><Icon name="clock" size={18} /> Próximos vencimientos ({DIAS_AVISO} días)</h3>
            {expiringRentals.length > 6 && <button className="btn btn-sm btn-secondary" onClick={() => abrirLista('porVencer')}>Ver los {expiringRentals.length}</button>}
          </div>
          {expiringRentals.slice(0, 6).map(r => {
            const pat = patients.find(p => p.id === r.patientId);
            const eq = equipment.find(e => e.id === r.equipmentId);
            const dias = getDaysUntilEnd(r.endDate);
            return (
              <div key={r.id} className="fila-alquiler" style={{ alignItems: 'center' }}>
                <EquipoFoto equipo={eq} size={46} />
                <div className="fila-cuerpo">
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pat?.name || 'Sin paciente'}</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{eq?.name || 'Sin equipo'}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 800, color: dias <= 2 ? 'var(--bad)' : 'var(--warn)', fontSize: 13.5 }}>{textoDias(r.endDate)}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{formatDate(r.endDate)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <QuickDocGenerator data={data} updateData={updateData} />

    </div>
  );
}

// Generador rapido en Inicio: factura / remito / cotizacion en un solo lugar.
// Facturar descuenta stock de mascaras y descartables; remito y cotizacion no.
function QuickDocGenerator({ data, updateData }) {
  const { equipment = [], mascaras = [], equiposNuevos = [], descartables = [], patients = [], settings = {}, rentals = [] } = data;

  const [docType, setDocType] = useState('factura');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [libre, setLibre] = useState({ name: '', price: '' });
  const [items, setItems] = useState([]);

  // Precio de un equipo de alquiler: campo propio -> alquiler del equipo -> otro con el mismo nombre.
  const equipPrice = (e) => {
    if (Number(e.rentalPrice) > 0) return Number(e.rentalPrice);
    const r = rentals.find(x => x.equipmentId === e.id && x.status !== 'finalizado' && Number(x.price) > 0);
    if (r) return Number(r.price);
    const r2 = rentals.find(x => {
      const re = equipment.find(q => q.id === x.equipmentId);
      return re && re.name === e.name && Number(x.price) > 0;
    });
    return r2 ? Number(r2.price) : 0;
  };

  const catalogos = {
    equipos: { label: 'Equipos', items: equipment.map(e => ({ id: e.id, name: e.name, detail: etiquetaSerie(e), serialNumber: e.serialNumber || '', price: equipPrice(e), imageUrl: e.imageUrl || '', _cat: 'equipos' })) },
    mascarillas: { label: 'Mascarillas', items: mascaras.map(m => ({ id: m.id, name: m.name, detail: [m.talle ? `Talle ${m.talle}` : '', etiquetaStock({ ...m, _cat: 'mascarillas' })].filter(Boolean).join(' · '), stock: m.stock, price: Number(m.precio) || 0, imageUrl: m.imageUrl || '', _cat: 'mascarillas' })) },
    equiposNuevos: { label: 'Equipos Nuevos', items: equiposNuevos.map(e => ({ id: e.id, name: e.name, detail: [etiquetaSerie(e), etiquetaStock({ ...e, _cat: 'equiposNuevos' })].filter(Boolean).join(' · '), serialNumber: e.serialNumber || '', stock: e.stock, price: Number(e.price) || 0, imageUrl: e.imageUrl || '', _cat: 'equiposNuevos' })) },
    descartables: { label: 'Descartables', items: descartables.map(d => ({ id: d.id, name: d.name, detail: [d.unit || '', etiquetaStock({ ...d, _cat: 'descartables' })].filter(Boolean).join(' · '), stock: d.stock, price: Number(d.price) || 0, imageUrl: '', _cat: 'descartables' })) },
  };

  const resultados = category && category !== 'libre' && search
    ? catalogos[category].items.filter(it => `${it.name || ''} ${serieDe(it)}`.toLowerCase().includes(search.toLowerCase())).slice(0, 20)
    : [];

  const addItem = (it) => {
    setItems(prev => {
      const ya = prev.find(x => x.id === it.id && x._cat === it._cat);
      if (ya) return prev.map(x => x === ya ? { ...x, quantity: x.quantity + 1 } : x);
      return [...prev, { ...it, quantity: 1 }];
    });
    setSearch('');
  };

  // Los equipos son solo de alquiler: si se pasa a factura o cotizacion hay que sacarlos.
  const cambiarDocType = (v) => {
    setDocType(v);
    if (v !== 'remito') {
      if (category === 'equipos') { setCategory(''); setSearch(''); }
      const quedan = items.filter(it => it._cat !== 'equipos');
      if (quedan.length !== items.length) {
        setItems(quedan);
        alert('Los equipos de alquiler se quitaron del documento: solo se pueden incluir en un remito.');
      }
    }
  };

  const addLibre = () => {
    if (!libre.name || !(Number(libre.price) > 0)) { alert('Ingresá nombre y precio del item'); return; }
    setItems(prev => [...prev, { id: 'libre-' + Date.now(), name: libre.name, detail: '', price: Number(libre.price), imageUrl: '', _cat: 'libre', quantity: 1 }]);
    setLibre({ name: '', price: '' });
  };

  const cambiarCantidad = (idx, delta) => {
    setItems(prev => prev.map((x, i) => i === idx ? { ...x, quantity: Math.max(1, x.quantity + delta) } : x).filter(Boolean));
  };

  const total = items.reduce((s, it) => s + it.price * it.quantity, 0);

  const handleClientChange = (value) => {
    setClientName(value);
    const match = patients.find(p => (p.name || '').trim().toLowerCase() === value.trim().toLowerCase());
    if (match && match.phone) setClientPhone(match.phone);
  };

  const handleGenerar = async () => {
    if (items.length === 0) { alert('Agregá al menos un item'); return; }
    const nombreDoc = docType === 'factura' ? 'factura' : docType === 'remito' ? 'remito' : 'cotizacion';
    if (!confirm(`¿Generar ${nombreDoc} para "${clientName || 'sin nombre'}" por ${formatCurrency(total)}?`)) return;
    const prefix = docType === 'factura' ? 'FAC' : docType === 'remito' ? 'REM' : 'COT';
    const number = generateDocNumber(prefix, clientName);
    const collectionKey = docType === 'factura' ? 'invoices' : docType === 'remito' ? 'remitos' : 'quotations';
    const invoiceData = {
      invoiceNumber: number,
      date: getToday(),
      clientName,
      clientPhone,
      // Al PDF van las fotos COMPLETAS (se ven al lado de la descripcion).
      // Solo el registro que se guarda va sin base64, por peso (ver mas abajo).
      items: items.map(it => ({ name: nombreConSerie(it), price: it.price, quantity: it.quantity, imageUrl: it.imageUrl || '' })),
      total,
      notes: '',
    };
    try {
      const doc = await generateInvoicePDF(invoiceData, settings, nombreDoc);
      downloadInvoicePDF(doc, number, nombreDoc);
      const record = { id: generateId(), ...invoiceData, items: invoiceData.items.map(itemLiviano), customerName: clientName, customerPhone: clientPhone, cartItems: items.map(itemLiviano), createdAt: getToday() };
      updateData(cur => {
        const next = { ...cur, [collectionKey]: [...(cur[collectionKey] || []), record] };
        // Solo la FACTURA descuenta stock (mascaras y descartables).
        if (docType === 'factura') {
          const descontar = (arr, cat) => (arr || []).map(x => {
            const enItems = items.find(it => it.id === x.id && it._cat === cat);
            if (!enItems) return x;
            return { ...x, stock: Math.max(0, Number(x.stock || 0) - enItems.quantity) };
          });
          next.mascaras = descontar(cur.mascaras, 'mascarillas');
          next.descartables = descontar(cur.descartables, 'descartables');
        }
        return next;
      });
      alert(`${nombreDoc.charAt(0).toUpperCase() + nombreDoc.slice(1)} ${number} generado`);
      setItems([]); setClientName(''); setClientPhone(''); setSearch(''); setCategory('');
    } catch (err) {
      console.error(err);
      alert('Error al generar PDF:\n\n' + (err?.message || err) + '\n\nSacale una foto a este mensaje si el problema se repite.');
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title"><Icon name="zap" size={18} /> Generador rápido</h3>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['factura', 'Factura'], ['remito', 'Remito'], ['cotizacion', 'Cotización']].map(([v, lbl]) => (
          <button key={v} className={`filter-btn ${docType === v ? 'active' : ''}`} onClick={() => cambiarDocType(v)}>{lbl}</button>
        ))}
        {docType === 'factura' && <span style={{ fontSize: 12, color: '#5A6978', alignSelf: 'center' }}>La factura descuenta stock</span>}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="form-group" style={{ margin: 0, flex: 2, minWidth: 180 }}>
          <label className="form-label">Cliente</label>
          <input type="text" className="form-input" placeholder="Nombre del cliente" list="qdg-pacientes" value={clientName} onChange={e => handleClientChange(e.target.value)} />
          <datalist id="qdg-pacientes">
            {ordenNuevosPrimero(patients).map(p => <option key={p.id} value={p.name} />)}
          </datalist>
        </div>
        <div className="form-group" style={{ margin: 0, flex: 1, minWidth: 140 }}>
          <label className="form-label">WhatsApp</label>
          <input type="tel" className="form-input" placeholder="Teléfono" value={clientPhone} onChange={e => setClientPhone(e.target.value)} />
        </div>
      </div>

      <div className="form-group" style={{ marginBottom: 10 }}>
        <label className="form-label">Agregar producto</label>
        <select className="form-select" value={category} onChange={e => { setCategory(e.target.value); setSearch(''); }}>
          <option value="">Elegir categoría...</option>
          {docType === 'remito' && <option value="equipos">Equipos (alquiler)</option>}
          <option value="mascarillas">Mascarillas</option>
          <option value="equiposNuevos">Equipos nuevos</option>
          <option value="descartables">Descartables</option>
          <option value="libre">Ítem libre</option>
        </select>
      </div>

      {category && category !== 'libre' && (
        <div style={{ marginBottom: 12 }}>
          <input type="text" className="form-input" placeholder={`Buscar en ${catalogos[category].label}... (ej: f6)`} value={search} onChange={e => setSearch(e.target.value)} />
          {resultados.length > 0 && (
            <div style={{ border: '1px solid #BBDEFB', borderRadius: 8, marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
              {resultados.map(it => (
                <div key={it._cat + it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #E3F2FD', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{it.name}</div>
                    <div style={{ fontSize: 12, color: '#5A6978' }}>{it.detail} {it.price > 0 ? `· ${formatCurrency(it.price)}` : '· sin precio'}</div>
                  </div>
                  <button className="btn btn-sm btn-primary" onClick={() => addItem(it)}>+</button>
                </div>
              ))}
            </div>
          )}
          {search && resultados.length === 0 && (
            <p style={{ fontSize: 13, color: '#5A6978', marginTop: 6 }}>Sin coincidencias en {catalogos[category].label}</p>
          )}
        </div>
      )}

      {category === 'libre' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <input type="text" className="form-input" placeholder="Nombre del item" style={{ flex: 2, minWidth: 160 }} value={libre.name} onChange={e => setLibre({ ...libre, name: e.target.value })} />
          <input type="number" className="form-input" placeholder="Precio" style={{ flex: 1, minWidth: 100 }} value={libre.price} onChange={e => setLibre({ ...libre, price: e.target.value })} />
          <button className="btn btn-secondary" onClick={addLibre}>+ Agregar</button>
        </div>
      )}

      {items.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {items.map((it, idx) => (
            <div key={it._cat + it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #E3F2FD', gap: 8 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{it.name}</div>
                <div style={{ fontSize: 12, color: '#5A6978' }}>{formatCurrency(it.price)} c/u</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="btn btn-sm" onClick={() => cambiarCantidad(idx, -1)} aria-label="Restar"><Icon name="minus" size={16} /></button>
                <span style={{ minWidth: 22, textAlign: 'center', fontWeight: 700 }}>{it.quantity}</span>
                <button className="btn btn-sm" onClick={() => cambiarCantidad(idx, 1)} aria-label="Sumar"><Icon name="plus" size={16} /></button>
                <button className="btn btn-sm btn-danger" onClick={() => setItems(items.filter((_, i) => i !== idx))}>×</button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 17, fontWeight: 700, color: '#0D47A1' }}>
            <span>Total</span>
            <span>{formatCurrency(total)}</span>
          </div>
        </div>
      )}

      <button className="btn btn-primary btn-block" onClick={handleGenerar}>
        <Icon name="file" size={16} /> Generar
      </button>
    </div>
  );
}

function MonthlySummaryModal({ rentals, patients, equipment, monthKey, viewMode, onChangeView, onTogglePayment, onClose }) {
  const monthlyRentals = rentals.filter(rental => isRentalInMonth(rental, monthKey));
  const totals = monthlyRentals.reduce((acc, rental) => {
    const amount = Number(rental.price || 0);
    const paid = isRentalPaidForMonth(rental, monthKey);
    const collectedAmount = getRentalCollectedAmount(rental, monthKey);

    acc.total += amount;
    acc.collected += collectedAmount;
    if (!paid) {
      acc.pending += amount;
    }

    return acc;
  }, { total: 0, collected: 0, pending: 0 });

  const grouped = monthlyRentals.reduce((acc, rental) => {
    const key = viewMode === 'patient' ? rental.patientId : rental.equipmentId;
    const fallbackLabel = viewMode === 'patient' ? 'Sin paciente' : 'Sin equipo';
    const source = viewMode === 'patient' ? patients : equipment;
    const entity = source.find(item => item.id === key);
    const label = entity?.name || fallbackLabel;
    const amount = Number(rental.price || 0);
    const paid = isRentalPaidForMonth(rental, monthKey);
    const collectedAmount = getRentalCollectedAmount(rental, monthKey);
    const collectedMonths = getRentalCollectedMonths(rental, monthKey);
    const groupKey = key || fallbackLabel;

    if (!acc[groupKey]) {
      acc[groupKey] = {
        id: groupKey,
        label,
        total: 0,
        collected: 0,
        collectedMonths: 0,
        pending: 0,
        rentals: []
      };
    }

    acc[groupKey].total += amount;
    acc[groupKey].collected += collectedAmount;
    acc[groupKey].collectedMonths += collectedMonths;
    if (!paid) {
      acc[groupKey].pending += amount;
    }
    acc[groupKey].rentals.push(rental);

    return acc;
  }, {});

  const groupedItems = Object.values(grouped).sort((a, b) => b.total - a.total);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal monthly-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">Resumen mensual</h2>
            <p className="page-subtitle">{formatMonthLabel(monthKey)}</p>
          </div>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>

        <div className="monthly-summary-grid">
          <div className="monthly-summary-item">
            <span className="monthly-summary-label">Total del mes</span>
            <strong className="monthly-summary-value">{formatCurrency(totals.total)}</strong>
          </div>
          <div className="monthly-summary-item success">
            <span className="monthly-summary-label">Cobrado acumulado</span>
            <strong className="monthly-summary-value">{formatCurrency(totals.collected)}</strong>
          </div>
          <div className="monthly-summary-item warning">
            <span className="monthly-summary-label">Falta cobrar del mes</span>
            <strong className="monthly-summary-value">{formatCurrency(totals.pending)}</strong>
          </div>
        </div>

        <div className="summary-toggle">
          <button type="button" className={`filter-btn ${viewMode === 'patient' ? 'active' : ''}`} onClick={() => onChangeView('patient')}>
            Por paciente
          </button>
          <button type="button" className={`filter-btn ${viewMode === 'equipment' ? 'active' : ''}`} onClick={() => onChangeView('equipment')}>
            Por equipo
          </button>
        </div>

        {groupedItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No hay alquileres para este mes</div>
          </div>
        ) : (
          <div className="summary-groups">
            {groupedItems.map(item => (
              <div key={item.id} className="summary-group-card">
                <div className="summary-group-header">
                  <div>
                    <h4>{viewMode === 'patient' ? 'Paciente' : 'Equipo'}</h4>
                    <p className="page-subtitle">{item.rentals.length} alquiler(es)</p>
                  </div>
                  <div className="summary-group-totals">
                    <strong>{formatCurrency(item.total)}</strong>
                    <span className="summary-group-pending">Pendiente: {formatCurrency(item.pending)}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                  <span>Cobrado acumulado: {formatCurrency(item.collected)}</span>
                  <span>Meses cobrados: {item.collectedMonths}</span>
                  <span>Pendiente del mes: {formatCurrency(item.pending)}</span>
                </div>

                {item.rentals.map(rental => {
                  const paid = isRentalPaidForMonth(rental, monthKey);
                  const collectedMonths = getRentalCollectedMonths(rental, monthKey);
                  const collectedAmount = getRentalCollectedAmount(rental, monthKey);

                  return (
                    <div key={rental.id} className="summary-rental-row">
                      <div>
                        <div className="summary-rental-title">
                          {viewMode === 'patient' ? 'Alquiler del paciente' : 'Alquiler del equipo'}
                        </div>
                        <div className="summary-rental-meta">
                          {formatDate(rental.startDate)} | {formatCurrency(rental.price)} | {collectedMonths} mes(es) cobrados | {formatCurrency(collectedAmount)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`btn btn-sm ${paid ? 'btn-success' : 'btn-outline'}`}
                        onClick={() => onTogglePayment(rental.id)}
                      >
                        {paid ? 'Cobrado' : 'Marcar cobrado'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PatientsPage({ data, updateData }) {
  const { patients, rentals = [], equipment = [] } = data;
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null);
  const [historialPatient, setHistorialPatient] = useState(null);

  // Busca en todos los datos del paciente y ademas en los equipos que tiene
  // alquilados, para poder encontrarlo por el aparato o su numero de serie.
  const textoDelPaciente = (p) => {
    const susEquipos = rentals
      .filter(r => r.patientId === p.id)
      .map(r => {
        const e = equipment.find(x => x.id === r.equipmentId);
        return [e && e.name, e && e.serialNumber, r.notes, r.status].filter(Boolean).join(' ');
      })
      .join(' ');
    return [p.name, p.phone, p.address, p.dni, p.observations, susEquipos]
      .filter(Boolean).join(' ').toLowerCase();
  };
  const filteredPatients = ordenNuevosPrimero(patients)
    .filter(p => !search.trim() || coincideTexto(textoDelPaciente(p), search));

  const handleSave = (patient) => {
    if (!confirm(editingPatient ? `¿Guardar los cambios del paciente "${patient.name}"?` : `¿Agregar el paciente "${patient.name}"?`)) return;
    updateData(cur => ({
      ...cur,
      patients: editingPatient
        ? cur.patients.map(p => p.id === patient.id ? patient : p)
        : [...cur.patients, { ...patient, id: generateId(), createdAt: getToday() }]
    }));
    setShowModal(false);
    setEditingPatient(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar paciente?')) {
      updateData(cur => ({ ...cur, patients: cur.patients.filter(p => p.id !== id) }));
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Pacientes</h1>
        <p className="page-subtitle">{patients.length} pacientes registrados</p>
      </div>

      <div className="search-box">
        <Icon name="search" size={18} />
        <input type="text" className="search-input" placeholder="Buscar por nombre, teléfono, DNI, dirección, equipo..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <button className="btn btn-primary btn-block" onClick={() => { setEditingPatient(null); setShowModal(true); }} style={{ marginBottom: 20 }}>
        + Agregar Paciente
      </button>

      {filteredPatients.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="users" size={28} /></div>
          <div className="empty-title">Sin Pacientes</div>
          <div className="empty-message">Agrega tu primer paciente</div>
        </div>
      ) : (
        filteredPatients.map(patient => (
          <div key={patient.id} className="patient-card" onClick={() => { setEditingPatient(patient); setShowModal(true); }}>
            <Avatar nombre={patient.name} size={44} />
            <div className="patient-info">
              <div className="patient-name">{patient.name}</div>
              <div className="patient-detail">{patient.dni && <span>DNI {patient.dni}</span>}{patient.phone && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="phone" size={13} />{patient.phone}</span>}</div>
              <div className="patient-detail">{patient.address}</div>
            </div>
            <div className="patient-actions">
              <button className="btn btn-sm btn-secondary" title="Historial de pagos" onClick={(e) => { e.stopPropagation(); setHistorialPatient(patient); }}><Icon name="clipboard" size={15} /> Historial</button>
              <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); setEditingPatient(patient); setShowModal(true); }} title="Editar" aria-label="Editar"><Icon name="edit" size={16} /></button>
              <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); handleDelete(patient.id); }} title="Eliminar" aria-label="Eliminar"><Icon name="trash" size={16} /></button>
            </div>
          </div>
        ))
      )}

      {showModal && (
        <PatientModal patient={editingPatient} onSave={handleSave} onClose={() => { setShowModal(false); setEditingPatient(null); }} />
      )}

      {historialPatient && (
        <PatientHistorialModal
          patient={historialPatient}
          rentals={rentals}
          equipment={equipment}
          onClose={() => setHistorialPatient(null)}
        />
      )}
    </div>
  );
}

// Historial de pagos de un paciente: cada mes cobrado, con la fecha en que se
// registro el pago, el equipo y el importe. Al final, la suma total.
function PatientHistorialModal({ patient, rentals, equipment, onClose }) {
  const equipName = (id) => equipment.find(e => e.id === id)?.name || 'Sin equipo';

  const pagos = [];
  rentals
    .filter(r => r.patientId === patient.id)
    .forEach(r => {
      const meses = r.paymentStatusByMonth || {};
      Object.keys(meses).forEach(mk => {
        if (!meses[mk]?.paid) return;
        pagos.push({
          mes: mk,
          periodo: periodoDe(r),
          fechaPago: meses[mk].updatedAt || '',
          equipo: equipName(r.equipmentId),
          monto: Number(r.price) || 0,
        });
      });
    });
  // Mas recientes primero (por mes cobrado).
  pagos.sort((a, b) => b.mes.localeCompare(a.mes));
  const total = pagos.reduce((s, p) => s + p.monto, 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Historial de pagos</h2>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>

        <p style={{ fontWeight: 600, marginBottom: 4 }}>{patient.name}</p>
        <p className="page-subtitle" style={{ marginBottom: 14 }}>
          {pagos.length} {pagos.length === 1 ? 'pago registrado' : 'pagos registrados'}
        </p>

        {pagos.length === 0 ? (
          <p style={{ textAlign: 'center', color: '#5A6978', padding: 16 }}>
            Este paciente todavia no tiene pagos registrados.
          </p>
        ) : (
          <>
            {pagos.map((p, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #E3F2FD' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{formatMonthLabel(p.mes)}</div>
                  <div style={{ fontSize: 12, color: '#5A6978' }}>{p.equipo}</div>
                  <div style={{ fontSize: 12, color: '#5A6978' }}>
                    Pagado el {p.fechaPago ? formatDate(p.fechaPago.slice(0, 10)) : 's/f'}
                  </div>
                </div>
                <strong style={{ color: '#2E7D32', whiteSpace: 'nowrap' }}>{formatCurrency(p.monto)}</strong>
              </div>
            ))}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, padding: '12px 14px', background: '#E8F5E9', border: '1px solid #A5D6A7', borderRadius: 8 }}>
              <span style={{ fontWeight: 700, color: '#2E7D32' }}>TOTAL COBRADO</span>
              <strong style={{ fontSize: 18, color: '#2E7D32' }}>{formatCurrency(total)}</strong>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PatientModal({ patient, onSave, onClose }) {
  const [form, setForm] = useState(patient || { name: '', dni: '', phone: '', address: '', observations: '' });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name || !form.dni) {
      alert('Nombre y DNI son obligatorios');
      return;
    }
    onSave(form);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{patient ? 'Editar' : 'Nuevo'} Paciente</h2>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Nombre completo *</label>
            <input type="text" className="form-input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required />
          </div>
          
          <div className="form-group">
            <label className="form-label">DNI *</label>
            <input type="text" className="form-input" value={form.dni} onChange={e => setForm({...form, dni: e.target.value})} required />
          </div>
          
          <div className="form-group">
            <label className="form-label">Teléfono</label>
            <input type="tel" className="form-input" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} />
          </div>
          
          <div className="form-group">
            <label className="form-label">Dirección</label>
            <input type="text" className="form-input" value={form.address} onChange={e => setForm({...form, address: e.target.value})} />
          </div>
          
          <div className="form-group">
            <label className="form-label">Observaciones</label>
            <textarea className="form-textarea" value={form.observations} onChange={e => setForm({...form, observations: e.target.value})} />
          </div>
          
          <button type="submit" className="btn btn-primary btn-block">Guardar</button>
        </form>
      </div>
    </div>
  );
}

function RentalsPage({ data, updateData }) {
  const { rentals, patients, equipment, settings } = data;
  const [filter, setFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingRental, setEditingRental] = useState(null);

  const getPatientName = (id) => patients.find(p => p.id === id)?.name || '-';
  const getEquipmentName = (id) => equipment.find(e => e.id === id)?.name || '-';

  // La busqueda mira TODO el alquiler: paciente (nombre, telefono, direccion,
  // DNI, observaciones), equipo (nombre, serie, tipo, descripcion) y el alquiler
  // en si (notas, estado, precio, fechas y los equipos del detalle).
  const textoDelAlquiler = (r) => {
    const p = patients.find(x => x.id === r.patientId) || {};
    const e = equipment.find(x => x.id === r.equipmentId) || {};
    return [
      p.name, p.phone, p.address, p.dni, p.observations,
      e.name, e.serialNumber, e.type, e.description,
      r.notes, r.status, r.price, r.startDate, r.endDate,
      r.startDate && formatDate(r.startDate), r.endDate && formatDate(r.endDate),
      (r.items || []).map(i => i && i.name).join(' ')
    ].filter(Boolean).join(' ').toLowerCase();
  };
  const coincideBusqueda = (r, texto) => coincideTexto(textoDelAlquiler(r), texto);

  const rentTodayStr = getToday();
  // Solo "vencen hoy" arriba. Los "por vencer" (proximos DIAS_AVISO dias) ocupaban
  // mucho lugar en esta pantalla: se ven en Inicio, en la tarjeta "Por vencer".
  const expiringToday = rentals.filter(r => r.endDate === rentTodayStr && r.status !== 'finalizado');

  const finalizadoKey = (r) => r.finalizedAt || (r.endDate ? r.endDate + 'T00:00:00' : '') || r.createdAt || '';
  const filteredRentals = rentals.filter(r => {
    if (filter === 'activo' && r.status !== 'activo') return false;
    if (filter === 'vencido' && r.status !== 'vencido' && !isRentalExpired(r)) return false;
    if (filter === 'finalizado' && r.status !== 'finalizado') return false;
    if (search.trim() && !coincideBusqueda(r, search)) return false;
    return true;
  }).sort((a, b) => {
    // En "finalizado", los ultimos finalizados primero; en el resto, los mas
    // nuevos primero (alta mas reciente arriba).
    if (filter === 'finalizado') return finalizadoKey(b).localeCompare(finalizadoKey(a));
    return masNuevoPrimero(a, b);
  });

  // Remito de ENTREGA al crear el alquiler (o al agregarle equipos). El de retiro sale
  // con la baja (emitirRemitoRetiro, mas arriba) y deja el numero guardado en el alquiler.
  const emitirRemitoEntrega = async (patientId, equipmentIds) => {
    const p = patients.find(x => x.id === patientId);
    // Cada entrada es { id, period }: el periodo del alquiler (mensual / 15 dias)
    // sale escrito en el remito.
    const equipos = equipmentIds
      .map(x => {
        const e = equipment.find(eq => eq.id === x.id);
        return e ? { name: e.name, serialNumber: e.serialNumber, periodo: x.period === 'quincenal' ? 'quincenal' : 'mensual' } : null;
      })
      .filter(Boolean);
    if (equipos.length === 0) {
      alert('No se pudo armar el remito: no se encontró el equipo del alquiler. Podés emitirlo después con el botón Remito.');
      return;
    }
    const res = await armarYEntregarRemito({
      tipo: 'entrega',
      paciente: p?.name || 'Sin paciente',
      telefono: p?.phone || '',
      direccion: p?.address || '',
      dni: p?.dni || '',
      equipos,
      fecha: getToday(),
      numero: generateDocNumber('ENT', p?.name || ''),
    }, settings);
    if (!res.ok) {
      alert('No se pudo ARMAR el remito de entrega.\n\nMotivo: ' + (res.error && res.error.message ? res.error.message : res.error)
        + '\n\nPodés reintentar con el botón Remito del alquiler.');
    }
  };

  // Emitir el remito a mano cuando el automatico no salio, o si hace falta otra copia.
  // Las copias del remito de retiro conservan el numero y la fecha originales.
  const handleRemitoManual = (rental) => {
    const esRetiro = rental.status === 'finalizado';
    const quien = getPatientName(rental.patientId);
    if (!confirm(`¿Generar el remito de ${esRetiro ? 'retiro' : 'entrega'} de ${quien}?`)) return;
    if (esRetiro) emitirRemitoRetiro(rental, data, updateData);
    else emitirRemitoEntrega(rental.patientId, [{ id: rental.equipmentId, period: rental.period }]);
  };

  // Baja del alquiler desde esta lista: finaliza, libera el equipo y emite el remito de retiro.
  const handleBaja = (rental) => {
    const eq = equipment.find(e => e.id === rental.equipmentId);
    const msg = `¿Dar de baja el alquiler de ${getPatientName(rental.patientId)}?\n\n`
      + `Equipo: ${eq?.name || 'sin equipo'}\n\n`
      + `- Se genera el remito de retiro (PDF)\n`
      + `- El equipo vuelve al stock para alquilar\n`
      + `- El alquiler pasa a Finalizados`;
    if (!confirm(msg)) return;
    darDeBajaAlquiler(rental, data, updateData);
  };

  const handleSave = (payload) => {
    const confirmMsg = editingRental
      ? `¿Guardar los cambios del alquiler de ${getPatientName(payload.update?.patientId || payload.patientId)}?`
      : Array.isArray(payload)
        ? (payload.length === 1 ? `¿Crear el alquiler de ${getPatientName(payload[0].patientId)}?` : `¿Crear ${payload.length} alquileres?`)
        : `¿Crear el alquiler de ${getPatientName(payload.patientId)}?`;
    if (!confirm(confirmMsg)) return;

    // Detectar que remitos corresponde emitir despues de guardar. Pueden ser DOS a la
    // vez (retiro del alquiler que se finaliza + entrega de equipos agregados): antes
    // el de entrega pisaba al de retiro y la baja quedaba sin remito.
    let retiro = null;   // alquiler (ya editado) que pasa a finalizado
    let retiroFinal = null; // ese mismo alquiler tal como queda guardado (con fecha de baja y marcas)
    let entrega = null;  // { patientId, equipmentIds }
    if (!editingRental) {
      const nuevos = Array.isArray(payload) ? payload : [payload];
      entrega = { patientId: nuevos[0]?.patientId, equipmentIds: nuevos.map(r => ({ id: r.equipmentId, period: r.period })) };
    } else {
      const actualizado = payload.update || payload;
      // Pasa a finalizado (antes no lo estaba) -> remito de retiro.
      if (actualizado.status === 'finalizado' && editingRental.status !== 'finalizado') retiro = actualizado;
      // Equipos extra agregados al mismo paciente -> remito de entrega por esos.
      if (payload.create?.length) {
        entrega = { patientId: payload.create[0].patientId, equipmentIds: payload.create.map(r => ({ id: r.equipmentId, period: r.period })) };
      }
    }
    updateData(cur => {
      // Sella la fecha de finalizacion cuando un alquiler pasa a "finalizado" y lo deja
      // marcado con el remito de retiro pendiente. Si vuelve a estar en curso, se
      // limpia la marca del remito: la proxima baja genera uno nuevo.
      const ahoraIso = new Date().toISOString();
      const stamp = (nr) => sellarFinalizacion(cur.rentals.find(r => r.id === nr.id), nr, ahoraIso);
      let newRentals = [...cur.rentals];
      if (editingRental && payload.update) {
        newRentals = newRentals.map(r => r.id === payload.update.id ? stamp(payload.update) : r);
        if (payload.create?.length) {
          const createdAt = getToday();
          newRentals = [...newRentals, ...payload.create.map(r => stamp({ ...r, id: generateId(), createdAt }))];
        }
      } else if (editingRental) {
        newRentals = newRentals.map(r => r.id === payload.id ? stamp(payload) : r);
      } else if (Array.isArray(payload)) {
        const createdAt = getToday();
        newRentals = [...newRentals, ...payload.map(r => stamp({ ...r, id: generateId(), createdAt }))];
      } else {
        newRentals = [...newRentals, stamp({ ...payload, id: generateId(), createdAt: getToday() })];
      }
      if (retiro) retiroFinal = newRentals.find(r => r.id === retiro.id) || null;
      return { ...cur, rentals: newRentals };
    });
    setShowModal(false);
    setEditingRental(null);
    // Emitir los remitos correspondientes (no bloquean el guardado).
    if (retiroFinal) emitirRemitoRetiro(retiroFinal, data, updateData, { bajaNueva: true });
    if (entrega) emitirRemitoEntrega(entrega.patientId, entrega.equipmentIds);
  };

  const handleDelete = (id) => {
    const rental = rentals.find(r => r.id === id);
    if (rental && rental.status !== 'finalizado') {
      // Borrar un alquiler en curso NO genera remito de retiro y no deja registro de
      // la baja: asi se perdieron bajas reales. Para retirar un equipo esta "Dar de baja".
      if (!confirm(`ATENCIÓN: "Eliminar" borra el alquiler de ${getPatientName(rental.patientId)} para siempre, SIN remito de retiro y sin dejar registro de la baja.\n\n`
        + 'Si el equipo se retiró, cancelá y usá el botón "Dar de baja".\n\n'
        + '¿Eliminar igual? (solo para un alquiler cargado por error)')) return;
    } else if (estadoRemitoRetiro(rental) === 'pendiente') {
      // La marca "Remito pendiente" es el unico rastro de que falta el remito de esa baja.
      if (!confirm(`Este alquiler de ${getPatientName(rental.patientId)} todavía tiene el remito de retiro PENDIENTE. Si lo eliminás se pierde ese aviso.\n\n`
        + 'Cancelá y usá el botón "Remito" para generarlo.\n\n'
        + '¿Eliminar igual?')) return;
    } else if (!confirm('¿Eliminar alquiler?')) {
      return;
    }
    updateData(cur => ({ ...cur, rentals: cur.rentals.filter(r => r.id !== id) }));
  };

  const handleUnificarVencimientos = () => {
    const count = rentals.filter(r => r.status !== 'finalizado' && r.startDate).length;
    if (!confirm(`¿Normalizar vencimientos de ${count} alquileres? Cada uno quedara a 1 mes de su fecha de inicio, avanzando mes a mes hasta el proximo vencimiento. Los que tienen periodos vencidos sin pagar conservan su vencimiento.`)) return;
    updateData(cur => ({
      ...cur,
      rentals: cur.rentals.map(r => {
        if (r.status === 'finalizado' || !r.startDate) return r;
        const periodo = periodoDe(r);
        // Con periodos vencidos sin pagar NO se adelanta: antes los saltaba al
        // proximo mes, la deuda desaparecia de Vencidos y nunca llegaba el aviso.
        // Solo se corrige el dia para que coincida con el de inicio.
        if (r.endDate && periodosImpagos(r).length > 0) {
          const aligned = alignDueDay(r.endDate, r.startDate, periodo);
          return aligned !== r.endDate ? { ...r, endDate: aligned } : r;
        }
        const D = rollingDueDate(r.startDate, periodo);
        if (!D) return r;
        // Si el periodo que vence en D ya esta pago, el vencimiento es el siguiente
        // (antes lo traia de vuelta a D y marcaba vencido un mes ya cobrado).
        const newEndDate = isPaidKey(r, claveDePeriodo(D, periodo)) ? nextDueAfter(D, r.startDate, periodo) : D;
        return newEndDate !== r.endDate ? { ...r, endDate: newEndDate } : r;
      })
    }));
  };

  // Reseña: en alquileres nuevos (iniciados en los ultimos 60 dias) que todavia
  // no la pidieron. Se usa recencia y no mes calendario para que el boton no
  // desaparezca al cambiar de mes.
  const rentHoy = getToday();
  const rentHace60 = (() => { const d = new Date(rentHoy + 'T00:00:00'); d.setDate(d.getDate() - 60); return toLocalDateStr(d); })();
  const esNuevoParaResena = (r) => r.status !== 'finalizado' && !r.reviewSent && r.startDate && r.startDate >= rentHace60 && r.startDate <= rentHoy;

  const handleReview = (rental) => {
    const name = getPatientName(rental.patientId);
    const phone = patients.find(p => p.id === rental.patientId)?.phone || '';
    if (!confirm(`¿Enviar pedido de reseña a ${name} por WhatsApp?`)) return;
    const msg = `Hola ${name}, soy SERGIO de INSER SALUD. Gracias por confiar en nosotros. Si quedaste conforme, ¿nos darías una mano con una reseña en Google? Te toma 30 segundos 👉 https://g.page/r/CZW6Qq0aHAUAEBM/review ¡Gracias!`;
    sendWhatsApp(phone, msg);
    updateData(cur => ({ ...cur, rentals: cur.rentals.map(r => r.id === rental.id ? { ...r, reviewSent: true } : r) }));
  };

  const handleReminder = (rental) => {
    const name = getPatientName(rental.patientId);
    const equipo = getEquipmentName(rental.equipmentId);
    const phone = patients.find(p => p.id === rental.patientId)?.phone || '';
    if (!confirm(`¿Enviar recordatorio de vencimiento a ${name} por WhatsApp?`)) return;
    const msg = `Hola ${name}, soy Santi de INSER SALUD. Te recuerdo el vencimiento del alquiler del equipo ${equipo} (vence el ${formatDate(rental.endDate)}). ¡Gracias!`;
    sendWhatsApp(phone, msg);
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Alquileres</h1>
        <p className="page-subtitle">{rentals.length} alquileres registrados</p>
      </div>

      {expiringToday.length > 0 && (
        <div className="aviso aviso-hoy">
          <div className="aviso-titulo"><span className="dot dot-rojo" /> Vencen hoy ({expiringToday.length})</div>
          {expiringToday.map(r => (
            <div key={r.id} style={{ fontSize: 13.5, marginTop: 2 }}>
              • {getPatientName(r.patientId)} — {getEquipmentName(r.equipmentId)} — vence {formatDate(r.endDate)}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 12, marginBottom: 15 }}>
        <input type="text" className="form-input" placeholder="Buscar por paciente, teléfono, equipo, serie, dirección, notas..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="filters">
        {['todos', 'activo', 'vencido', 'finalizado'].map(f => (
          <button key={f} className={`filter-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => { setEditingRental(null); setShowModal(true); }}>
          + Agregar Alquiler
        </button>
        <button className="btn btn-secondary" onClick={handleUnificarVencimientos} title="Establece el vencimiento a 1 mes de la fecha de inicio, avanzando mes a mes hasta el proximo vencimiento">
          <Icon name="calendar" size={16} /> Normalizar vencimientos
        </button>
      </div>

      {filteredRentals.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="clipboard" size={28} /></div>
          <div className="empty-title">Sin Alquileres</div>
        </div>
      ) : (
        <div className="card card-tabla" style={{ overflowX: 'auto', padding: 0 }}>
          <div style={{ overflowX: 'auto', width: '100%' }}>
            <table className="table table-alquileres">
              <thead>
                <tr>
                  <th>Paciente</th>
                  <th>Equipo</th>
                  <th>Inicio</th>
                  <th>Fin</th>
                  <th>Precio</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredRentals.map(rental => {
                  const status = isRentalExpired(rental) ? 'vencido' : rental.status;
                  return (
                    <tr key={rental.id}>
                      <td className="td-paciente">{getPatientName(rental.patientId)}</td>
                      <td className="td-equipo"><div className="celda-equipo"><EquipoFoto equipo={equipment.find(e => e.id === rental.equipmentId)} size={36} /><span className="txt">{getEquipmentName(rental.equipmentId)}</span></div></td>
                      <td data-label="Inicio">{formatDate(rental.startDate)}</td>
                      <td data-label="Vence">{formatDate(rental.endDate)}</td>
                      <td data-label="Precio"><span>{formatCurrency(rental.price)}<span className="periodo" style={{ fontSize: 11.5, color: periodoDe(rental) === 'quincenal' ? 'var(--warn)' : 'var(--muted)', fontWeight: 700 }}>{PERIODO_LABEL[periodoDe(rental)]}</span></span></td>
                      <td data-label="Estado">
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={`badge badge-${status}`}>{status}</span>
                          {estadoRemitoRetiro(rental) === 'pendiente' && <span className="badge badge-por_vencer" title="La baja quedó registrada, pero el remito de retiro no se generó o no se pudo descargar. Usá el botón Remito.">Remito pendiente</span>}
                        </div>
                      </td>
                      <td className="td-acciones">
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <button className="btn btn-sm btn-secondary" onClick={() => { setEditingRental(rental); setShowModal(true); }} title="Editar" aria-label="Editar"><Icon name="edit" size={16} /></button>
                          <button className="btn btn-sm btn-secondary" title={rental.status === 'finalizado' ? (estadoRemitoRetiro(rental) === 'emitido' ? 'Descargar otra copia del remito de retiro' : 'Generar remito de retiro') : 'Generar remito de entrega'} onClick={() => handleRemitoManual(rental)}><Icon name="file" size={15} /><span className="btn-txt">Remito</span></button>
                          {rental.status !== 'finalizado' && (
                            <button className="btn btn-sm btn-danger" onClick={() => handleBaja(rental)} title="Dar de baja: genera remito de retiro y libera el equipo" aria-label="Dar de baja"><Icon name="stop" size={15} /><span className="btn-txt">Dar de baja</span></button>
                          )}
                          <button className="btn btn-sm btn-danger" onClick={() => handleDelete(rental.id)} title={rental.status !== 'finalizado' ? 'Eliminar (borra sin remito ni registro; para retirar un equipo usa Dar de baja)' : 'Eliminar'} aria-label="Eliminar"><Icon name="trash" size={16} /></button>
                          {esNuevoParaResena(rental) && (
                            <button className="btn btn-sm btn-success" title="Pedir reseña en Google" onClick={() => handleReview(rental)}><Icon name="star" size={15} /><span className="btn-txt">Reseña</span></button>
                          )}
                          {status === 'vencido' && (
                            <button className="btn btn-sm" style={{ background: '#16A34A', color: '#fff' }} title="Enviar recordatorio de vencimiento por WhatsApp" onClick={() => handleReminder(rental)}><Icon name="whatsapp" size={15} /><span className="btn-txt">Recordatorio</span></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showModal && (
        <RentalModal
          rental={editingRental}
          patients={patients}
          equipment={equipment}
          rentals={rentals}
          onSave={handleSave} 
          onAddPatient={(patient) => {
            if (!confirm(`¿Agregar el paciente "${patient.name}"?`)) return null;
            const newPatient = { ...patient, id: generateId(), createdAt: getToday() };
            updateData(currentData => ({
              ...currentData,
              patients: [...currentData.patients, newPatient]
            }));
            return newPatient;
          }}
          onClose={() => { setShowModal(false); setEditingRental(null); }} 
        />
      )}
    </div>
  );
}

function nextMonthDate(start) {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return '';
  const [y, m, d] = start.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  const maxDay = new Date(ny, nm, 0).getDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, maxDay)).padStart(2, '0')}`;
}

// El vencimiento SIEMPRE cae el dia de inicio. Esta funcion ajusta solo el dia
// de una fecha (manteniendo mes/anio) al dia de inicio, corrigiendo el desfase
// de +/-1 que arrastraban datos viejos. Si el dia no existe (ej: 31 en feb),
// usa el ultimo dia del mes.
function alignDueDay(refDate, startDate, periodo) {
  if (periodo === 'quincenal') return refDate; // la quincena no cae en el dia de inicio
  if (!refDate || !startDate || !/^\d{4}-\d{2}-\d{2}$/.test(refDate) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return refDate;
  const [y, m] = refDate.split('-').map(Number);
  const startDay = Number(startDate.split('-')[2]);
  const maxDay = new Date(y, m, 0).getDate();
  const day = Math.min(startDay, maxDay);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Proximo vencimiento: el dia de INICIO, en el mes siguiente al vencimiento actual.
function nextDueAfter(refDate, startDate, periodo) {
  if (periodo === 'quincenal') {
    return refDate && /^\d{4}-\d{2}-\d{2}$/.test(refDate) ? addDaysStr(refDate, 15) : addDaysStr(startDate, 15);
  }
  if (!refDate || !/^\d{4}-\d{2}-\d{2}$/.test(refDate)) return nextMonthDate(startDate);
  const [y, m] = refDate.split('-').map(Number);
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return alignDueDay(`${ny}-${String(nm).padStart(2, '0')}-01`, startDate || refDate);
}

// Vencimiento = un mes despues del inicio, avanzando mes a mes sucesivamente
// hasta el primer vencimiento que sea hoy o futuro. Asi los alquileres viejos
// quedan con el proximo vencimiento real (no uno pasado que marque todo vencido).
function rollingDueDate(start, periodo) {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return '';
  if (periodo === 'quincenal') {
    const hoy = getToday();
    let due = addDaysStr(start, 15);
    let guard = 0;
    while (due < hoy && guard < 400) { due = addDaysStr(due, 15); guard++; }
    return due;
  }
  const [y, m, d] = start.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let year = y, month = m;
  let due;
  do {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    const maxDay = new Date(year, month, 0).getDate();
    due = new Date(year, month - 1, Math.min(d, maxDay));
  } while (due < today);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
}

// El vencimiento de un alquiler nunca puede estar a mas de un mes (un periodo)
// del que corresponde por fecha de inicio. D = primer vencimiento (dia de inicio)
// que cae hoy o despues. Si ese mes ya esta pagado, el tope es el mes siguiente;
// si no, es D. Si la fecha cargada quedo mas adelante, se la trae al tope.
function cappedDueDate(rental) {
  if (!rental.startDate || !rental.endDate) return rental.endDate;
  const periodo = periodoDe(rental);
  const D = rollingDueDate(rental.startDate, periodo);
  if (!D) return rental.endDate;
  const paidActual = isPaidKey(rental, claveDePeriodo(D, periodo));
  const tope = paidActual ? nextDueAfter(D, rental.startDate, periodo) : D;
  return rental.endDate > tope ? tope : rental.endDate;
}

function RentalModal({ rental, patients, equipment, rentals, onSave, onAddPatient, onClose }) {
  const isEditing = Boolean(rental);
  const [form, setForm] = useState(() => {
    if (rental) return rental;
    const start = getToday();
    return { patientId: '', startDate: start, status: 'activo', notes: '' };
  });
  const [items, setItems] = useState(() => {
    if (rental) return [];
    return [{ equipmentId: '', period: 'mensual', endDate: nextMonthDate(getToday()), price: '' }];
  });
  // Primer vencimiento segun el periodo: +1 mes (dia de inicio) o +15 dias.
  const primerVencimiento = (start, periodo) => (periodo === 'quincenal' ? addDaysStr(start, 15) : nextMonthDate(start));
  const equipoDe = (id) => equipment.find(e => e.id === id);
  const [showNewPatient, setShowNewPatient] = useState(false);
  const [newPatient, setNewPatient] = useState({ name: '', phone: '', dni: '', address: '', observations: '' });

  const handleStartDateChange = (start) => {
    // El vencimiento sigue a la fecha de inicio segun el periodo. Editable luego a mano.
    setForm({ ...form, startDate: start, ...(isEditing ? { endDate: primerVencimiento(start, periodoDe(form)) } : {}) });
    if (!isEditing) {
      setItems(items.map(it => {
        const prevDefault = primerVencimiento(form.startDate, it.period);
        return { ...it, endDate: it.endDate === prevDefault || !it.endDate ? primerVencimiento(start, it.period) : it.endDate };
      }));
    }
  };

  // Al elegir equipo o periodo en una fila se completa el precio de ese equipo para ese
  // periodo y se recalcula el vencimiento. El precio queda editable a mano.
  const elegirEquipoEnFila = (idx, equipmentId) => {
    const it = items[idx];
    const precio = precioEquipoPorPeriodo(equipoDe(equipmentId), it.period);
    updateItem(idx, { equipmentId, price: precio > 0 ? precio : it.price });
  };
  const elegirPeriodoEnFila = (idx, period) => {
    const it = items[idx];
    const precio = precioEquipoPorPeriodo(equipoDe(it.equipmentId), period);
    updateItem(idx, { period, endDate: primerVencimiento(form.startDate, period), price: precio > 0 ? precio : it.price });
  };
  // Al editar: cambiar de periodo trae el precio del equipo para ese periodo y
  // recalcula el vencimiento desde el inicio (proximo periodo que cae hoy o despues).
  const cambiarPeriodoEdit = (period) => {
    const precio = precioEquipoPorPeriodo(equipoDe(form.equipmentId), period);
    const endDate = rollingDueDate(form.startDate, period) || form.endDate;
    setForm({ ...form, period, endDate, ...(precio > 0 ? { price: precio } : {}) });
  };

  const updateItem = (idx, patch) => {
    setItems(items.map((it, i) => i === idx ? { ...it, ...patch } : it));
  };

  const addItem = () => {
    setItems([...items, { equipmentId: '', period: 'mensual', endDate: nextMonthDate(form.startDate), price: '' }]);
  };

  const removeItem = (idx) => {
    if (items.length === 1) return;
    setItems(items.filter((_, i) => i !== idx));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.patientId) {
      alert('Selecciona un paciente');
      return;
    }
    if (isEditing) {
      if (!form.equipmentId) { alert('Selecciona un equipo'); return; }
      // Un equipo solo puede tener UN alquiler sin finalizar. Sin este chequeo, reactivar un alquiler
      // finalizado (o cambiarle el equipo) dejaba dos alquileres sobre la misma unidad.
      if (form.status !== 'finalizado') {
        const choque = ocupadoPorOtro(form.equipmentId, form.id);
        if (choque) { alert(`Ese equipo ya tiene un alquiler vigente con ${nombrePaciente(choque.patientId)}. Finaliza ese alquiler o elegi otro equipo.`); return; }
      }
      const validExtra = items.filter(it => it.equipmentId);
      const extraChoque = validExtra.map(it => ocupadoPorOtro(it.equipmentId, null)).find(Boolean);
      if (extraChoque) { alert(`El equipo agregado ya tiene un alquiler vigente con ${nombrePaciente(extraChoque.patientId)}.`); return; }
      if (validExtra.length > 0) {
        const extraRentals = validExtra.map(it => ({
          patientId: form.patientId,
          equipmentId: it.equipmentId,
          period: it.period || 'mensual',
          startDate: form.startDate,
          endDate: it.endDate,
          price: Number(it.price),
          // Un equipo que se entrega ahora nace en curso, aunque el alquiler que se
          // esta editando se finalice en este mismo guardado.
          status: form.status && form.status !== 'finalizado' ? form.status : 'activo',
          notes: form.notes || '',
        }));
        onSave({ update: { ...form, price: Number(form.price) }, create: extraRentals });
      } else {
        onSave({ ...form, price: Number(form.price) });
      }
      return;
    }
    if (!items.length || items.some(it => !it.equipmentId)) {
      alert('Selecciona el equipo en cada fila');
      return;
    }
    const ids = items.map(it => it.equipmentId);
    if (new Set(ids).size !== ids.length) {
      alert('Hay equipos repetidos');
      return;
    }
    const rentalsToCreate = items.map(it => ({
      patientId: form.patientId,
      equipmentId: it.equipmentId,
      period: it.period || 'mensual',
      startDate: form.startDate,
      endDate: it.endDate,
      price: Number(it.price),
      status: form.status || 'activo',
      notes: form.notes || '',
    }));
    onSave(rentalsToCreate);
  };

  // Equipo ocupado = tiene un alquiler no finalizado (activo o vencido). Evita reasignar un equipo que sigue afuera.
  const rentedEquipIds = new Set((rentals || []).filter(r => r.status !== 'finalizado').map(r => r.equipmentId));
  const ocupadoPorOtro = (equipId, rentalId) => (rentals || []).find(r => r.equipmentId === equipId && r.id !== rentalId && r.status !== 'finalizado');
  const nombrePaciente = (pid) => (patients || []).find(p => p.id === pid)?.name || 'otro paciente';
  const availableEquipment = isEditing ? equipment : equipment.filter(e => !rentedEquipIds.has(e.id));

  const handleAddNewPatient = () => {
    if (!newPatient.name) {
      alert('Ingrese nombre del paciente');
      return;
    }
    const patient = onAddPatient(newPatient);
    if (!patient) return; // el usuario cancelo la confirmacion
    setForm({ ...form, patientId: patient.id });
    setShowNewPatient(false);
    setNewPatient({ name: '', phone: '', dni: '', address: '', observations: '' });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{rental ? 'Editar' : 'Nuevo'} Alquiler</h2>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Paciente *</label>
            <div style={{ display: 'flex', gap: 5 }}>
              <select className="form-select" value={form.patientId} onChange={e => setForm({...form, patientId: e.target.value})} required style={{ flex: 1 }}>
                <option value="">Seleccionar...</option>
                {ordenNuevosPrimero(patients).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button type="button" className="btn" onClick={() => setShowNewPatient(!showNewPatient)} aria-label="Sumar"><Icon name="plus" size={16} /></button>
            </div>
          </div>

          {showNewPatient && (
            <div style={{ background: '#FFF8E1', border: '1px solid #FFC107', borderRadius: 8, padding: 10, marginBottom: 15 }}>
              <h4 style={{ marginBottom: 10 }}>Nuevo Paciente</h4>
              <input type="text" className="form-input" placeholder="Nombre *" value={newPatient.name} onChange={e => setNewPatient({...newPatient, name: e.target.value})} style={{ marginBottom: 5 }} />
              <input type="text" className="form-input" placeholder="Teléfono" value={newPatient.phone} onChange={e => setNewPatient({...newPatient, phone: e.target.value})} style={{ marginBottom: 5 }} />
              <input type="text" className="form-input" placeholder="DNI" value={newPatient.dni} onChange={e => setNewPatient({...newPatient, dni: e.target.value})} style={{ marginBottom: 5 }} />
              <input type="text" className="form-input" placeholder="Dirección" value={newPatient.address} onChange={e => setNewPatient({...newPatient, address: e.target.value})} style={{ marginBottom: 5 }} />
              <button type="button" className="btn btn-primary btn-sm" onClick={handleAddNewPatient}>Agregar Paciente</button>
            </div>
          )}
          
          <div className="form-group">
            <label className="form-label">Fecha de inicio</label>
            <input type="date" className="form-input" value={form.startDate} onChange={e => handleStartDateChange(e.target.value)} />
          </div>

          {isEditing ? (
            <>
              <div className="form-group">
                <label className="form-label">Equipo * <span style={{ fontWeight: 400, color: '#5A6978', fontSize: 12 }}>(solo equipos en stock)</span></label>
                <select className="form-select" value={form.equipmentId} onChange={e => setForm({...form, equipmentId: e.target.value})} required>
                  <option value="">Seleccionar...</option>
                  {equipment
                    .filter(e => e.id === form.equipmentId || (!rentedEquipIds.has(e.id) && e.status !== 'mantenimiento'))
                    .map(e => (
                      <option key={e.id} value={e.id}>
                        {e.name} ({e.serialNumber}){e.id === form.equipmentId ? ' — actual' : ''}
                      </option>
                    ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Periodo</label>
                <select className="form-select" value={periodoDe(form)} onChange={e => cambiarPeriodoEdit(e.target.value)}>
                  <option value="mensual">Mensual</option>
                  <option value="quincenal">15 dias</option>
                </select>
                <div style={{ fontSize: 12, color: '#5A6978', marginTop: 4 }}>Al cambiar el periodo se toma el precio del equipo para ese periodo y se recalcula el vencimiento.</div>
              </div>
              <div className="form-group">
                <label className="form-label">Fecha de fin</label>
                <input type="date" className="form-input" value={form.endDate} onChange={e => setForm({...form, endDate: e.target.value})} />
              </div>
              <div className="form-group">
                <label className="form-label">Precio {periodoDe(form) === 'quincenal' ? 'por 15 dias' : 'mensual'} ($)</label>
                <input type="number" className="form-input" value={form.price} onChange={e => setForm({...form, price: e.target.value})} />
              </div>
            </>
          ) : (
            <div className="form-group">
              <label className="form-label">Equipos *</label>
              {items.map((it, idx) => {
                const usedIds = items.filter((_, i) => i !== idx).map(x => x.equipmentId).filter(Boolean);
                const options = availableEquipment.filter(e => !usedIds.includes(e.id));
                return (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 104px 140px 110px auto', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                    <select className="form-select" value={it.equipmentId} onChange={e => elegirEquipoEnFila(idx, e.target.value)} required>
                      <option value="">Equipo...</option>
                      {options.map(e => <option key={e.id} value={e.id}>{e.name} ({e.serialNumber})</option>)}
                    </select>
                    <select className="form-select" value={it.period || 'mensual'} onChange={e => elegirPeriodoEnFila(idx, e.target.value)} title="Periodo">
                      <option value="mensual">Mensual</option>
                      <option value="quincenal">15 dias</option>
                    </select>
                    <input type="date" className="form-input" value={it.endDate} onChange={e => updateItem(idx, { endDate: e.target.value })} title="Vencimiento" />
                    <input type="number" className="form-input" placeholder="Precio" value={it.price} onChange={e => updateItem(idx, { price: e.target.value })} />
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => removeItem(idx)} disabled={items.length === 1}>×</button>
                  </div>
                );
              })}
              <button type="button" className="btn btn-sm btn-secondary" onClick={addItem}>+ Agregar equipo</button>
            </div>
          )}

          {isEditing && (
            <div className="form-group">
              <label className="form-label">Estado</label>
              <select className="form-select" value={form.status} onChange={e => setForm({...form, status: e.target.value})}>
                <option value="activo">Activo</option>
                <option value="vencido">Vencido</option>
                <option value="finalizado">Finalizado</option>
              </select>
            </div>
          )}

          {isEditing && (
            <div className="form-group" style={{ marginTop: 12, paddingTop: 12, borderTop: '2px dashed #90CAF9' }}>
              <label className="form-label" style={{ color: '#1E5AA8', fontWeight: 700 }}>Agregar otro equipo al mismo paciente</label>
              {items.map((it, idx) => {
                const usedIds = items.filter((_, i) => i !== idx).map(x => x.equipmentId).filter(Boolean);
                const options = equipment.filter(e => !rentedEquipIds.has(e.id) && !usedIds.includes(e.id) && e.id !== form.equipmentId);
                return (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 104px 140px 110px auto', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                    <select className="form-select" value={it.equipmentId} onChange={e => elegirEquipoEnFila(idx, e.target.value)}>
                      <option value="">Equipo...</option>
                      {options.map(e => <option key={e.id} value={e.id}>{e.name} ({e.serialNumber})</option>)}
                    </select>
                    <select className="form-select" value={it.period || 'mensual'} onChange={e => elegirPeriodoEnFila(idx, e.target.value)} title="Periodo">
                      <option value="mensual">Mensual</option>
                      <option value="quincenal">15 dias</option>
                    </select>
                    <input type="date" className="form-input" value={it.endDate} onChange={e => updateItem(idx, { endDate: e.target.value })} title="Vencimiento" />
                    <input type="number" className="form-input" placeholder="Precio" value={it.price} onChange={e => updateItem(idx, { price: e.target.value })} />
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => removeItem(idx)}>×</button>
                  </div>
                );
              })}
              <button type="button" className="btn btn-sm btn-secondary" onClick={addItem}>+ Agregar equipo</button>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Notas</label>
            <textarea className="form-textarea" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} />
          </div>
          
          <button type="submit" className="btn btn-primary btn-block">Guardar</button>
        </form>
      </div>
    </div>
  );
}

function EquipmentPage({ data, updateData }) {
  const { equipment, rentals, patients } = data;
  const [filter, setFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState(null);

  // Un equipo esta ocupado mientras tenga un alquiler no finalizado (activo o vencido).
  const getCurrentRental = (equipId) => getOccupyingRental(rentals, equipId);

  const getCurrentPatient = (equipId) => {
    const rental = getCurrentRental(equipId);
    return rental ? patients.find(p => p.id === rental.patientId) : null;
  };

  const filteredEquipment = [...equipment].sort((a, b) => {
    const idA = a.id || ''; const idB = b.id || '';
    return idB.localeCompare(idA);
  }).filter(e => {
    if (filter === 'disponible' && getCurrentRental(e.id)) return false;
    if (filter === 'alquilado' && !getCurrentRental(e.id)) return false;
    if (filter === 'mantenimiento' && e.status !== 'mantenimiento') return false;
    if (search) {
      const q = search.toLowerCase();
      const patient = getCurrentPatient(e.id);
      const hayMatch = (e.name || '').toLowerCase().includes(q)
        || (e.serialNumber || '').toLowerCase().includes(q)
        || (patient?.name || '').toLowerCase().includes(q);
      if (!hayMatch) return false;
    }
    return true;
  });

  const handleSave = (equip) => {
    // Al dar de alta puede venir una lista: una unidad por cada numero de serie.
    const esLista = Array.isArray(equip);
    const nombre = esLista ? (equip[0]?.name || '') : equip.name;
    const isNew = esLista || !equip.id;
    const msg = esLista
      ? `¿Agregar ${equip.length} equipos individuales de "${nombre}", uno por cada numero de serie?`
      : (isNew ? `¿Agregar el equipo "${nombre}"?` : `¿Guardar los cambios del equipo "${nombre}"?`);
    if (!confirm(msg)) return;
    updateData(cur => ({
      ...cur,
      equipment: esLista
        ? [...cur.equipment, ...equip.map(it => ({ ...it, id: generateId() }))]
        : isNew
          ? [...cur.equipment, { ...equip, id: generateId() }]
          : cur.equipment.map(e => e.id === equip.id ? equip : e)
    }));
    setShowModal(false);
    setEditingEquipment(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar equipo?')) {
      updateData(cur => ({ ...cur, equipment: cur.equipment.filter(e => e.id !== id) }));
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Equipos</h1>
        <p className="page-subtitle">{equipment.length} equipos registrados</p>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 15 }}>
        <input type="text" className="form-input" placeholder="Buscar por equipo, serie o paciente..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="filters">
        {['todos', 'disponible', 'alquilado', 'mantenimiento'].map(f => (
          <button key={f} className={`filter-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'disponible' ? <><span className="dot dot-verde" />Disponible</> : f === 'alquilado' ? <><span className="dot dot-rojo" />Alquilado</> : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <button className="btn btn-primary btn-block" onClick={() => { setEditingEquipment(null); setShowModal(true); }} style={{ marginBottom: 20 }}>
        + Agregar Equipo
      </button>

      {filteredEquipment.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="device" size={28} /></div>
          <div className="empty-title">Sin Equipos</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {filteredEquipment.map(equip => {
            const currentPatient = getCurrentPatient(equip.id);
            const isRented = !!currentPatient;
            return (
              <div key={equip.id} className="card" style={{ padding: 14, marginBottom: 0 }}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'center' }}>
                  <EquipoFoto equipo={equip} size={64} />
                  <div style={{ minWidth: 0 }}>
                    <div title={equip.name} style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--ink)', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{equip.name}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Serie: {equip.serialNumber}</div>
                  </div>
                </div>
                {isRented ? (
                  <div style={{ marginBottom: 8 }}><span className="badge badge-alquilado" style={{ textTransform: 'none', maxWidth: '100%' }}>Alquilado a {currentPatient.name}</span></div>
                ) : (
                  <div style={{ marginBottom: 8 }}><span className="badge badge-disponible">Disponible</span></div>
                )}
                {(equip.rentalPrice > 0 || equip.rentalPrice15 > 0) && (
                  <div style={{ fontSize: 12, color: '#1E5AA8', fontWeight: 600, marginBottom: 6 }}>
                    {equip.rentalPrice > 0 && <span>Alquiler: {formatCurrency(equip.rentalPrice)}/mes</span>}
                    {equip.rentalPrice > 0 && equip.rentalPrice15 > 0 && <span> · </span>}
                    {equip.rentalPrice15 > 0 && <span>{formatCurrency(equip.rentalPrice15)}/15 dias</span>}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => { setEditingEquipment({ ...equip, id: null, serialNumber: equip.serialNumber + '-COPY' }); setShowModal(true); }} aria-label="Duplicar" title="Duplicar"><Icon name="copy" size={16} /></button>
                  <button className="btn btn-sm btn-secondary" onClick={() => { setEditingEquipment(equip); setShowModal(true); }} title="Editar" aria-label="Editar"><Icon name="edit" size={16} /></button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(equip.id)} title="Eliminar" aria-label="Eliminar"><Icon name="trash" size={16} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <EquipmentModal equipment={editingEquipment} onSave={handleSave} onClose={() => { setShowModal(false); setEditingEquipment(null); }} />
      )}
    </div>
  );
}

function EquipmentModal({ equipment, onSave, onClose }) {
  const [form, setForm] = useState(equipment || { name: '', serialNumber: '', type: 'otro', status: 'disponible', description: '', available: true, imageUrl: '', ownership: 'propio', rentalPrice: '', rentalPrice15: '' });
  // Cada registro de Equipos es UNA unidad fisica. Por eso la cantidad solo aplica al alta:
  // se crean N equipos, uno por cada numero de serie.
  const [cantidad, setCantidad] = useState(1);
  const [serials, setSerials] = useState([equipment?.serialNumber || '']);
  const setCant = (v) => {
    const c = Math.max(1, Math.min(50, Number(v) || 1));
    setCantidad(c);
    setSerials(prev => { const a = [...prev]; while (a.length < c) a.push(''); return a.slice(0, c); });
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 600;
        const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        setForm(f => ({ ...f, imageUrl: dataUrl })); // vista previa inmediata
        // Se sube a Cloudflare R2 y queda solo la URL (no viaja en los datos de Supabase).
        // Si falla (sin internet, etc.), queda la foto en base64 como antes.
        subirFoto(dataUrl, 'equipos')
          .then(url => setForm(f => (f.imageUrl === dataUrl ? { ...f, imageUrl: url } : f)))
          .catch(err => console.warn('La foto quedo guardada localmente:', err.message));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const series = serials.slice(0, equipment ? 1 : cantidad).map(s => (s || '').trim());
    if (!form.name || series.some(s => !s)) {
      alert(series.length > 1 ? 'Nombre y el numero de serie de cada unidad son obligatorios' : 'Nombre y serie son obligatorios');
      return;
    }
    if (new Set(series).size !== series.length) { alert('Hay numeros de serie repetidos. Cada unidad tiene que tener el suyo.'); return; }
    const base = { ...form, rentalPrice: Number(form.rentalPrice) || 0, rentalPrice15: Number(form.rentalPrice15) || 0 };
    if (!equipment && series.length > 1) {
      onSave(series.map(s => ({ ...base, serialNumber: s })));
      return;
    }
    onSave({ ...base, serialNumber: series[0] });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{equipment ? 'Editar' : 'Nuevo'} Equipo</h2>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Nombre *</label>
            <input type="text" className="form-input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required />
          </div>
          
          {!equipment && (
            <div className="form-group">
              <label className="form-label">Cantidad</label>
              <input type="number" min="1" className="form-input" value={cantidad} onChange={e => setCant(e.target.value)} />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Número de serie {cantidad > 1 && !equipment ? 'por unidad *' : '*'}</label>
            {serials.slice(0, equipment ? 1 : cantidad).map((s, i) => (
              <input key={i} type="text" className="form-input" placeholder={cantidad > 1 && !equipment ? `Unidad ${i + 1}` : 'N° de serie'} value={s} onChange={e => setSerials(prev => prev.map((x, j) => j === i ? e.target.value : x))} style={{ marginBottom: 6 }} required />
            ))}
            {cantidad > 1 && !equipment && <div style={{ fontSize: 12, color: '#5A6978' }}>Se crearán {cantidad} equipos individuales, uno por cada número de serie.</div>}
          </div>
          
          <div className="form-group">
            <label className="form-label">Tipo</label>
            <select className="form-select" value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
              <option value="concentrador">Concentrador</option>
              <option value="mascara">Máscara</option>
              <option value="cilindro">Cilindro</option>
              <option value="ventilador">Ventilador</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          
          <div className="form-group">
            <label className="form-label">Estado</label>
            <select className="form-select" value={form.status} onChange={e => setForm({...form, status: e.target.value, available: e.target.value === 'disponible'})}>
              <option value="disponible">Disponible</option>
              <option value="alquilado">Alquilado</option>
              <option value="mantenimiento">Mantenimiento</option>
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">Precio de alquiler mensual $</label>
              <input type="number" className="form-input" placeholder="0" min="0" value={form.rentalPrice || ''} onChange={e => setForm({...form, rentalPrice: e.target.value})} />
            </div>
            <div className="form-group">
              <label className="form-label">Precio 15 dias $</label>
              <input type="number" className="form-input" placeholder="0" min="0" value={form.rentalPrice15 || ''} onChange={e => setForm({...form, rentalPrice15: e.target.value})} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Ownership</label>
            <select className="form-select" value={form.ownership} onChange={e => setForm({...form, ownership: e.target.value})}>
              <option value="propio">Propio</option>
              <option value="alquilado">Alquilado (tercero)</option>
            </select>
          </div>
          
          <div className="form-group">
            <label className="form-label">Descripción</label>
            <textarea className="form-textarea" value={form.description} onChange={e => setForm({...form, description: e.target.value})} />
          </div>
          
          <div className="form-group">
            <label className="form-label">Foto del equipo</label>
            <input type="file" accept="image/*" onChange={handleImageUpload} className="form-input" />
            {form.imageUrl && (
              <div style={{ marginTop: 10, textAlign: 'center' }}>
                <img src={form.imageUrl} alt="Preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8 }} />
                <button type="button" className="btn btn-sm btn-danger" style={{ marginTop: 5 }} onClick={() => setForm({ ...form, imageUrl: '' })}>
                  Eliminar foto
                </button>
              </div>
            )}
          </div>
          
          <button type="submit" className="btn btn-primary btn-block">Guardar</button>
        </form>
      </div>
    </div>
  );
}

function EquiposNuevosPage({ data, updateData }) {
  const { equiposNuevos } = data;
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');

  const filtered = (equiposNuevos || []).filter(e => !search || (e.name || '').toLowerCase().includes(search.toLowerCase()));

  // reemplazaId: el equipo existente se divide en varias unidades individuales, una por numero de serie
  const handleSave = (payload, reemplazaId) => {
    const isArray = Array.isArray(payload);
    const nombre = isArray ? (payload[0]?.name || '') : payload.name;
    const cant = isArray ? payload.length : 1;
    const msg = reemplazaId
      ? `"${nombre}" pasa a ser ${cant} equipos individuales, uno por cada numero de serie. ¿Confirmas?`
      : payload.id
        ? `¿Guardar los cambios de "${nombre}"?`
        : (cant > 1 ? `¿Agregar ${cant} unidades individuales de "${nombre}" al catalogo?` : `¿Agregar "${nombre}" al catalogo?`);
    if (!confirm(msg)) return;
    updateData(cur => {
      const lista = cur.equiposNuevos || [];
      if (reemplazaId) {
        // la primera unidad conserva el id original para no perder la posicion en el catalogo
        const unidades = payload.map((it, i) => ({ ...it, id: i === 0 ? reemplazaId : generateId() }));
        return { ...cur, equiposNuevos: lista.flatMap(e => e.id === reemplazaId ? unidades : [e]) };
      }
      return {
        ...cur,
        equiposNuevos: payload.id
          ? lista.map(e => e.id === payload.id ? payload : e)
          : [...lista, ...(isArray ? payload : [payload]).map(it => ({ ...it, id: generateId() }))]
      };
    });
    setShowModal(false);
    setEditing(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar equipo?')) {
      updateData(cur => ({ ...cur, equiposNuevos: (cur.equiposNuevos || []).filter(e => e.id !== id) }));
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Equipos Nuevos</h1>
        <p className="page-subtitle">{(equiposNuevos || []).length} equipos en catalogo</p>
      </div>
      <div className="card" style={{ padding: 12, marginBottom: 15 }}>
        <input type="text" className="form-input" placeholder="Buscar equipo..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-block" onClick={() => { setEditing(null); setShowModal(true); }} style={{ marginBottom: 20 }}>+ Agregar Equipo Nuevo</button>
      {filtered.length === 0 ? (
        <div className="empty-state"><div className="empty-icon"><Icon name="tag" size={28} /></div><div className="empty-title">Sin equipos nuevos</div></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {filtered.map(eq => (
            <div key={eq.id} className="card" style={{ padding: 14 }}>
              {eq.imageUrl && <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 10, height: 170, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}><img src={eq.imageUrl} alt={eq.name} loading="lazy" decoding="async" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /></div>}
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{eq.name}</div>
              {eq.description && <div style={{ fontSize: 13, color: '#5A6978', marginBottom: 4 }}>{eq.description}</div>}
              {eq.serialNumber && <div style={{ fontSize: 12, color: '#5A6978', marginBottom: 4 }}>N° serie: {eq.serialNumber}</div>}
              <div style={{ fontSize: 18, fontWeight: 700, color: '#1E5AA8' }}>{formatCurrency(eq.price)}</div>
              {eq.priceUsd > 0 && <div style={{ fontSize: 13, color: '#43A047', fontWeight: 600 }}>USD {eq.priceUsd}</div>}
              {eq.priceVentaUsd > 0 && <div style={{ fontSize: 12, color: '#5A6978' }}>Venta: USD {eq.priceVentaUsd}</div>}
              <div style={{ fontSize: 13, fontWeight: 600, color: Number(eq.stock) > 0 ? '#43A047' : '#E53935', marginBottom: 8 }}>Stock: {Number(eq.stock) || 0}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-secondary" title="Otra unidad con distinto N° de serie" onClick={() => { setEditing({ ...eq, id: null, serialNumber: '', stock: 1 }); setShowModal(true); }} aria-label="Duplicar" title="Duplicar"><Icon name="copy" size={16} /></button>
                <button className="btn btn-sm btn-secondary" onClick={() => { setEditing(eq); setShowModal(true); }} title="Editar" aria-label="Editar"><Icon name="edit" size={16} /></button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(eq.id)} title="Eliminar" aria-label="Eliminar"><Icon name="trash" size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showModal && (() => {
        const EquipoNuevoModal = () => {
          const [form, setForm] = useState(editing || { name: '', description: '', price: '', priceUsd: '', priceVentaUsd: '', stock: '', imageUrl: '', serialNumber: '' });
          const [cantidad, setCantidad] = useState(1);
          const [serials, setSerials] = useState(() => {
            if (!editing) return [''];
            const c = Math.max(1, Math.min(50, Number(editing.stock) || 1));
            const a = [editing.serialNumber || ''];
            while (a.length < c) a.push('');
            return a;
          });
          const ajustarFilas = (c) => setSerials(prev => { const a = [...prev]; while (a.length < c) a.push(''); return a.slice(0, c); });
          const setCant = (n) => {
            const c = Math.max(1, Math.min(50, Number(n) || 1));
            setCantidad(c);
            ajustarFilas(c);
          };
          // al editar, el stock manda cuantos numeros de serie se piden
          const setStock = (n) => {
            setForm(f => ({ ...f, stock: n }));
            ajustarFilas(Math.max(1, Math.min(50, Number(n) || 1)));
          };
          const unidadesEdit = Math.max(1, Math.min(50, Number(form.stock) || 1));
          const handleImg = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const r = new FileReader();
            r.onloadend = () => {
              const img = new Image();
              img.onload = () => {
                const MAX = 600;
                const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * ratio);
                canvas.height = Math.round(img.height * ratio);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        setForm(f => ({ ...f, imageUrl: dataUrl })); // vista previa inmediata
        // Se sube a Cloudflare R2 y queda solo la URL (no viaja en los datos de Supabase).
        // Si falla (sin internet, etc.), queda la foto en base64 como antes.
        subirFoto(dataUrl, 'equipos-nuevos')
          .then(url => setForm(f => (f.imageUrl === dataUrl ? { ...f, imageUrl: url } : f)))
          .catch(err => console.warn('La foto quedo guardada localmente:', err.message));
              };
              img.src = r.result;
            };
            r.readAsDataURL(file);
          };
          return (
            <div className="modal-overlay" onClick={() => { setShowModal(false); setEditing(null); }}>
              <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h2 className="modal-title">{editing && editing.id ? 'Editar' : 'Nuevo'} Equipo</h2>
                  <span className="modal-close" onClick={() => { setShowModal(false); setEditing(null); }}>x</span>
                </div>
                <form onSubmit={e => {
                  e.preventDefault();
                  if (!form.name) { alert('Nombre obligatorio'); return; }
                  const base = { ...form, price: Number(form.price), priceUsd: Number(form.priceUsd || 0), priceVentaUsd: Number(form.priceVentaUsd || 0) };
                  if (editing) {
                    const stk = Number(form.stock || 0);
                    const series = serials.slice(0, Math.max(1, stk)).map(s => (s || '').trim());
                    const cargadas = series.filter(Boolean);
                    if (new Set(cargadas).size !== cargadas.length) { alert('Hay numeros de serie repetidos. Cada unidad tiene que tener el suyo.'); return; }
                    if (stk >= 2 && cargadas.length >= 2) {
                      handleSave(series.map(s => ({ ...base, stock: 1, serialNumber: s })), editing.id);
                    } else {
                      handleSave({ ...base, id: editing.id, stock: stk, serialNumber: (series[0] || '') });
                    }
                  } else {
                    const items = serials.slice(0, cantidad).map(s => ({ ...base, stock: 1, serialNumber: (s || '').trim() }));
                    handleSave(items);
                  }
                }}>
                  <div className="form-group"><label className="form-label">Nombre *</label><input type="text" className="form-input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required /></div>
                  <div className="form-group"><label className="form-label">Descripcion (Marca / Modelo)</label><textarea className="form-textarea" value={form.description} onChange={e => setForm({...form, description: e.target.value})} /></div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="form-group"><label className="form-label">Precio ARS</label><input type="number" className="form-input" value={form.price} onChange={e => setForm({...form, price: e.target.value})} /></div>
                    {editing
                      ? <div className="form-group"><label className="form-label">Stock</label><input type="number" min="0" className="form-input" value={form.stock || ''} onChange={e => setStock(e.target.value)} /></div>
                      : <div className="form-group"><label className="form-label">Cantidad</label><input type="number" min="1" className="form-input" value={cantidad} onChange={e => setCant(e.target.value)} /></div>
                    }
                  </div>
                  {editing ? (
                    <div className="form-group">
                      <label className="form-label">N° de serie {unidadesEdit > 1 ? 'por unidad' : ''}</label>
                      {serials.slice(0, unidadesEdit).map((s, i) => (
                        <input key={i} type="text" className="form-input" placeholder={unidadesEdit > 1 ? `Unidad ${i + 1}` : 'N° de serie'} value={s} onChange={e => setSerials(prev => prev.map((x, j) => j === i ? e.target.value : x))} style={{ marginBottom: 6 }} />
                      ))}
                      {unidadesEdit > 1 && <div style={{ fontSize: 12, color: '#5A6978' }}>Si cargas el numero de serie de cada unidad, al guardar se separan en {unidadesEdit} equipos individuales.</div>}
                    </div>
                  ) : (
                    <div className="form-group">
                      <label className="form-label">N° de serie {cantidad > 1 ? 'por unidad' : ''}</label>
                      {serials.map((s, i) => (
                        <input key={i} type="text" className="form-input" placeholder={cantidad > 1 ? `Unidad ${i + 1}` : 'N° de serie'} value={s} onChange={e => setSerials(prev => prev.map((x, j) => j === i ? e.target.value : x))} style={{ marginBottom: 6 }} />
                      ))}
                      {cantidad > 1 && <div style={{ fontSize: 12, color: '#5A6978' }}>Se crearán {cantidad} equipos individuales, uno por cada número de serie.</div>}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="form-group"><label className="form-label">Precio USD</label><input type="number" className="form-input" value={form.priceUsd || ''} onChange={e => setForm({...form, priceUsd: e.target.value})} /></div>
                    <div className="form-group"><label className="form-label">Venta USD</label><input type="number" className="form-input" value={form.priceVentaUsd || ''} onChange={e => setForm({...form, priceVentaUsd: e.target.value})} /></div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Foto</label>
                    <input type="file" accept="image/*" onChange={handleImg} className="form-input" />
                    {form.imageUrl && <div style={{ marginTop: 10, textAlign: 'center' }}><img src={form.imageUrl} alt="Preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8 }} /><button type="button" className="btn btn-sm btn-danger" style={{ marginTop: 5 }} onClick={() => setForm({ ...form, imageUrl: '' })}>Eliminar foto</button></div>}
                  </div>
                  <button type="submit" className="btn btn-primary btn-block">Guardar</button>
                </form>
              </div>
            </div>
          );
        };
        return <EquipoNuevoModal />;
      })()}
    </div>
  );
}

function MascarasPage({ data, updateData }) {
  const { mascaras } = data;
  const [filter, setFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingMascara, setEditingMascara] = useState(null);

  const filteredMascaras = mascaras.filter(m => {
    if (filter === 'stock' && !(m.stock > 0)) return false;
    if (filter === 'bajo' && !(m.stock <= m.minStock)) return false;
    if (search) {
      const q = search.toLowerCase();
      const hayMatch = (m.name || '').toLowerCase().includes(q)
        || (m.type || '').toLowerCase().includes(q)
        || (m.description || '').toLowerCase().includes(q);
      if (!hayMatch) return false;
    }
    return true;
  });

  const handleSave = (mascara) => {
    const isNew = !mascara.id;
    if (!confirm(isNew ? `¿Agregar el producto "${mascara.name}"?` : `¿Guardar los cambios de "${mascara.name}"?`)) return;
    updateData(cur => ({
      ...cur,
      mascaras: isNew
        ? [...cur.mascaras, { ...mascara, id: generateId() }]
        : cur.mascaras.map(m => m.id === mascara.id ? mascara : m)
    }));
    setShowModal(false);
    setEditingMascara(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar?')) {
      updateData(cur => ({ ...cur, mascaras: cur.mascaras.filter(m => m.id !== id) }));
    }
  };

  const updateStock = (id, delta) => {
    const m = mascaras.find(x => x.id === id);
    if (!m) return;
    const nuevo = Math.max(0, m.stock + delta);
    if (nuevo === m.stock) return;
    if (!confirm(`¿Cambiar el stock de "${m.name}" de ${m.stock} a ${nuevo}?`)) return;
    updateData(cur => ({
      ...cur,
      mascaras: cur.mascaras.map(x => x.id === id ? { ...x, stock: nuevo } : x)
    }));
  };

  const handleDuplicate = (mascara) => {
    const duplicate = { 
      ...mascara, 
      id: null, 
      name: mascara.name + ' (copia)',
      stock: 0 
    };
    setEditingMascara(duplicate);
    setShowModal(true);
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Mascarillas y consumibles</h1>
        <p className="page-subtitle">{mascaras.length} productos</p>
      </div>

      <div className="search-box">
        <Icon name="search" size={18} />
        <input type="text" className="search-input" placeholder="Buscar por nombre, tipo o descripción..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="filters">
        {['todos', 'stock', 'bajo'].map(f => (
          <button key={f} className={`filter-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'todos' ? 'Todos' : f === 'stock' ? 'Con Stock' : 'Stock Bajo'}
          </button>
        ))}
      </div>

      <button className="btn btn-primary btn-block" onClick={() => { setEditingMascara(null); setShowModal(true); }} style={{ marginBottom: 20 }}>
        + Agregar Producto
      </button>

      {filteredMascaras.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="mask" size={28} /></div>
          <div className="empty-title">Sin Productos</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20 }}>
          {filteredMascaras.map(mascara => (
            <div key={mascara.id} className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ width: '100%', height: 190, background: '#fff', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {mascara.imageUrl ? (
                  <img src={mascara.imageUrl} alt={mascara.name} loading="lazy" decoding="async" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                ) : (
                  <img src="/img/equipos/mascara.webp" alt="" style={{ width: '55%', height: 'auto', opacity: 0.8 }} />
                )}
              </div>
              <div style={{ padding: '16px', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <strong style={{ fontSize: 16 }}>{mascara.name}</strong>
                  <div style={{ fontSize: 12, color: '#5A6978', marginTop: 2 }}>{mascara.type}</div>
                  {mascara.description && <div title={mascara.description} style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{mascara.description}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <button className="btn btn-sm" onClick={() => updateStock(mascara.id, -1)} aria-label="Restar"><Icon name="minus" size={16} /></button>
                  <span style={{
                    minWidth: 44,
                    textAlign: 'center',
                    color: mascara.stock <= mascara.minStock ? '#E53935' : '#43A047',
                    fontWeight: 'bold',
                    fontSize: 20
                  }}>
                    {mascara.stock}
                  </span>
                  <button className="btn btn-sm" onClick={() => updateStock(mascara.id, 1)} aria-label="Sumar"><Icon name="plus" size={16} /></button>
                  <span style={{ fontSize: 11, color: '#9AA5B4', marginLeft: 4 }}>min: {mascara.minStock}</span>
                </div>
                {mascara.precio > 0 && (
                  <div style={{ fontSize: 13, color: '#1565C0', fontWeight: 'bold' }}>{formatCurrency(mascara.precio)}</div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 8 }}>
                  <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} onClick={() => { setEditingMascara(mascara); setShowModal(true); }}><Icon name="edit" size={15} /> Editar</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => handleDuplicate(mascara)} aria-label="Duplicar" title="Duplicar"><Icon name="copy" size={16} /></button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(mascara.id)} title="Eliminar" aria-label="Eliminar"><Icon name="trash" size={16} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <MascaraModal mascara={editingMascara} onSave={handleSave} onClose={() => { setShowModal(false); setEditingMascara(null); }} />
      )}
    </div>
  );
}

function MascaraModal({ mascara, onSave, onClose }) {
  const [form, setForm] = useState(mascara || {
    name: '',
    type: 'mascarilla',
    stock: 0,
    minStock: 5,
    description: '',
    precio: 0,
    imageUrl: ''
  });

  // La foto se achica antes de guardarla (antes se guardaba tal cual: cada foto
  // de mascarilla pesaba 50-100 KB y se bajaba entera en cada ingreso a la app).
  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const img = new Image();
        img.onload = () => {
          const MAX = 480;
          const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        setForm(f => ({ ...f, imageUrl: dataUrl })); // vista previa inmediata
        // Se sube a Cloudflare R2 y queda solo la URL (no viaja en los datos de Supabase).
        // Si falla (sin internet, etc.), queda la foto en base64 como antes.
        subirFoto(dataUrl, 'mascarillas')
          .then(url => setForm(f => (f.imageUrl === dataUrl ? { ...f, imageUrl: url } : f)))
          .catch(err => console.warn('La foto quedo guardada localmente:', err.message));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name) {
      alert('Ingrese nombre');
      return;
    }
    onSave(form);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{mascara ? 'Editar' : 'Nuevo'} Producto</h2>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Nombre *</label>
            <input type="text" className="form-input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required />
          </div>
          
          <div className="form-group">
            <label className="form-label">Tipo</label>
            <select className="form-select" value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
              <option value="mascarilla">Mascarilla</option>
              <option value="filtro">Filtro</option>
              <option value="tubuladura">Tubuladura</option>
              <option value="canula">Cánula</option>
              <option value="otro">Otro</option>
            </select>
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Stock inicial</label>
              <input type="number" className="form-input" value={form.stock} onChange={e => setForm({...form, stock: Number(e.target.value)})} />
            </div>
            <div className="form-group">
              <label className="form-label">Stock mínimo</label>
              <input type="number" className="form-input" value={form.minStock} onChange={e => setForm({...form, minStock: Number(e.target.value)})} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Precio ($)</label>
            <input type="number" className="form-input" value={form.precio} onChange={e => setForm({...form, precio: Number(e.target.value)})} />
          </div>
          
          <div className="form-group">
            <label className="form-label">Descripción</label>
            <textarea className="form-textarea" value={form.description} onChange={e => setForm({...form, description: e.target.value})} />
          </div>

          <div className="form-group">
            <label className="form-label">Foto del producto</label>
            <input type="file" accept="image/*" onChange={handleImageUpload} className="form-input" />
            {form.imageUrl && (
              <div style={{ marginTop: 10, textAlign: 'center' }}>
                <img src={form.imageUrl} alt="Preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8 }} />
                <button type="button" className="btn btn-sm btn-danger" style={{ marginTop: 5 }} onClick={() => setForm({ ...form, imageUrl: '' })}>
                  Eliminar foto
                </button>
              </div>
            )}
          </div>

          <button type="submit" className="btn btn-primary btn-block">Guardar</button>
        </form>
      </div>
    </div>
  );
}

function SalesCartPage({ data, updateData, pageType }) {
  const { equipment, mascaras, descartables, equiposNuevos, patients, settings, quotations, invoices, remitos, rentals } = data;
  const isCotizacion = pageType === 'cotizacion';
  const isRemito = pageType === 'remito';
  const title = isRemito ? 'Remito' : (isCotizacion ? 'Cotizaciones' : 'Facturacion');
  const collectionKey = isRemito ? 'remitos' : (isCotizacion ? 'quotations' : 'invoices');
  const savedItems = isRemito ? (remitos || []) : (isCotizacion ? (quotations || []) : (invoices || []));

  const [cart, setCart] = useState([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('todos');
  const [showLibre, setShowLibre] = useState(false);
  const [libreItem, setLibreItem] = useState({ name: '', price: 0, quantity: 1 });
  const [sigFirma, setSigFirma] = useState('');
  const [sigAclaracion, setSigAclaracion] = useState('');
  const [sigDni, setSigDni] = useState('');

  const getEquipPrice = (equip) => {
    if (Number(equip.rentalPrice) > 0) return Number(equip.rentalPrice);
    const rental = (rentals || []).find(r => r.equipmentId === equip.id);
    if (rental && Number(rental.price) > 0) return Number(rental.price);
    if (equip.name) {
      const sameNameEquip = (equipment || []).find(e => e.id !== equip.id && e.name === equip.name && Number(e.rentalPrice) > 0);
      if (sameNameEquip) return Number(sameNameEquip.rentalPrice);
      const sameNameRental = (rentals || []).find(r => {
        const re = (equipment || []).find(e => e.id === r.equipmentId);
        return re && re.name === equip.name && Number(r.price) > 0;
      });
      if (sameNameRental) return Number(sameNameRental.price);
    }
    return 0;
  };

  const categories = [
    { value: 'todos', label: 'Todos' },
    // Los equipos son solo de alquiler: no se venden, asi que no van en factura ni cotizacion.
    ...(isRemito ? [{ value: 'equipos', label: 'Equipos (alquiler)' }] : []),
    { value: 'equiposNuevos', label: 'Equipos nuevos' },
    { value: 'mascarillas', label: 'Mascarillas' },
    { value: 'descartables', label: 'Descartables' }
  ];

  const allProducts = [
    ...(isRemito ? (equipment || []).map(e => ({ ...e, price: getEquipPrice(e), _cat: 'equipos', _label: 'Equipo' })) : []),
    ...(equiposNuevos || []).map(e => ({ ...e, _cat: 'equiposNuevos', _label: 'Equipo Nuevo' })),
    ...(mascaras || []).map(m => ({ ...m, price: m.precio || m.price || 0, _cat: 'mascarillas', _label: 'Mascarilla' })),
    ...(descartables || []).map(d => ({ ...d, _cat: 'descartables', _label: 'Descartable' }))
  ];

  const filtered = allProducts.filter(p => {
    if (category !== 'todos' && p._cat !== category) return false;
    if (search && !`${p.name || ''} ${serieDe(p)}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const addToCart = (product) => {
    const existing = cart.find(c => c.id === product.id);
    if (existing) {
      setCart(cart.map(c => c.id === product.id ? { ...c, quantity: c.quantity + 1 } : c));
    } else {
      setCart([...cart, { ...product, quantity: 1, price: Number(product.price) || 0 }]);
    }
  };

  const addLibre = () => {
    if (!libreItem.name || libreItem.price <= 0) { alert('Ingrese nombre y precio'); return; }
    setCart([...cart, { id: 'libre-' + Date.now(), name: libreItem.name, price: Number(libreItem.price), quantity: Number(libreItem.quantity) || 1, _cat: 'libre', _label: 'Item libre' }]);
    setLibreItem({ name: '', price: 0, quantity: 1 });
    setShowLibre(false);
  };

  const updateCartItem = (id, field, value) => setCart(cart.map(c => c.id === id ? { ...c, [field]: value } : c));
  const removeFromCart = (id) => setCart(cart.filter(c => c.id !== id));
  const clearCart = () => { setCart([]); setCustomerName(''); setCustomerPhone(''); setNotes(''); setSigFirma(''); setSigAclaracion(''); setSigDni(''); };
  const cartTotal = cart.reduce((s, c) => s + (c.price * c.quantity), 0);

  const buildWhatsAppMsg = () => {
    const prefix = isRemito ? 'REMITO' : (isCotizacion ? 'COTIZACION' : 'FACTURA');
    let msg = `*${settings.companyName || 'Inser Salud'}*\n*${prefix}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    if (customerName) msg += `*Cliente:* ${customerName}\n`;
    if (customerPhone) msg += `*Tel:* ${customerPhone}\n`;
    msg += `\n*DETALLE:*\n`;
    cart.forEach(c => { msg += `- ${c.name} x${c.quantity} = ${formatCurrency(c.price * c.quantity)}\n`; });
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*TOTAL: ${formatCurrency(cartTotal)}*\n`;
    if (notes) msg += `\n*Obs:* ${notes}\n`;
    if (isRemito) msg += `\n*RECIBI CONFORME*\nFirma: ___________\nAclaracion: ___________\nDNI: ___________\n`;
    msg += `\n${settings.companyPhone || ''}\n${settings.companyAddress || ''}`;
    return msg;
  };

  const handleWhatsApp = () => {
    if (cart.length === 0) { alert('Agregue productos'); return; }
    sendWhatsApp(customerPhone, buildWhatsAppMsg());
  };

  const handlePDF = async () => {
    if (cart.length === 0) { alert('Agregue productos'); return; }
    const prefix = isRemito ? 'REM' : (isCotizacion ? 'COT' : 'FAC');
    const docType = isRemito ? 'remito' : (isCotizacion ? 'cotizacion' : 'factura');
    if (!confirm(`¿Generar ${docType} para "${customerName || 'sin nombre'}" por ${formatCurrency(cartTotal)}?`)) return;
    const number = generateDocNumber(prefix, customerName);
    const invoiceData = {
      invoiceNumber: number,
      date: getToday(),
      clientName: customerName,
      clientPhone: customerPhone,
      // Al PDF van las fotos COMPLETAS (se ven al lado de la descripcion).
      // Solo el registro que se guarda va sin base64, por peso (ver mas abajo).
      items: cart.map(c => ({ name: nombreConSerie(c), price: c.price, quantity: c.quantity, imageUrl: c.imageUrl || '' })),
      total: cartTotal,
      notes,
      ...(isRemito ? { sigFirma, sigAclaracion, sigDni } : {})
    };
    try {
      const doc = await generateInvoicePDF(invoiceData, settings, docType);
      downloadInvoicePDF(doc, number, docType);
      const record = { id: generateId(), ...invoiceData, items: invoiceData.items.map(itemLiviano), customerName, customerPhone, cartItems: cart.map(itemLiviano), createdAt: getToday() };
      updateData(cur => {
        const next = { ...cur, [collectionKey]: [...(cur[collectionKey] || []), record] };
        // Solo al FACTURAR (no remito, no cotizacion) se descuenta el stock de mascaras y descartables.
        if (docType === 'factura') {
          const descontar = (arr, cat) => (arr || []).map(it => {
            const enCarrito = cart.find(c => c.id === it.id && c._cat === cat);
            if (!enCarrito) return it;
            return { ...it, stock: Math.max(0, Number(it.stock || 0) - Number(enCarrito.quantity || 1)) };
          });
          next.mascaras = descontar(cur.mascaras, 'mascarillas');
          next.descartables = descontar(cur.descartables, 'descartables');
        }
        return next;
      });
      alert(`${isRemito ? 'Remito' : (isCotizacion ? 'Cotizacion' : 'Factura')} ${number} generado`);
      clearCart();
    } catch (err) {
      console.error(err);
      alert('Error al generar PDF:\n\n' + (err?.message || err) + '\n\nSacale una foto a este mensaje si el problema se repite.');
    }
  };

  const handleDeleteSaved = (id) => {
    if (confirm('¿Eliminar?')) {
      updateData(cur => ({ ...cur, [collectionKey]: (cur[collectionKey] || []).filter(s => s.id !== id) }));
    }
  };

  const handleEditSaved = (s) => {
    if (!confirm(`¿Editar "${s.customerName || s.clientName || s.invoiceNumber || 'este documento'}"? Se carga al carrito y se quita del historial hasta que lo vuelvas a generar.`)) return;
    const items = s.cartItems || s.items?.map(i => ({ ...i, id: i.id || ('item-' + Math.random()), _cat: 'libre', _label: 'Item' })) || [];
    setCart(items.map(i => ({ ...i, price: Number(i.price) || 0, quantity: Number(i.quantity) || 1 })));
    setCustomerName(s.customerName || s.clientName || '');
    setCustomerPhone(s.customerPhone || s.clientPhone || '');
    setNotes(s.notes || '');
    if (isRemito) { setSigFirma(s.sigFirma || ''); setSigAclaracion(s.sigAclaracion || ''); setSigDni(s.sigDni || ''); }
    updateData(cur => ({ ...cur, [collectionKey]: (cur[collectionKey] || []).filter(x => x.id !== s.id) }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {categories.map(c => (
            <button key={c.value} className={`filter-btn ${category === c.value ? 'active' : ''}`} onClick={() => setCategory(c.value)}>{c.label}</button>
          ))}
        </div>
        <input type="text" className="form-input" placeholder="Buscar producto..." value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 12 }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, maxHeight: 300, overflowY: 'auto' }}>
          {filtered.map(p => (
            <div key={p.id + p._cat} style={{ border: '1px solid #E3F2FD', borderRadius: 8, padding: 10, background: '#FAFDFF' }}>
              {p.imageUrl && <img src={p.imageUrl} alt={p.name} style={{ width: '100%', height: 80, objectFit: 'cover', borderRadius: 6, marginBottom: 6 }} />}
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
              {serieDe(p) && <div style={{ fontSize: 11, color: '#1E5AA8', fontWeight: 600 }}>{etiquetaSerie(p)}</div>}
              <div style={{ fontSize: 11, color: '#5A6978' }}>{p._label}</div>
              {stockDe(p) !== null && <div style={{ fontSize: 11, fontWeight: 700, color: stockDe(p) > 0 ? '#2E7D32' : '#E53935' }}>{etiquetaStock(p)}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <span style={{ color: '#1E5AA8', fontWeight: 700 }}>{formatCurrency(p.price)}</span>
                <button className="btn btn-primary btn-sm" onClick={() => addToCart(p)} style={{ padding: '2px 8px', fontSize: 12 }}>+</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 15 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 className="card-title" style={{ margin: 0 }}>Carrito ({cart.length})</h3>
          <button className="btn btn-sm" onClick={() => setShowLibre(!showLibre)}>+ Item libre</button>
        </div>

        {showLibre && (
          <div style={{ background: '#FFF8E1', border: '1px solid #FFC107', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <input type="text" className="form-input" placeholder="Nombre" value={libreItem.name} onChange={e => setLibreItem({...libreItem, name: e.target.value})} style={{ marginBottom: 6 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
              <input type="number" className="form-input" placeholder="Precio $" value={libreItem.price || ''} onChange={e => setLibreItem({...libreItem, price: Number(e.target.value)})} />
              <input type="number" className="form-input" placeholder="Cantidad" value={libreItem.quantity} onChange={e => setLibreItem({...libreItem, quantity: Number(e.target.value)})} />
            </div>
            <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={addLibre}>Agregar</button>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Cliente</label>
          <input
            type="text"
            className="form-input"
            placeholder="Nombre del cliente"
            list="pacientes-sugeridos"
            value={customerName}
            onChange={e => {
              const value = e.target.value;
              setCustomerName(value);
              // Si coincide con un paciente cargado, autocompletar el telefono.
              const match = (patients || []).find(p => (p.name || '').trim().toLowerCase() === value.trim().toLowerCase());
              if (match && match.phone) setCustomerPhone(match.phone);
            }}
          />
          <datalist id="pacientes-sugeridos">
            {ordenNuevosPrimero(patients).map(p => <option key={p.id} value={p.name} />)}
          </datalist>
        </div>
        <div className="form-group">
          <label className="form-label">WhatsApp</label>
          <input type="tel" className="form-input" placeholder="Telefono" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
        </div>

        {cart.length === 0 ? (
          <p style={{ textAlign: 'center', color: '#5A6978', padding: 10 }}>Carrito vacio</p>
        ) : cart.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #E3F2FD' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
              {serieDe(c) && <div style={{ fontSize: 11, color: '#1E5AA8', fontWeight: 600 }}>{etiquetaSerie(c)}</div>}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
                <span>$</span>
                <input type="number" style={{ width: 80, border: '2px solid #90CAF9', borderRadius: 6, padding: '3px 6px', fontSize: 13, fontWeight: 700, color: '#1E5AA8', background: '#F0F7FF' }} value={c.price} onChange={e => updateCartItem(c.id, 'price', Number(e.target.value))} />
                <span>x</span>
                <input type="number" style={{ width: 50, border: '2px solid #90CAF9', borderRadius: 6, padding: '3px 6px', fontSize: 13, fontWeight: 700, color: '#1E5AA8', background: '#F0F7FF' }} value={c.quantity} onChange={e => updateCartItem(c.id, 'quantity', Number(e.target.value))} />
                <span style={{ fontWeight: 700, color: '#1E5AA8' }}>= {formatCurrency(c.price * c.quantity)}</span>
              </div>
            </div>
            <button className="btn btn-sm btn-danger" onClick={() => removeFromCart(c.id)}>x</button>
          </div>
        ))}

        <div style={{ borderTop: '2px solid #E3F2FD', paddingTop: 10, marginTop: 10, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 'bold' }}>
            <span>Total:</span>
            <span style={{ color: '#1E5AA8' }}>{formatCurrency(cartTotal)}</span>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Observaciones</label>
          <textarea className="form-input" rows={2} placeholder="Notas..." value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {isRemito && (
          <div style={{ marginTop: 12, padding: 12, background: '#F0F7FF', border: '1px solid #BBD6FF', borderRadius: 8 }}>
            <div style={{ fontWeight: 700, color: '#1E5AA8', marginBottom: 10, textAlign: 'center', fontSize: 14 }}>RECIBI CONFORME</div>
            <div className="form-group">
              <label className="form-label">Firma</label>
              <input type="text" className="form-input" placeholder="..." value={sigFirma} onChange={e => setSigFirma(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Aclaracion</label>
              <input type="text" className="form-input" placeholder="Nombre completo" value={sigAclaracion} onChange={e => setSigAclaracion(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">DNI</label>
              <input type="text" className="form-input" placeholder="DNI" value={sigDni} onChange={e => setSigDni(e.target.value)} />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <button className="btn btn-success" style={{ flex: 1 }} onClick={handlePDF}><Icon name="file" size={16} /> {isRemito ? 'Remito' : (isCotizacion ? 'Cotizacion' : 'Factura')} PDF</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleWhatsApp}><Icon name="whatsapp" size={16} /> WhatsApp</button>
          <button className="btn btn-danger" onClick={clearCart} title="Eliminar" aria-label="Eliminar"><Icon name="trash" size={16} /></button>
        </div>
      </div>

      {savedItems.length > 0 && (
        <div className="card" style={{ marginTop: 15 }}>
          <h3 className="card-title">Historial ({savedItems.length})</h3>
          {[...savedItems].reverse().map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #E3F2FD' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{s.customerName || s.clientName || 'Sin nombre'}</div>
                <div style={{ fontSize: 12, color: '#5A6978' }}>{formatDate(s.createdAt)} - {s.invoiceNumber}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#1E5AA8' }}>{formatCurrency(s.total)}</span>
                <button className="btn btn-sm btn-secondary" onClick={() => handleEditSaved(s)}><Icon name="edit" size={15} /> Editar</button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDeleteSaved(s.id)} title="Eliminar" aria-label="Eliminar"><Icon name="trash" size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuotationsPage({ data, updateData }) {
  const [docType, setDocType] = useState('cotizacion');
  return (
    <div>
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, background: '#E3F2FD', borderRadius: 10, padding: 4, width: 'fit-content' }}>
        <button
          onClick={() => setDocType('cotizacion')}
          style={{
            padding: '7px 22px', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: docType === 'cotizacion' ? '#1E5AA8' : 'transparent',
            color: docType === 'cotizacion' ? '#fff' : '#1E5AA8',
            transition: 'all 0.15s'
          }}
        >
          COTIZACION
        </button>
        <button
          onClick={() => setDocType('remito')}
          style={{
            padding: '7px 22px', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: docType === 'remito' ? '#1E5AA8' : 'transparent',
            color: docType === 'remito' ? '#fff' : '#1E5AA8',
            transition: 'all 0.15s'
          }}
        >
          REMITO
        </button>
      </div>
      <SalesCartPage key={docType} data={data} updateData={updateData} pageType={docType} />
    </div>
  );
}

// ============ CONTABILIDAD ============
// Agrupa en una sola pantalla la plata que entra (ventas + alquileres),
// la ganancia estimada, el estado del parque y la evolucion mes a mes.
//
// Fuentes: ventas = invoices (por fecha del documento). Alquileres = seccion
// Alquileres (precio mensual + paymentStatusByMonth), NO las facturas.
//
// Categorias del parque: se derivan del NOMBRE del equipo, no del campo type,
// porque type esta sin cargar en 47 de 73 equipos (dice "otro" hasta en CPAP).
const CATEGORIAS_EQUIPO = [
  { key: 'Oxigeno portatil', test: /portatil|portátil|simplygo|longfian|activox|inogen|zen-?o|kingon|freestyle|eclipse/i },
  { key: 'Concentradores', test: /concentrador/i },
  { key: 'BiPAP', test: /bipap|bpap/i },
  { key: 'AutoCPAP', test: /auto\s*(cpap|cpp|cap)/i },
  { key: 'CPAP', test: /cpap|yamind/i },
  { key: 'Ventiladores', test: /ventilador|stellar|respirador|legendair/i },
  { key: 'Mochilas de oxigeno', test: /mochila/i },
  { key: 'Cilindros y tubos', test: /cilindro|tubo/i },
  { key: 'Aspiradores', test: /aspirador/i },
  { key: 'Tos asistida', test: /cough|tos\b/i },
];
const categoriaDeEquipo = (nombre) => {
  const n = String(nombre || '');
  const hit = CATEGORIAS_EQUIPO.find(c => c.test.test(n));
  return hit ? hit.key : 'Otros';
};

// Lo facturado suma mascaras, que no estan en el parque de alquiler.
// Buconasal va ANTES que nasal: la palabra buconasal contiene nasal.
const CATEGORIAS_VENTA = [
  { key: 'Mascara buconasal', test: /buconasal|full ?face|\bf6\b|\bf20\b|\bf2\b/i },
  { key: 'Mascara nasal', test: /nasal|dreamwear|rescom|wisp|airfit|almohadilla|mascara/i },
  { key: 'Oxigeno portatil', test: /portatil|portátil|simplygo|longfian|activox|inogen|zen-?o|kingon|freestyle|eclipse/i },
  { key: 'Concentradores', test: /concentrador/i },
  { key: 'AutoCPAP', test: /auto\s*(cpap|cpp|cap)/i },
  { key: 'BiPAP', test: /bipap|bpap/i },
  { key: 'CPAP', test: /cpap|yamind/i },
  { key: 'Ventiladores', test: /ventilador|stellar|respirador|legendair/i },
  { key: 'Mochilas de oxigeno', test: /mochila/i },
  { key: 'Cilindros y tubos', test: /cilindro|tubo/i },
  { key: 'Aspiradores', test: /aspirador/i },
  { key: 'Tos asistida', test: /cough|tos\b/i },
];
const categoriaDeVenta = (nombre) => {
  const n = String(nombre || '');
  const hit = CATEGORIAS_VENTA.find(c => c.test.test(n));
  return hit ? hit.key : 'Otros';
};

const mesSiguiente = (mk) => {
  let [y, m] = mk.split('-').map(Number);
  m++; if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const mesAnterior = (mk) => {
  let [y, m] = mk.split('-').map(Number);
  m--; if (m < 1) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};

function ContabilidadPage({ data, updateData }) {
  const { invoices = [], rentals = [], equipment = [], settings = {}, patients = [] } = data;
  const mesActual = getToday().slice(0, 7);
  const [mes, setMes] = useState(mesActual);
  const [alcanceVentas, setAlcanceVentas] = useState('mes');

  // ---- Parametros editables (se guardan en settings) ----
  const guardada = settings.contabilidad || {};
  const [cfg, setCfg] = useState({
    margenBruto: guardada.margenBruto ?? 30,
    margenNeto: guardada.margenNeto ?? 20,
    gastoEntrega: guardada.gastoEntrega ?? 0,
  });
  const sinGuardar = Number(cfg.margenBruto) !== Number(guardada.margenBruto ?? 30)
    || Number(cfg.margenNeto) !== Number(guardada.margenNeto ?? 20)
    || Number(cfg.gastoEntrega) !== Number(guardada.gastoEntrega ?? 0);
  const guardarCfg = () => {
    if (!confirm(`¿Guardar los parametros? Margen bruto ${cfg.margenBruto}%, neto ${cfg.margenNeto}%, entrega ${formatCurrency(Number(cfg.gastoEntrega) || 0)}.`)) return;
    updateData(cur => ({
      ...cur,
      settings: {
        ...(cur.settings || {}),
        contabilidad: {
          margenBruto: Number(cfg.margenBruto) || 0,
          margenNeto: Number(cfg.margenNeto) || 0,
          gastoEntrega: Number(cfg.gastoEntrega) || 0,
        }
      }
    }));
  };
  const pBruto = (Number(cfg.margenBruto) || 0) / 100;
  const pNeto = (Number(cfg.margenNeto) || 0) / 100;
  const costoEntrega = Number(cfg.gastoEntrega) || 0;

  // ---- Ingresos por mes ----
  const fechaFactura = (i) => (i.date || i.createdAt || '').slice(0, 10);
  const ventasDeMes = (mk) => invoices
    .filter(i => fechaFactura(i).slice(0, 7) === mk)
    .reduce((s, i) => s + (Number(i.total) || 0), 0);
  const cantVentasDeMes = (mk) => invoices.filter(i => fechaFactura(i).slice(0, 7) === mk).length;

  // Un alquiler cuenta como cobrado del mes si se tildo pagado, o si arranco ese mes
  // (el primer mes se cobra al iniciar). Para el MES EN CURSO se excluyen los
  // finalizados, igual que en Inicio, para que los dos numeros coincidan; en los
  // meses ya cerrados se cuentan, porque esa plata entro igual.
  const arrancaEnMes = (r, mk) => (r.startDate || '').slice(0, 7) === mk;
  // Baja: finalizedAt es lo correcto, pero el campo se agrego despues y falta en
  // varios; se cae a endDate. Los que no tienen ninguna fecha quedan sin mes.
  const mesDeBaja = (r) => String(r.finalizedAt || r.endDate || '').slice(0, 7);
  // Un quincenal puede cobrar dos periodos en el mismo mes: se cuenta por periodos.
  const cobradoEnMes = (r, mk) => periodosCobradosEnMes(r, mk) > 0;

  const alquilerCobradoDeMes = (mk) => rentals
    .reduce((s, r) => s + montoCobradoEnMes(r, mk), 0);
  // Vigente en el mes: arranco antes o durante y todavia no habia terminado. Si se
  // cobro ese mes, estaba vigente por definicion. El mes de la baja solo cuenta si
  // efectivamente se cobro, para no inventar deuda de un alquiler que ya termino.
  const vigenteEnMes = (r, mk) => {
    if (cobradoEnMes(r, mk)) return true;
    const inicio = (r.startDate || '').slice(0, 7);
    if (!inicio || inicio > mk) return false;
    if (r.status === 'finalizado') {
      const baja = mesDeBaja(r);
      return !baja || baja > mk;
    }
    return true;
  };
  const alquilerContratadoDeMes = (mk) => rentals
    .filter(r => vigenteEnMes(r, mk))
    .reduce((s, r) => s + (Number(r.price) || 0) * periodosContratadosEnMes(r, mk), 0);
  const entregasDeMes = (mk) => rentals.filter(r => arrancaEnMes(r, mk)).length;
  const bajasDeMes = (mk) => rentals.filter(r => r.status === 'finalizado' && mesDeBaja(r) === mk).length;
  const activosDeMes = (mk) => rentals.filter(r => vigenteEnMes(r, mk)).length;
  const bajasSinFecha = rentals.filter(r => r.status === 'finalizado' && !mesDeBaja(r)).length;

  // ---- Ganancia de un mes ----
  const resumenDeMes = (mk) => {
    const ventas = ventasDeMes(mk);
    const alquiler = alquilerCobradoDeMes(mk);
    const entregas = entregasDeMes(mk);
    const gastoEnt = entregas * costoEntrega;
    const gananciaVentas = ventas * pNeto;
    const gananciaAlquiler = Math.max(0, alquiler - gastoEnt);
    return {
      mk, ventas, alquiler, entregas, gastoEnt,
      ingreso: ventas + alquiler,
      brutoVentas: ventas * pBruto,
      gananciaVentas,
      gananciaAlquiler,
      ganancia: gananciaVentas + gananciaAlquiler,
    };
  };

  // ---- Serie historica ----
  const meses = (() => {
    const claves = [];
    invoices.forEach(i => { const k = fechaFactura(i).slice(0, 7); if (k) claves.push(k); });
    rentals.forEach(r => {
      const k = (r.startDate || '').slice(0, 7); if (k) claves.push(k);
      Object.keys(r.paymentStatusByMonth || {}).forEach(k2 => claves.push(k2));
    });
    if (!claves.length) return [mesActual];
    let cursor = claves.sort()[0];
    const out = [];
    let guard = 0;
    while (cursor <= mesActual && guard < 60) { out.push(cursor); cursor = mesSiguiente(cursor); guard++; }
    return out;
  })();
  const serie = meses.map(resumenDeMes);
  const serieGrafico = serie.slice(-12);

  const act = resumenDeMes(mes);
  const ant = resumenDeMes(mesAnterior(mes));
  const variacion = (a, b) => {
    if (!b) return { txt: a > 0 ? 'nuevo' : '—', color: a > 0 ? '#2E7D32' : '#5A6978' };
    const pct = Math.round(((a - b) / b) * 100);
    return { txt: `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`, color: pct >= 0 ? '#2E7D32' : '#E53935' };
  };

  // ---- Parque de equipos ----
  const enMantenimiento = equipment.filter(e => e.status === 'mantenimiento');
  const operativos = equipment.filter(e => e.status !== 'mantenimiento');
  const alquilados = operativos.filter(e => getOccupyingRental(rentals, e.id));
  const libres = operativos.filter(e => !getOccupyingRental(rentals, e.id));
  const ocupacion = operativos.length ? Math.round((alquilados.length / operativos.length) * 100) : 0;

  // ---- Ventas por item: cada renglon de las facturas, agrupado por categoria ----
  const ventasPorItem = (() => {
    const facturas = invoices.filter(i => alcanceVentas === 'todo' || fechaFactura(i).slice(0, 7) === mes);
    const porNombre = {};
    facturas.forEach(inv => (inv.items || []).forEach(it => {
      const nombre = String(it.name || '').trim() || 'Sin nombre';
      const cat = categoriaDeVenta(nombre);
      const clave = cat + '|' + nombre.toLowerCase();
      if (!porNombre[clave]) porNombre[clave] = { cat, nombre, unidades: 0, bruto: 0 };
      const q = Number(it.quantity) || 1;
      porNombre[clave].unidades += q;
      porNombre[clave].bruto += (Number(it.price) || 0) * q;
    }));
    const porCat = {};
    Object.values(porNombre).forEach(x => {
      if (!porCat[x.cat]) porCat[x.cat] = { cat: x.cat, unidades: 0, bruto: 0, items: [] };
      porCat[x.cat].unidades += x.unidades;
      porCat[x.cat].bruto += x.bruto;
      porCat[x.cat].items.push(x);
    });
    return Object.values(porCat)
      .map(c => ({ ...c, items: c.items.sort((a, b) => b.bruto - a.bruto) }))
      .sort((a, b) => b.bruto - a.bruto);
  })();
  const totalItems = ventasPorItem.reduce((s, c) => s + c.bruto, 0);
  const unidadesItems = ventasPorItem.reduce((s, c) => s + c.unidades, 0);

  const porCategoria = (() => {
    const mapa = {};
    operativos.forEach(e => {
      const k = categoriaDeEquipo(e.name);
      if (!mapa[k]) mapa[k] = { key: k, total: 0, alquilados: 0, libres: 0 };
      mapa[k].total++;
      if (getOccupyingRental(rentals, e.id)) mapa[k].alquilados++; else mapa[k].libres++;
    });
    return Object.values(mapa).sort((a, b) => b.total - a.total);
  })();

  // Equipos con mas de un alquiler sin finalizar: el parque los cuenta UNA vez pero Alquileres muestra dos.
  // Es un error de carga (dos pacientes no pueden tener la misma unidad); se avisa para que se corrija.
  const equiposDuplicados = (() => {
    const porEquipo = {};
    rentals.filter(r => r.status !== 'finalizado').forEach(r => { (porEquipo[r.equipmentId] = porEquipo[r.equipmentId] || []).push(r); });
    return Object.entries(porEquipo)
      .filter(([, rs]) => rs.length > 1)
      .map(([eid, rs]) => {
        const e = equipment.find(x => x.id === eid);
        return {
          id: eid,
          nombre: e ? `${e.name}${serieDe(e) ? ` (serie ${serieDe(e)})` : ''}` : 'Equipo eliminado',
          pacientes: rs.map(r => (patients.find(p => p.id === r.patientId)?.name || 'sin paciente').trim()),
        };
      });
  })();

  // ---- Indicadores ----
  const activos = rentals.filter(r => r.status !== 'finalizado');
  const mrr = activos.reduce((s, r) => s + (Number(r.price) || 0), 0);
  const ticketVenta = cantVentasDeMes(mes) ? act.ventas / cantVentasDeMes(mes) : 0;
  const mixAlquiler = act.ingreso ? Math.round((act.alquiler / act.ingreso) * 100) : 0;
  const contratado = alquilerContratadoDeMes(mes);
  const pendiente = Math.max(0, contratado - act.alquiler);
  const cobranza = contratado ? Math.round((act.alquiler / contratado) * 100) : 0;
  const margenSobreIngreso = act.ingreso ? Math.round((act.ganancia / act.ingreso) * 100) : 0;

  // ---- Grafico de barras (SVG) ----
  const W = 720, H = 240, padX = 34, padY = 18, gap = 10;
  const maxVal = Math.max(1, ...serieGrafico.map(s => Math.max(s.ventas, s.alquiler)));
  const grupoW = (W - padX * 2) / Math.max(1, serieGrafico.length);
  const barW = Math.max(4, (grupoW - gap) / 2);
  const altura = (v) => Math.max(0, ((H - padY * 2) * v) / maxVal);
  const mesCorto = (mk) => formatMonthLabel(mk).slice(0, 3);

  const Tarjeta = ({ icono, etiqueta, valor, detalle, color }) => (
    <div className="card" style={{ padding: 16, borderTop: `4px solid ${color}` }}>
      <div style={{ color, display: 'flex' }}>{icono}</div>
      <div style={{ fontSize: 12, color: '#5A6978', fontWeight: 600, marginTop: 2 }}>{etiqueta}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.2, marginTop: 2, wordBreak: 'break-word' }}>{valor}</div>
      {detalle && <div style={{ fontSize: 11, color: '#5A6978', marginTop: 4 }}>{detalle}</div>}
    </div>
  );

  const Fila = ({ label, valor, negativo, fuerte, nota }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid #EEF3F8', gap: 10 }}>
      <span style={{ fontSize: 13, color: fuerte ? '#0D47A1' : '#5A6978', fontWeight: fuerte ? 700 : 500 }}>
        {label}{nota && <span style={{ fontSize: 11, color: '#90A4AE' }}> {nota}</span>}
      </span>
      <span style={{ fontSize: fuerte ? 16 : 14, fontWeight: fuerte ? 800 : 600, color: negativo ? '#E53935' : (fuerte ? '#2E7D32' : '#0D47A1'), whiteSpace: 'nowrap' }}>
        {negativo ? '− ' : ''}{formatCurrency(Math.abs(valor))}
      </span>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Contabilidad</h1>
        <p className="page-subtitle">Ventas, alquileres, ganancia y parque de equipos en un solo lugar</p>
      </div>

      {/* Selector de mes */}
      <div className="card" style={{ padding: 12, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="form-label" style={{ margin: 0 }}>Mes</label>
        <select className="form-select" style={{ maxWidth: 220 }} value={mes} onChange={e => setMes(e.target.value)}>
          {[...meses].reverse().map(mk => <option key={mk} value={mk}>{formatMonthLabel(mk)}</option>)}
        </select>
        {mes !== mesActual && <button className="btn btn-sm btn-secondary" onClick={() => setMes(mesActual)}>Ir al mes actual</button>}
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Tarjeta icono={<Icon name="cart" size={22} />} etiqueta="Ventas facturadas" color="#1E5AA8"
          valor={formatCurrency(act.ventas)}
          detalle={`${cantVentasDeMes(mes)} factura(s) · ${variacion(act.ventas, ant.ventas).txt} vs mes anterior`} />
        <Tarjeta icono={<Icon name="clipboard" size={22} />} etiqueta="Alquileres cobrados" color="#00897B"
          valor={formatCurrency(act.alquiler)}
          detalle={`${cobranza}% de lo contratado · ${variacion(act.alquiler, ant.alquiler).txt} vs mes anterior`} />
        <Tarjeta icono={<Icon name="cash" size={22} />} etiqueta="Ingreso total" color="#5E35B1"
          valor={formatCurrency(act.ingreso)}
          detalle={`${100 - mixAlquiler}% venta · ${mixAlquiler}% alquiler`} />
        <Tarjeta icono={<Icon name="trend" size={22} />} etiqueta="Ganancia estimada" color="#2E7D32"
          valor={formatCurrency(act.ganancia)}
          detalle={`${margenSobreIngreso}% del ingreso · ${variacion(act.ganancia, ant.ganancia).txt} vs mes anterior`} />
      </div>

      {/* Como se calcula */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginBottom: 16 }}>
        <div className="card">
          <h3 className="card-title">Ganancia de {formatMonthLabel(mes)}</h3>
          <div style={{ fontSize: 12, color: '#5A6978', fontWeight: 700, margin: '6px 0 2px' }}>VENTAS</div>
          <Fila label="Facturado" valor={act.ventas} />
          <Fila label="Margen bruto" nota={`(${cfg.margenBruto}%)`} valor={act.brutoVentas} />
          <Fila label="Queda neto" nota={`(${cfg.margenNeto}% tras fletes y demas)`} valor={act.gananciaVentas} fuerte />
          <div style={{ fontSize: 12, color: '#5A6978', fontWeight: 700, margin: '14px 0 2px' }}>ALQUILERES</div>
          <Fila label="Cobrado" valor={act.alquiler} />
          <Fila label="Gasto de entrega" nota={`(${act.entregas} entrega(s) × ${formatCurrency(costoEntrega)})`} valor={act.gastoEnt} negativo />
          <Fila label="Queda neto" valor={act.gananciaAlquiler} fuerte />
          <div style={{ marginTop: 14, padding: 12, background: '#E8F5E9', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, color: '#1B5E20' }}>GANANCIA NETA</span>
            <span style={{ fontWeight: 800, fontSize: 20, color: '#1B5E20' }}>{formatCurrency(act.ganancia)}</span>
          </div>
          {costoEntrega === 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#F57C00', background: '#FFF8E1', padding: 8, borderRadius: 8 }}>
              El gasto de entrega esta en $0. Cargalo abajo para que la ganancia del alquiler sea real.
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Parametros de calculo</h3>
          <p style={{ fontSize: 12, color: '#5A6978', marginTop: 0 }}>Se aplican a todos los meses de esta pantalla.</p>
          <div className="form-group">
            <label className="form-label">Margen bruto sobre ventas (%)</label>
            <input type="number" min="0" max="100" className="form-input" value={cfg.margenBruto} onChange={e => setCfg({ ...cfg, margenBruto: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Margen neto sobre ventas (%), ya sacando fletes</label>
            <input type="number" min="0" max="100" className="form-input" value={cfg.margenNeto} onChange={e => setCfg({ ...cfg, margenNeto: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Gasto de entrega por equipo entregado ($)</label>
            <input type="number" min="0" className="form-input" value={cfg.gastoEntrega} onChange={e => setCfg({ ...cfg, gastoEntrega: e.target.value })} />
          </div>
          <button className="btn btn-primary btn-block" disabled={!sinGuardar} onClick={guardarCfg}>
            {sinGuardar ? 'Guardar parametros' : 'Parametros guardados'}
          </button>

          <div style={{ marginTop: 16, borderTop: '1px solid #E3F2FD', paddingTop: 12 }}>
            <h3 className="card-title" style={{ fontSize: 14 }}>Cobranza del mes</h3>
            <Fila label="Alquiler contratado" valor={contratado} />
            <Fila label="Cobrado" valor={act.alquiler} fuerte />
            <Fila label="Pendiente de cobro" valor={pendiente} negativo={pendiente > 0} />
            <div style={{ height: 10, background: '#E8ECF0', borderRadius: 6, overflow: 'hidden', marginTop: 8 }}>
              <div style={{ width: `${cobranza}%`, height: '100%', background: cobranza >= 80 ? '#2E7D32' : cobranza >= 50 ? '#F9A825' : '#E53935' }} />
            </div>
            <div style={{ fontSize: 12, color: '#5A6978', marginTop: 4 }}>{cobranza}% cobrado</div>
          </div>
        </div>
      </div>

      {/* Indicadores */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Tarjeta icono={<Icon name="refresh" size={22} />} etiqueta="Ingreso recurrente mensual" color="#00897B"
          valor={formatCurrency(mrr)} detalle={`${activos.length} alquiler(es) vigentes`} />
        <Tarjeta icono={<Icon name="tag" size={22} />} etiqueta="Ticket promedio de venta" color="#1E5AA8"
          valor={formatCurrency(ticketVenta)} detalle={`sobre ${cantVentasDeMes(mes)} factura(s) del mes`} />
        <Tarjeta icono={<Icon name="device" size={22} />} etiqueta="Ocupacion del parque" color="#5E35B1"
          valor={`${ocupacion}%`} detalle={`${alquilados.length} alquilados · ${libres.length} libres`} />
        <Tarjeta icono={<Icon name="box" size={22} />} etiqueta="Equipos libres" color="#F57C00"
          valor={String(libres.length)} detalle={enMantenimiento.length ? `${enMantenimiento.length} en mantenimiento aparte` : 'listos para colocar'} />
      </div>

      {/* Parque por categoria */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Parque de equipos por categoria</h3>
        <p style={{ fontSize: 12, color: '#5A6978', marginTop: 0 }}>Cada equipo cuenta como alquilado mientras tenga un alquiler sin finalizar.</p>
        {equiposDuplicados.length > 0 && (
          <div style={{ background: '#FFF3E0', border: '1px solid #FFB74D', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: '#E65100', marginBottom: 4 }}><Icon name="alert" size={16} /> {equiposDuplicados.length === 1 ? 'Hay 1 equipo' : `Hay ${equiposDuplicados.length} equipos`} con mas de un alquiler vigente</div>
            <div style={{ color: '#5A6978', marginBottom: 6 }}>Aca se cuentan una sola vez, pero en Alquileres figuran dos veces. Corregilo en Alquileres: cambiale el equipo a uno de los dos pacientes (o finaliza el que ya no esta).</div>
            {equiposDuplicados.map(d => (
              <div key={d.id} style={{ marginTop: 2 }}><b>{d.nombre}</b>: {d.pacientes.join(' y ')}</div>
            ))}
          </div>
        )}
        {porCategoria.map(c => {
          const pct = c.total ? Math.round((c.alquilados / c.total) * 100) : 0;
          return (
            <div key={c.key} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4, flexWrap: 'wrap', gap: 6 }}>
                <span style={{ fontWeight: 700, color: '#0D47A1' }}>{c.key}</span>
                <span style={{ color: '#5A6978' }}>
                  <b style={{ color: '#00897B' }}>{c.alquilados} alquilados</b> · <b style={{ color: '#F57C00' }}>{c.libres} libres</b> · {c.total} total
                </span>
              </div>
              <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: '#E8ECF0' }}>
                <div style={{ width: `${pct}%`, background: '#00897B' }} title={`${c.alquilados} alquilados`} />
                <div style={{ width: `${100 - pct}%`, background: '#FFB74D' }} title={`${c.libres} libres`} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Ventas por item */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 className="card-title" style={{ margin: 0 }}>Ventas por item</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={`filter-btn ${alcanceVentas === 'mes' ? 'active' : ''}`} onClick={() => setAlcanceVentas('mes')}>{formatMonthLabel(mes)}</button>
            <button className={`filter-btn ${alcanceVentas === 'todo' ? 'active' : ''}`} onClick={() => setAlcanceVentas('todo')}>Todo el historico</button>
          </div>
        </div>
        <p style={{ fontSize: 12, color: '#5A6978', marginTop: 6 }}>Cada renglon facturado, agrupado por tipo. Aparatos y mascaras con el mismo criterio.</p>
        {ventasPorItem.length === 0 ? (
          <p style={{ color: '#5A6978', padding: '10px 0' }}>No hay ventas facturadas en {formatMonthLabel(mes)}.</p>
        ) : (
          <div className="table-container" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ textAlign: 'center' }}>Unidades</th>
                  <th style={{ textAlign: 'right' }}>Facturado</th>
                  <th style={{ textAlign: 'right' }}>Ganancia bruta</th>
                  <th style={{ textAlign: 'right' }}>Ganancia neta</th>
                </tr>
              </thead>
              <tbody>
                {ventasPorItem.map(c => [
                  <tr key={c.cat} style={{ background: '#E3F2FD' }}>
                    <td style={{ fontWeight: 700, color: '#0D47A1' }}>{c.cat}</td>
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>{c.unidades}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatCurrency(c.bruto)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#1565C0' }}>{formatCurrency(c.bruto * pBruto)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#2E7D32' }}>{formatCurrency(c.bruto * pNeto)}</td>
                  </tr>,
                  ...c.items.map(x => (
                    <tr key={c.cat + x.nombre}>
                      <td style={{ paddingLeft: 22, fontSize: 13, color: '#5A6978' }}>{x.nombre}</td>
                      <td style={{ textAlign: 'center', fontSize: 13 }}>{x.unidades}</td>
                      <td style={{ textAlign: 'right', fontSize: 13 }}>{formatCurrency(x.bruto)}</td>
                      <td style={{ textAlign: 'right', fontSize: 13, color: '#1565C0' }}>{formatCurrency(x.bruto * pBruto)}</td>
                      <td style={{ textAlign: 'right', fontSize: 13, color: '#2E7D32' }}>{formatCurrency(x.bruto * pNeto)}</td>
                    </tr>
                  ))
                ])}
                <tr style={{ borderTop: '2px solid #90CAF9' }}>
                  <td style={{ fontWeight: 800 }}>TOTAL</td>
                  <td style={{ textAlign: 'center', fontWeight: 800 }}>{unidadesItems}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800 }}>{formatCurrency(totalItems)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: '#1565C0' }}>{formatCurrency(totalItems * pBruto)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: '#2E7D32' }}>{formatCurrency(totalItems * pNeto)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 11, color: '#90A4AE', marginTop: 10 }}>
          Ganancia bruta = {cfg.margenBruto}% de lo facturado. Ganancia neta = {cfg.margenNeto}%, ya descontados fletes y demas. Los dos porcentajes se cambian en Parametros de calculo.
        </p>
      </div>

      {/* Evolucion mes a mes */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Evolucion mes a mes</h3>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#5A6978', marginBottom: 6, flexWrap: 'wrap' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#1E5AA8', borderRadius: 2, marginRight: 4 }} />Ventas</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#00897B', borderRadius: 2, marginRight: 4 }} />Alquileres cobrados</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 460, height: 'auto' }} role="img">
            <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="#CFD8DC" strokeWidth="1" />
            {serieGrafico.map((s, i) => {
              const x0 = padX + i * grupoW + gap / 2;
              const hv = altura(s.ventas), ha = altura(s.alquiler);
              return (
                <g key={s.mk}>
                  <rect x={x0} y={H - padY - hv} width={barW} height={hv} fill="#1E5AA8" rx="3">
                    <title>{`${formatMonthLabel(s.mk)} — ventas ${formatCurrency(s.ventas)}`}</title>
                  </rect>
                  <rect x={x0 + barW + 2} y={H - padY - ha} width={barW} height={ha} fill="#00897B" rx="3">
                    <title>{`${formatMonthLabel(s.mk)} — alquileres ${formatCurrency(s.alquiler)}`}</title>
                  </rect>
                  <text x={x0 + barW} y={H - padY + 12} textAnchor="middle" fontSize="10" fill="#5A6978">{mesCorto(s.mk)}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Tabla historica */}
      <div className="card">
        <h3 className="card-title">Detalle mes a mes</h3>
        <div className="table-container" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th>Mes</th>
                <th style={{ textAlign: 'right' }}>Ventas</th>
                <th style={{ textAlign: 'right' }}>Alquileres</th>
                <th style={{ textAlign: 'right' }}>Ingreso</th>
                <th style={{ textAlign: 'right' }}>Ganancia</th>
                <th style={{ textAlign: 'right' }}>vs mes anterior</th>
              </tr>
            </thead>
            <tbody>
              {[...serie].reverse().map((s, idx, arr) => {
                const prev = arr[idx + 1];
                const v = variacion(s.ganancia, prev ? prev.ganancia : 0);
                return (
                  <tr key={s.mk} style={{ background: s.mk === mes ? '#E8F5E9' : undefined, cursor: 'pointer' }} onClick={() => setMes(s.mk)}>
                    <td style={{ fontWeight: s.mk === mes ? 700 : 500 }}>{formatMonthLabel(s.mk)}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(s.ventas)}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(s.alquiler)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatCurrency(s.ingreso)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#2E7D32' }}>{formatCurrency(s.ganancia)}</td>
                    <td style={{ textAlign: 'right', color: v.color, fontWeight: 600 }}>{v.txt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: '#90A4AE', marginTop: 10 }}>
          Ventas = facturas por su fecha. Alquileres = lo cobrado segun la seccion Alquileres (mes tildado como pagado, o mes de alta, que se cobra al iniciar).
        </p>
      </div>

      {/* Alquileres mes a mes */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="card-title">Alquileres mes a mes</h3>
        <p style={{ fontSize: 12, color: '#5A6978', marginTop: 0 }}>Como se movio el parque en alquiler: cuantos hubo, cuantos entraron y salieron, y cuanto se cobro de lo contratado.</p>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#5A6978', marginBottom: 6, flexWrap: 'wrap' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#90CAF9', borderRadius: 2, marginRight: 4 }} />Contratado</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#00897B', borderRadius: 2, marginRight: 4 }} />Cobrado</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 460, height: 'auto' }} role="img">
            <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="#CFD8DC" strokeWidth="1" />
            {(() => {
              const filas = serieGrafico.map(s => ({ mk: s.mk, contratado: alquilerContratadoDeMes(s.mk), cobrado: s.alquiler }));
              const tope = Math.max(1, ...filas.map(r => r.contratado));
              const alt = (v) => Math.max(0, ((H - padY * 2) * v) / tope);
              return filas.map((r, i) => {
                const x0 = padX + i * grupoW + gap / 2;
                const hc = alt(r.contratado), hk = alt(r.cobrado);
                return (
                  <g key={r.mk}>
                    <rect x={x0} y={H - padY - hc} width={barW} height={hc} fill="#90CAF9" rx="3">
                      <title>{`${formatMonthLabel(r.mk)} — contratado ${formatCurrency(r.contratado)}`}</title>
                    </rect>
                    <rect x={x0 + barW + 2} y={H - padY - hk} width={barW} height={hk} fill="#00897B" rx="3">
                      <title>{`${formatMonthLabel(r.mk)} — cobrado ${formatCurrency(r.cobrado)}`}</title>
                    </rect>
                    <text x={x0 + barW} y={H - padY + 12} textAnchor="middle" fontSize="10" fill="#5A6978">{mesCorto(r.mk)}</text>
                  </g>
                );
              });
            })()}
          </svg>
        </div>

        <div className="table-container" style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="table" style={{ minWidth: 700 }}>
            <thead>
              <tr>
                <th>Mes</th>
                <th style={{ textAlign: 'center' }}>Activos</th>
                <th style={{ textAlign: 'center' }}>Altas</th>
                <th style={{ textAlign: 'center' }}>Bajas</th>
                <th style={{ textAlign: 'right' }}>Contratado</th>
                <th style={{ textAlign: 'right' }}>Cobrado</th>
                <th style={{ textAlign: 'right' }}>Pendiente</th>
                <th style={{ textAlign: 'center' }}>Cobranza</th>
              </tr>
            </thead>
            <tbody>
              {[...meses].reverse().map(mk => {
                const contr = alquilerContratadoDeMes(mk);
                const cobr = alquilerCobradoDeMes(mk);
                const pend = Math.max(0, contr - cobr);
                const pct = contr ? Math.round((cobr / contr) * 100) : 0;
                const altas = entregasDeMes(mk);
                const bajas = bajasDeMes(mk);
                const neto = altas - bajas;
                return (
                  <tr key={mk} style={{ background: mk === mes ? '#E8F5E9' : undefined, cursor: 'pointer' }} onClick={() => setMes(mk)}>
                    <td style={{ fontWeight: mk === mes ? 700 : 500 }}>{formatMonthLabel(mk)}</td>
                    <td style={{ textAlign: 'center', fontWeight: 600 }}>{activosDeMes(mk)}</td>
                    <td style={{ textAlign: 'center', color: altas ? '#2E7D32' : '#B0BEC5', fontWeight: 600 }}>{altas ? `+${altas}` : '—'}</td>
                    <td style={{ textAlign: 'center', color: bajas ? '#E53935' : '#B0BEC5', fontWeight: 600 }}>{bajas ? `−${bajas}` : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(contr)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: '#00695C' }}>{formatCurrency(cobr)}</td>
                    <td style={{ textAlign: 'right', color: pend ? '#E53935' : '#B0BEC5' }}>{pend ? formatCurrency(pend) : '—'}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 10, color: '#fff', background: pct >= 80 ? '#2E7D32' : pct >= 50 ? '#F9A825' : '#E53935' }}>{pct}%</span>
                      {neto !== 0 && <div style={{ fontSize: 10, color: neto > 0 ? '#2E7D32' : '#E53935', marginTop: 2 }}>{neto > 0 ? `+${neto}` : neto} neto</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: '#90A4AE', marginTop: 10 }}>
          Activos = alquileres vigentes ese mes. Altas = los que arrancaron. Bajas = los finalizados, por su fecha de baja (o la de vencimiento si no quedo registrada).
          {bajasSinFecha > 0 && ` Hay ${bajasSinFecha} alquiler(es) finalizado(s) sin ninguna fecha, que no entran en la columna Bajas.`}
        </p>
      </div>
    </div>
  );
}

function CalendarPage({ data }) {
  const { rentals, patients, equipment } = data;
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);

  const getDaysInMonth = (date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days = [];
    
    for (let i = 0; i < firstDay.getDay(); i++) {
      days.push(null);
    }
    
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }
    
    return days;
  };

  const getRentalsForDay = (date) => {
    if (!date) return [];
    const dateStr = toLocalDateStr(date);
    return rentals.filter(r => {
      const start = r.startDate?.split('T')[0];
      const end = r.endDate?.split('T')[0];
      return dateStr >= start && dateStr <= end;
    });
  };

  // Alquileres que VENCEN exactamente ese dia (lo que importa en el calendario).
  const getExpiringForDay = (date) => {
    if (!date) return [];
    const dateStr = toLocalDateStr(date);
    return rentals.filter(r => r.status !== 'finalizado' && r.endDate?.split('T')[0] === dateStr);
  };

  const days = getDaysInMonth(currentDate);
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));

  const selectedDayExpiring = selectedDate ? getExpiringForDay(selectedDate) : [];
  const expiringIds = new Set(selectedDayExpiring.map(r => r.id));
  const selectedDayRentals = selectedDate ? getRentalsForDay(selectedDate).filter(r => !expiringIds.has(r.id)) : [];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Calendario</h1>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <button className="btn btn-secondary btn-sm" onClick={prevMonth}>‹</button>
          <h3>{monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}</h3>
          <button className="btn btn-secondary btn-sm" onClick={nextMonth}>›</button>
        </div>

        <div className="calendar-grid">
          {dayNames.map(d => <div key={d} className="calendar-header">{d}</div>)}
          {days.map((date, i) => {
            const expiringForDay = getExpiringForDay(date);
            const isToday = date && date.toDateString() === new Date().toDateString();
            const isSelected = date && selectedDate && date.toDateString() === selectedDate.toDateString();

            return (
              <div
                key={i}
                className={`calendar-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${expiringForDay.length > 0 ? 'has-event' : ''}`}
                onClick={() => date && setSelectedDate(date)}
                style={{ position: 'relative' }}
              >
                {date?.getDate()}
                {expiringForDay.length > 0 && (
                  <span style={{ position: 'absolute', top: 2, right: 4, fontSize: 10, fontWeight: 700, color: '#fff', background: '#E53935', borderRadius: 8, padding: '0 4px', lineHeight: '14px' }}>
                    {expiringForDay.length}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {selectedDate && (
        <div className="card">
          <h3 className="card-title">{selectedDate.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}</h3>

          <h4 style={{ color: '#E53935', margin: '8px 0 4px' }}><span className="dot dot-rojo" /> Vencen este día ({selectedDayExpiring.length})</h4>
          {selectedDayExpiring.length === 0 ? (
            <p style={{ color: '#5A6978' }}>Sin vencimientos este día</p>
          ) : (
            selectedDayExpiring.map(rental => {
              const patient = patients.find(p => p.id === rental.patientId);
              const equip = equipment.find(e => e.id === rental.equipmentId);
              return (
                <div key={rental.id} className="patient-card" style={{ marginTop: 12, borderLeft: '3px solid #E53935' }}>
                  <div className="patient-info">
                    <div className="patient-name">{patient?.name}</div>
                    <div className="patient-detail">{equip?.name}</div>
                    {Number(rental.price) > 0 && <div className="patient-detail" style={{ fontWeight: 600 }}>{formatCurrency(rental.price)}/mes</div>}
                  </div>
                  <span className={`badge badge-${rental.status}`}>{rental.status}</span>
                </div>
              );
            })
          )}

          {selectedDayRentals.length > 0 && (
            <>
              <h4 style={{ color: '#1E5AA8', margin: '16px 0 4px' }}>En curso ese día ({selectedDayRentals.length})</h4>
              {selectedDayRentals.map(rental => {
                const patient = patients.find(p => p.id === rental.patientId);
                const equip = equipment.find(e => e.id === rental.equipmentId);
                return (
                  <div key={rental.id} className="patient-card" style={{ marginTop: 12 }}>
                    <div className="patient-info">
                      <div className="patient-name">{patient?.name}</div>
                      <div className="patient-detail">{equip?.name}</div>
                      <div className="patient-detail">Vence: {formatDate(rental.endDate)}</div>
                    </div>
                    <span className={`badge badge-${rental.status}`}>{rental.status}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Cambio de la contraseña de ingreso. Al cambiarla se cierran las sesiones de los
// demas dispositivos (tendran que ingresar con la nueva).
function CambiarClaveCard() {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetir, setRepetir] = useState('');
  const [msg, setMsg] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (nueva.length < 6) { setMsg({ error: true, text: 'La nueva contraseña debe tener al menos 6 caracteres.' }); return; }
    if (nueva !== repetir) { setMsg({ error: true, text: 'Las contraseñas nuevas no coinciden.' }); return; }
    if (!confirm('¿Cambiar la contraseña? Los demas dispositivos tendran que ingresar de nuevo.')) return;
    const res = await cambiarClave(actual, nueva);
    if (res?.ok) {
      setActual(''); setNueva(''); setRepetir('');
      setMsg({ error: false, text: 'Contraseña cambiada.' });
    } else {
      setMsg({ error: true, text: res?.error === 'clave_actual_incorrecta' ? 'La contraseña actual no es correcta.' : 'No se pudo cambiar la contraseña. Revisa la conexion.' });
    }
  };

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h3 className="card-title"><Icon name="lock" size={18} /> Contraseña de ingreso</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <div className="form-group">
          <label className="form-label">Contraseña actual</label>
          <input type="password" className="form-input" autoComplete="current-password" value={actual} onChange={e => setActual(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Nueva contraseña</label>
          <input type="password" className="form-input" autoComplete="new-password" value={nueva} onChange={e => setNueva(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Repetir nueva</label>
          <input type="password" className="form-input" autoComplete="new-password" value={repetir} onChange={e => setRepetir(e.target.value)} />
        </div>
      </div>
      {msg && <p style={{ color: msg.error ? '#C62828' : '#2E7D32', fontSize: 13, margin: '0 0 10px' }}>{msg.text}</p>}
      <button type="submit" className="btn btn-primary" disabled={!actual || !nueva || !repetir}>Cambiar contraseña</button>
    </form>
  );
}

function SettingsPage({ data, updateData }) {
  const { settings, patients, equipment, rentals } = data;
  const [form, setForm] = useState(settings);
  const [importing, setImporting] = useState(false);

  const handleSave = () => {
    if (!confirm('¿Guardar los cambios de configuración?')) return;
    // Merge sobre settings actuales para no pisar campos que el form no maneja (ej: apiKey).
    updateData(cur => ({ ...cur, settings: { ...cur.settings, ...form } }));
    alert('Configuración guardada');
  };

  // Dominio PUBLICO fijo: las otras URLs del proyecto en Vercel piden login y
  // Hermes recibiria un 401. Este enlace siempre apunta al dominio que se puede
  // leer desde afuera, sin importar desde donde se abra la app.
  const API_PUBLIC_BASE = 'https://aplicacion-beta.vercel.app';
  const apiUrl = settings.apiKey ? `${API_PUBLIC_BASE}/api/server?vencimientos=1&key=${settings.apiKey}` : '';
  const apiUrlPrecios = settings.apiKey ? `${API_PUBLIC_BASE}/api/server?precios=1&key=${settings.apiKey}` : '';

  const handleGenerateApiKey = () => {
    const msg = settings.apiKey
      ? 'Regenerar la clave deja de funcionar el enlace anterior que tenga Hermes. ¿Continuar?'
      : '¿Generar la clave API para compartir los vencimientos con Hermes?';
    if (!confirm(msg)) return;
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const key = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    updateData(cur => ({ ...cur, settings: { ...cur.settings, apiKey: key } }));
  };

  const handleCopyApiUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      alert('Enlace copiado');
    } catch {
      prompt('Copia el enlace:', url);
    }
  };

  const handleBackup = () => {
    const backup = {
      version: 1,
      date: new Date().toISOString(),
      data
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `insersalud-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRestore = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        const restored = backup.data || backup;
        if (!restored.patients || !restored.equipment) {
          alert('Archivo de backup inválido');
          return;
        }
        if (confirm(`¿Restaurar backup del ${backup.date ? new Date(backup.date).toLocaleString('es-AR') : 'archivo'}? Se reemplazarán todos los datos actuales.`)) {
          updateData(restored);
          alert('Datos restaurados correctamente');
        }
      } catch {
        alert('Error al leer el archivo de backup');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setImporting(true);
    
    try {
      const XLSX = await import('xlsx');
      const reader = new FileReader();
      
      reader.onload = (event) => {
        try {
          const workbook = XLSX.read(event.target.result, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const excelData = XLSX.utils.sheet_to_json(worksheet);
          
          const { patients: newPatients, equipment: newEquipment, rentals: newRentals } = parseExcelData(excelData, patients, equipment);

          if (!confirm(`¿Importar ${newPatients.length} pacientes, ${newEquipment.length} equipos y ${newRentals.length} alquileres del Excel?`)) {
            setImporting(false);
            return;
          }

          const allPatients = [...patients, ...newPatients];
          const allEquipment = [...equipment, ...newEquipment];
          const allRentals = [...rentals, ...newRentals];

          updateData(cur => ({ ...cur, patients: allPatients, equipment: allEquipment, rentals: allRentals }));

          alert(`Importados: ${newPatients.length} pacientes, ${newEquipment.length} equipos, ${newRentals.length} alquileres`);
        } catch (err) {
          console.error(err);
          alert('Error al procesar el archivo');
        } finally {
          setImporting(false);
        }
      };
      
      reader.readAsBinaryString(file);
    } catch (err) {
      console.error(err);
      alert('Error al leer el archivo');
      setImporting(false);
    }
  };

  const handleClear = () => {
    if (confirm('¿Borrar todos los datos? Esta acción no se puede deshacer.')) {
      updateData({
        patients: [],
        equipment: [],
        rentals: [],
        quotations: [],
        settings: data.settings
      });
      alert('Datos borrados');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Configuración</h1>
      </div>

      <CambiarClaveCard />

      <div className="card">
        <h3 className="card-title"><Icon name="download" size={18} /> Copia de seguridad</h3>
        <p style={{ color: '#5A6978', marginBottom: 16 }}>Guardá una copia de todos tus datos o restaurá desde un backup anterior.</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleBackup}>
            <Icon name="download" size={16} /> Descargar copia
          </button>
          <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={16} /> Restaurar copia
            <input type="file" accept=".json" onChange={handleRestore} style={{ display: 'none' }} />
          </label>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="upload" size={18} /> Importar desde Excel</h3>
        <p style={{ color: '#5A6978', marginBottom: 16 }}>Importa pacientes, equipos y alquileres desde un archivo Excel (.xlsx)</p>
        <input type="file" accept=".xlsx,.xls" onChange={handleImport} disabled={importing} />
        {importing && <p>Importando...</p>}
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="plug" size={18} /> API de vencimientos (Santi)</h3>
        <p style={{ color: '#5A6978', marginBottom: 12 }}>
          Generá un enlace seguro para que Hermes (u otro sistema) consulte los vencimientos de alquileres en tiempo real: vencidos, vencen hoy y próximos 7 días.
        </p>
        {settings.apiKey ? (
          <>
            <div className="form-group">
              <label className="form-label">Enlace de vencimientos</label>
              <input type="text" className="form-input" readOnly value={apiUrl} onFocus={e => e.target.select()} style={{ fontSize: 12 }} />
            </div>
            <div className="form-group">
              <label className="form-label">Enlace de precios (equipos y mascaras)</label>
              <input type="text" className="form-input" readOnly value={apiUrlPrecios} onFocus={e => e.target.select()} style={{ fontSize: 12 }} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => handleCopyApiUrl(apiUrl)}><Icon name="copy" size={16} /> Copiar vencimientos</button>
              <button className="btn btn-primary" onClick={() => handleCopyApiUrl(apiUrlPrecios)}><Icon name="copy" size={16} /> Copiar precios</button>
              <button className="btn btn-secondary" onClick={handleGenerateApiKey}><Icon name="refresh" size={16} /> Regenerar clave</button>
            </div>
            <p style={{ color: '#9AA5B4', fontSize: 12, marginTop: 10 }}>
              Cualquiera con este enlace puede ver los vencimientos. Si se filtró, regenerá la clave y el enlace viejo deja de funcionar.
            </p>
          </>
        ) : (
          <button className="btn btn-primary" onClick={handleGenerateApiKey}><Icon name="key" size={16} /> Generar clave API</button>
        )}
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="building" size={18} /> Datos de la empresa</h3>
        
        <div className="form-group">
          <label className="form-label">Nombre</label>
          <input type="text" className="form-input" value={form.companyName} onChange={e => setForm({...form, companyName: e.target.value})} />
        </div>
        
        <div className="form-group">
          <label className="form-label">Teléfono</label>
          <input type="text" className="form-input" value={form.companyPhone} onChange={e => setForm({...form, companyPhone: e.target.value})} />
        </div>
        
        <div className="form-group">
          <label className="form-label">Dirección</label>
          <input type="text" className="form-input" value={form.companyAddress} onChange={e => setForm({...form, companyAddress: e.target.value})} />
        </div>
        
        <button className="btn btn-primary" onClick={handleSave}>Guardar</button>
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="tag" size={18} /> Precios por defecto</h3>
        
        <div className="form-group">
          <label className="form-label">Alquiler mensual ($)</label>
          <input type="number" className="form-input" value={form.monthlyRentalPrice} onChange={e => setForm({...form, monthlyRentalPrice: Number(e.target.value)})} />
        </div>
        
        <div className="form-group">
          <label className="form-label">Alquiler diario ($)</label>
          <input type="number" className="form-input" value={form.dailyRentalPrice} onChange={e => setForm({...form, dailyRentalPrice: Number(e.target.value)})} />
        </div>
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="bars" size={18} /> Estadísticas</h3>
        <div className="grid-3">
          <div className="stat-card">
            <div className="stat-value">{patients.length}</div>
            <div className="stat-label">Pacientes</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{equipment.length}</div>
            <div className="stat-label">Equipos</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{rentals.length}</div>
            <div className="stat-label">Alquileres</div>
          </div>
        </div>
      </div>

      <button className="btn btn-danger btn-block" onClick={handleClear}><Icon name="trash" size={16} /> Borrar todos los datos</button>
    </div>
  );
}

function ApiPage() {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const jsClientCode = `const API_BASE_URL = '${baseUrl}/api';

async function api(path, options = {}) {
  const response = await fetch(\`\${API_BASE_URL}\${path}\`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    throw new Error(\`API error \${response.status}\`);
  }

  return response.status === 204 ? null : response.json();
}

export async function getDatabase() {
  return api('/db');
}

export async function getEquipment() {
  return api('/equipment');
}

export async function getRentals() {
  return api('/rentals');
}

export async function updateRentalPrice(id, price) {
  return api(\`/rentals/\${id}\`, {
    method: 'PATCH',
    body: JSON.stringify({ price })
  });
}

export async function updateMascaraPrice(id, price) {
  return api(\`/mascaras/\${id}\`, {
    method: 'PATCH',
    body: JSON.stringify({ price })
  });
}

export async function updateDescartablePrice(id, price) {
  return api(\`/descartables/\${id}\`, {
    method: 'PATCH',
    body: JSON.stringify({ price })
  });
}`;
  const assistantExampleCode = `import {
  getDatabase,
  getEquipment,
  updateMascaraPrice
} from './insersalud-api.js';

async function main() {
  const db = await getDatabase();
  console.log('Pacientes:', db.patients.length);
  console.log('Equipos:', db.equipment.length);

  const equipment = await getEquipment();
  console.log('Primer equipo:', equipment[0]);

  await updateMascaraPrice('ID_DE_LA_MASCARA', 18000);
  console.log('Precio actualizado');
}

main().catch(console.error);`;
  const curlExamples = `curl ${baseUrl}/api/db

curl -X PATCH ${baseUrl}/api/rentals/ID_DEL_ALQUILER ^
  -H "Content-Type: application/json" ^
  -d "{\\"price\\":25000}"

curl -X PATCH ${baseUrl}/api/mascaras/ID_DE_LA_MASCARA ^
  -H "Content-Type: application/json" ^
  -d "{\\"price\\":18000}"`;

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      alert('Contenido copiado');
    } catch (error) {
      alert('No se pudo copiar');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">API</h1>
        <p className="page-subtitle">Acceso para otro asistente o sistema externo</p>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Base de la API</h3>
            <p className="page-subtitle">Usar esta URL como punto de entrada desde otro programa</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(`${baseUrl}/api`)}>
            Copiar URL
          </button>
        </div>
        <div className="api-code-block">{baseUrl}/api</div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Código para otro programa</h3>
            <p className="page-subtitle">Copiar este archivo y usarlo para conectarse a esta aplicación</p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => handleCopy(jsClientCode)}>
            Copiar código JS
          </button>
        </div>
        <pre className="api-code-block">{jsClientCode}</pre>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Uso dentro de otro asistente</h3>
            <p className="page-subtitle">Ejemplo real de cómo llamarlo desde un programa externo</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(assistantExampleCode)}>
            Copiar ejemplo
          </button>
        </div>
        <pre className="api-code-block">{assistantExampleCode}</pre>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Comandos rápidos</h3>
            <p className="page-subtitle">Pruebas directas para leer la base o cambiar precios</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(curlExamples)}>
            Copiar comandos
          </button>
        </div>
        <pre className="api-code-block">{curlExamples}</pre>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Qué puede hacer</h3>
            <p className="page-subtitle">Operaciones disponibles sobre la base de esta app</p>
          </div>
        </div>
        <div className="api-endpoint-list">
          {[
            'Leer toda la base de datos',
            'Leer equipos, alquileres, mascaras y descartables',
            'Actualizar precios por id',
            'Modificar configuracion general',
            'Crear, editar y borrar registros por API'
          ].map(item => (
            <div key={item} className="api-endpoint-item">{item}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DescartablesPage({ data, updateData }) {
  const { descartables } = data;
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('todos');
  const [search, setSearch] = useState('');

  const defaultItem = {
    id: '',
    name: '',
    category: 'consumibles',
    unit: 'unidades',
    price: 0,
    stock: 0,
    minStock: 10,
    supplier: '',
    description: ''
  };

  const [form, setForm] = useState(defaultItem);

  const categories = [
    { value: 'consumibles', label: 'Consumibles' },
    { value: 'filtros', label: 'Filtros' },
    { value: 'mascarillas', label: 'Mascarillas' },
    { value: 'tubuladuras', label: 'Tubuladuras' },
    { value: 'cables', label: 'Cables' },
    { value: 'otros', label: 'Otros' }
  ];

  const filteredItems = descartables.filter(item => {
    const matchesFilter = filter === 'todos' || item.category === filter;
    const matchesSearch = item.name.toLowerCase().includes(search.toLowerCase()) ||
                          item.description?.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const lowStockItems = descartables.filter(item => item.stock <= item.minStock);

  const handleSave = () => {
    const newItem = {
      ...form,
      id: form.id || generateId(),
      updatedAt: getToday()
    };
    if (!confirm(editing ? `¿Guardar los cambios de "${newItem.name}"?` : `¿Agregar el producto "${newItem.name}"?`)) return;
    updateData(cur => ({ ...cur, descartables: editing ? cur.descartables.map(d => d.id === editing ? newItem : d) : [...cur.descartables, newItem] }));
    setForm(defaultItem);
    setShowForm(false);
    setEditing(null);
  };

  const handleEdit = (item) => {
    setForm(item);
    setEditing(item.id);
    setShowForm(true);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar este producto?')) {
      updateData(cur => ({ ...cur, descartables: cur.descartables.filter(d => d.id !== id) }));
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Descartables</h1>
        <button className="btn btn-primary" onClick={() => { setForm(defaultItem); setShowForm(true); setEditing(null); }}>
          + Nuevo Producto
        </button>
      </div>

      {lowStockItems.length > 0 && (
        <div className="card" style={{ background: '#FFF3E0', border: '1px solid #FF9800', marginBottom: 20 }}>
          <h3 className="card-title"><Icon name="alert" size={18} /> Stock bajo</h3>
          <p>{lowStockItems.length} productos con stock bajo mínimo</p>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <input
            type="text"
            className="form-input"
            placeholder="Buscar..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <select className="form-input" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="todos">Todas las categorías</option>
            {categories.map(cat => (
              <option key={cat.value} value={cat.value}>{cat.label}</option>
            ))}
          </select>
        </div>

        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Categoría</th>
                <th>Stock</th>
                <th>Precio</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center' }}>No hay productos</td></tr>
              ) : (
                filteredItems.map(item => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                      {item.description && <div style={{ fontSize: 12, color: '#5A6978' }}>{item.description}</div>}
                    </td>
                    <td>{categories.find(c => c.value === item.category)?.label || item.category}</td>
                    <td>
                      <span style={{ 
                        color: item.stock <= item.minStock ? '#E53935' : '#43A047',
                        fontWeight: 'bold'
                      }}>
                        {item.stock} {item.unit}
                      </span>
                    </td>
                    <td>{formatCurrency(item.price)}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => handleEdit(item)} title="Editar" aria-label="Editar"><Icon name="edit" size={16} /></button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(item.id)} title="Eliminar" aria-label="Eliminar"><Icon name="trash" size={16} /></button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="card-title">{editing ? 'Editar' : 'Nuevo'} Producto</h2>
            
            <div className="form-group">
              <label className="form-label">Nombre *</label>
              <input type="text" className="form-input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} />
            </div>

            <div className="form-group">
              <label className="form-label">Categoría</label>
              <select className="form-input" value={form.category} onChange={e => setForm({...form, category: e.target.value})}>
                {categories.map(cat => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
              </select>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Stock</label>
                <input type="number" className="form-input" value={form.stock} onChange={e => setForm({...form, stock: Number(e.target.value)})} />
              </div>
              <div className="form-group">
                <label className="form-label">Unidad</label>
                <select className="form-input" value={form.unit} onChange={e => setForm({...form, unit: e.target.value})}>
                  <option value="unidades">Unidades</option>
                  <option value="cajas">Cajas</option>
                  <option value="packs">Packs</option>
                </select>
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Precio unitario ($)</label>
                <input type="number" className="form-input" value={form.price} onChange={e => setForm({...form, price: Number(e.target.value)})} />
              </div>
              <div className="form-group">
                <label className="form-label">Stock mínimo</label>
                <input type="number" className="form-input" value={form.minStock} onChange={e => setForm({...form, minStock: Number(e.target.value)})} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Proveedor</label>
              <input type="text" className="form-input" value={form.supplier} onChange={e => setForm({...form, supplier: e.target.value})} />
            </div>

            <div className="form-group">
              <label className="form-label">Descripción</label>
              <textarea className="form-input" rows={3} value={form.description} onChange={e => setForm({...form, description: e.target.value})} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button className="btn btn-primary" onClick={handleSave}>Guardar</button>
              <button className="btn" onClick={() => setShowForm(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FacturacionReportes({ data }) {
  const { invoices = [], rentals = [] } = data;
  const [showFacturados, setShowFacturados] = useState(false);

  const hoy = getToday();
  const primerDiaMes = hoy.slice(0, 7) + '-01';
  const [desde, setDesde] = useState(primerDiaMes);
  const [hasta, setHasta] = useState(hoy);

  const invDate = (inv) => (inv.date || inv.createdAt || '').slice(0, 10);
  const facturadosPeriodo = invoices.filter(inv => {
    const dt = invDate(inv);
    return dt && dt >= desde && dt <= hasta;
  });
  const totalFacturadoPeriodo = facturadosPeriodo.reduce((s, inv) => s + Number(inv.total || 0), 0);

  const ventasPorMes = (mk) => invoices
    .filter(inv => invDate(inv).slice(0, 7) === mk)
    .reduce((s, inv) => s + Number(inv.total || 0), 0);
  const alquiladoPorMes = (mk) => rentals
    .filter(r => isRentalInMonth(r, mk))
    .reduce((s, r) => s + Number(r.price || 0), 0);

  // Meses dentro del periodo elegido (por defecto, solo el mes en curso).
  const meses = (() => {
    const out = [];
    let [y, m] = desde.slice(0, 7).split('-').map(Number);
    const [ey, em] = hasta.slice(0, 7).split('-').map(Number);
    let guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard < 24) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++; if (m > 12) { m = 1; y++; }
      guard++;
    }
    return out.length ? out : [hoy.slice(0, 7)];
  })();
  const alquiladoPeriodo = meses.reduce((s, mk) => s + alquiladoPorMes(mk), 0);

  const serie = meses.map(mk => ({ mk, alquilado: alquiladoPorMes(mk), ventas: ventasPorMes(mk) }));
  const maxVal = Math.max(1, ...serie.map(s => Math.max(s.alquilado, s.ventas)));

  // Comparativa: ultimo mes del periodo vs el mes anterior.
  const act = serie[serie.length - 1] || { mk: hoy.slice(0, 7), alquilado: 0, ventas: 0 };
  const [py, pm] = act.mk.split('-').map(Number);
  const prevMk = pm === 1 ? `${py - 1}-12` : `${py}-${String(pm - 1).padStart(2, '0')}`;
  const ant = { mk: prevMk, alquilado: alquiladoPorMes(prevMk), ventas: ventasPorMes(prevMk) };
  const variacion = (a, b) => {
    if (!b) return a > 0 ? { txt: 'nuevo', up: true } : { txt: '—', up: null };
    const pct = Math.round(((a - b) / b) * 100);
    return { txt: `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`, up: pct >= 0 };
  };
  const vAlq = variacion(act.alquilado, ant.alquilado);
  const vVen = variacion(act.ventas, ant.ventas);
  const mesCorto = (mk) => formatMonthLabel(mk).slice(0, 3);

  // Grafico de barras agrupadas (SVG). Ancho fijo virtual, escala por viewBox.
  const W = 660, H = 220, pad = 30, gap = 16;
  const groupW = (W - pad * 2) / serie.length;
  const barW = (groupW - gap) / 2;

  return (
    <div style={{ marginTop: 24 }}>
      <div className="card">
        <h3 className="card-title">Reportes de facturación</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Desde</label>
            <input type="date" className="form-input" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Hasta</label>
            <input type="date" className="form-input" value={hasta} min={desde} onChange={e => setHasta(e.target.value)} />
          </div>
          <button className="btn btn-secondary" onClick={() => { setDesde(primerDiaMes); setHasta(hoy); }}>Mes actual</button>
        </div>
        <p className="page-subtitle" style={{ marginTop: 8 }}>Período: {formatDate(desde)} a {formatDate(hasta)}</p>
        <div className="monthly-summary-grid" style={{ marginTop: 10 }}>
          <div className="monthly-summary-item">
            <span className="monthly-summary-label">Facturado (ventas)</span>
            <strong className="monthly-summary-value">{formatCurrency(totalFacturadoPeriodo)}</strong>
          </div>
          <div className="monthly-summary-item">
            <span className="monthly-summary-label">Alquilado</span>
            <strong className="monthly-summary-value">{formatCurrency(alquiladoPeriodo)}</strong>
          </div>
        </div>
      </div>

      <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} onClick={() => setShowFacturados(!showFacturados)}>
        <Icon name="file" size={16} /> Facturados del período ({facturadosPeriodo.length}) — {formatCurrency(totalFacturadoPeriodo)}
      </button>

      {showFacturados && (
        <div className="card" style={{ borderTop: '3px solid #1E5AA8', marginTop: 12 }}>
          <div style={{ background: '#E3F2FD', border: '1px solid #90CAF9', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: '#1E5AA8' }}>Total facturado del período</span>
            <strong style={{ fontSize: 18, color: '#1E5AA8' }}>{formatCurrency(totalFacturadoPeriodo)}</strong>
          </div>
          {facturadosPeriodo.length === 0 ? (
            <p style={{ textAlign: 'center', color: '#5A6978', padding: 10 }}>No hay facturas en el período</p>
          ) : facturadosPeriodo.map(inv => (
            <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #E3F2FD' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{inv.customerName || inv.clientName || 'Sin nombre'}</div>
                <div style={{ fontSize: 12, color: '#5A6978' }}>{inv.invoiceNumber || ''} · {formatDate(inv.date || inv.createdAt)}</div>
              </div>
              <strong style={{ color: '#1E5AA8' }}>{formatCurrency(inv.total)}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="card-title"><Icon name="bars" size={18} /> Alquilado vs ventas {meses.length > 1 ? 'por mes' : 'del mes'}</h3>
        <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 13 }}>
          <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#1E5AA8', borderRadius: 2, marginRight: 5 }} />Alquilado</span>
          <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#2E7D32', borderRadius: 2, marginRight: 5 }} />Ventas</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} preserveAspectRatio="xMidYMid meet">
          <line x1={pad} y1={H - 22} x2={W - pad} y2={H - 22} stroke="#CFD8DC" strokeWidth="1" />
          {serie.map((s, i) => {
            const x0 = pad + i * groupW;
            const chartH = H - 22 - 12;
            const hAlq = (s.alquilado / maxVal) * chartH;
            const hVen = (s.ventas / maxVal) * chartH;
            return (
              <g key={s.mk}>
                <rect x={x0 + gap / 2} y={H - 22 - hAlq} width={barW} height={hAlq} fill="#1E5AA8" rx="2" />
                <rect x={x0 + gap / 2 + barW} y={H - 22 - hVen} width={barW} height={hVen} fill="#2E7D32" rx="2" />
                <text x={x0 + groupW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#5A6978">{mesCorto(s.mk)}</text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="card-title"><Icon name="trend" size={18} /> Comparativa mes a mes</h3>
        <p className="page-subtitle" style={{ marginBottom: 12 }}>{formatMonthLabel(act.mk)} vs {formatMonthLabel(ant.mk)}</p>
        <div className="monthly-summary-grid">
          <div className="monthly-summary-item">
            <span className="monthly-summary-label">Alquilado ({mesCorto(act.mk)})</span>
            <strong className="monthly-summary-value">{formatCurrency(act.alquilado)}</strong>
            <span style={{ fontSize: 13, fontWeight: 700, color: vAlq.up === false ? '#E53935' : '#2E7D32' }}>{vAlq.txt}</span>
          </div>
          <div className="monthly-summary-item">
            <span className="monthly-summary-label">Ventas ({mesCorto(act.mk)})</span>
            <strong className="monthly-summary-value">{formatCurrency(act.ventas)}</strong>
            <span style={{ fontSize: 13, fontWeight: 700, color: vVen.up === false ? '#E53935' : '#2E7D32' }}>{vVen.txt}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FacturacionPage({ data, updateData }) {
  return (
    <>
      <SalesCartPage data={data} updateData={updateData} pageType="factura" />
      <FacturacionReportes data={data} />
    </>
  );
}

export default App;
