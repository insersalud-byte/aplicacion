import { useState, useEffect, useRef, useCallback } from 'react';
import { loadData, saveData, generateId, generateDocNumber, getToday, toLocalDateStr, formatDate, formatCurrency, parseExcelData, sendWhatsApp, generateInvoicePDF, downloadInvoicePDF, onSyncStatus, onDataChange, refreshFromRemote, syncIfRemoteChanged } from './data/database';
import './App.css';

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

function isRentalPaidForMonth(rental, monthKey) {
  return Boolean(rental.paymentStatusByMonth?.[monthKey]?.paid);
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

function SyncIndicator() {
  const [status, setStatus] = useState({ state: 'idle', lastSync: null, error: null });

  useEffect(() => {
    return onSyncStatus(setStatus);
  }, []);

  const label = status.state === 'ok' ? 'Sincronizado'
    : status.state === 'saving' || status.state === 'loading' ? 'Sincronizando...'
    : status.state === 'error' ? 'Sin conexion'
    : '';
  const color = status.state === 'ok' ? '#4ade80'
    : status.state === 'error' ? '#f87171'
    : status.state === 'saving' || status.state === 'loading' ? '#facc15'
    : '#94a3b8';

  return (
    <div style={{ padding: '8px 16px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, opacity: 0.85 }}
      title={status.error || ''}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
      <span style={{ color: '#cbd5e1' }}>{label}</span>
    </div>
  );
}

function App() {
  const [currentPage, setCurrentPage] = useState('home');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // dataRef refleja siempre el ultimo estado. Se actualiza en cada camino que
  // hace setData (init, updateData, onDataChange), nunca durante el render.
  const dataRef = useRef(null);

  useEffect(() => {
    let active = true;

    const initializeData = async () => {
      const loaded = await loadData();
      if (!active) return;
      dataRef.current = loaded;
      setData(loaded);
      setLoading(false);
    };

    initializeData();

    return () => {
      active = false;
    };
  }, []);

  const updateData = useCallback((updater) => {
    const nextData = typeof updater === 'function' ? updater(dataRef.current) : updater;
    dataRef.current = nextData;
    setData(nextData);
    saveData(nextData);
  }, []);

  // Mantener la app sincronizada con la base entre dispositivos:
  // - onDataChange: cuando llega un cambio de otro dispositivo, refresca la UI.
  // - heartbeat cada 5s (solo el timestamp, liviano): si la base cambio, baja todo.
  // - focus / volver a la pestania / reconexion: refresco completo inmediato.
  useEffect(() => {
    const unsub = onDataChange((incoming) => {
      dataRef.current = incoming;
      setData(incoming);
    });
    const fullRefresh = () => { refreshFromRemote(); };
    const heartbeat = () => { if (document.visibilityState === 'visible') syncIfRemoteChanged(); };
    const onVis = () => { if (document.visibilityState === 'visible') fullRefresh(); };
    window.addEventListener('focus', fullRefresh);
    window.addEventListener('online', fullRefresh);
    document.addEventListener('visibilitychange', onVis);
    const iv = setInterval(heartbeat, 5000);
    return () => {
      unsub();
      window.removeEventListener('focus', fullRefresh);
      window.removeEventListener('online', fullRefresh);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(iv);
    };
  }, []);

  if (loading || !data) {
    return <div className="app-container"><div className="main-content">Cargando...</div></div>;
  }

  const renderPage = () => {
    switch (currentPage) {
      case 'home': return <HomePage data={data} updateData={updateData} setCurrentPage={setCurrentPage} />;
      case 'patients': return <PatientsPage data={data} updateData={updateData} />;
      case 'rentals': return <RentalsPage data={data} updateData={updateData} />;
      case 'equipment': return <EquipmentPage data={data} updateData={updateData} />;
      case 'mascaras': return <MascarasPage data={data} updateData={updateData} />;
      case 'equiposNuevos': return <EquiposNuevosPage data={data} updateData={updateData} />;
      case 'quotations': return <QuotationsPage data={data} updateData={updateData} />;
      case 'calendar': return <CalendarPage data={data} />;
      case 'descartables': return <DescartablesPage data={data} updateData={updateData} />;
      case 'facturacion': return <FacturacionPage data={data} updateData={updateData} />;
      case 'settings': return <SettingsPage data={data} updateData={updateData} />;
      case 'api': return <ApiPage />;
      default: return <HomePage data={data} updateData={updateData} setCurrentPage={setCurrentPage} />;
    }
  };

  return (
    <div className="app-container">
      <nav className="sidebar">
        <div className="sidebar-logo">Inser Salud</div>
        <div className="sidebar-subtitle">Gestión de Equipos Respiratorios</div>
        
        <div className={`nav-item ${currentPage === 'home' ? 'active' : ''}`} onClick={() => setCurrentPage('home')}>
          <span className="nav-icon">🏠</span>
          <span className="nav-label">Inicio</span>
        </div>
        
        <div className={`nav-item ${currentPage === 'patients' ? 'active' : ''}`} onClick={() => setCurrentPage('patients')}>
          <span className="nav-icon">👤</span>
          <span className="nav-label">Pacientes</span>
        </div>
        
        <div className={`nav-item ${currentPage === 'rentals' ? 'active' : ''}`} onClick={() => setCurrentPage('rentals')}>
          <span className="nav-icon">📋</span>
          <span className="nav-label">Alquileres</span>
        </div>
        
        <div className={`nav-item ${currentPage === 'equipment' ? 'active' : ''}`} onClick={() => setCurrentPage('equipment')}>
          <span className="nav-icon">🔧</span>
          <span className="nav-label">Equipos</span>
        </div>

        <div className={`nav-item ${currentPage === 'mascaras' ? 'active' : ''}`} onClick={() => setCurrentPage('mascaras')}>
          <span className="nav-icon">😷</span>
          <span className="nav-label">Mascarillas</span>
        </div>

        <div className={`nav-item ${currentPage === 'equiposNuevos' ? 'active' : ''}`} onClick={() => setCurrentPage('equiposNuevos')}>
          <span className="nav-icon">🆕</span>
          <span className="nav-label">Equipos Nuevos</span>
        </div>

        <div className={`nav-item ${currentPage === 'quotations' ? 'active' : ''}`} onClick={() => setCurrentPage('quotations')}>
          <span className="nav-icon">💰</span>
          <span className="nav-label">Cotiz./Remito</span>
        </div>
        
        <div className={`nav-item ${currentPage === 'calendar' ? 'active' : ''}`} onClick={() => setCurrentPage('calendar')}>
          <span className="nav-icon">📅</span>
          <span className="nav-label">Calendario</span>
        </div>
        
        <div className={`nav-item ${currentPage === 'descartables' ? 'active' : ''}`} onClick={() => setCurrentPage('descartables')}>
          <span className="nav-icon">🧤</span>
          <span className="nav-label">Descartables</span>
        </div>
        
        <div className={`nav-item ${currentPage === 'facturacion' ? 'active' : ''}`} onClick={() => setCurrentPage('facturacion')}>
          <span className="nav-icon">🛒</span>
          <span className="nav-label">Facturación</span>
        </div>
        
        <div className={`nav-item ${currentPage === 'settings' ? 'active' : ''}`} onClick={() => setCurrentPage('settings')}>
          <span className="nav-icon">⚙️</span>
          <span className="nav-label">Configuración</span>
        </div>

        <div style={{ marginTop: 'auto' }}>
          <SyncIndicator />
        </div>
      </nav>
      
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  );
}

function HomePage({ data, updateData, setCurrentPage }) {
  const { patients, equipment, rentals } = data;
  const today = getToday();
  const currentMonthKey = getMonthKey(new Date());

  const getUnpaidMonthsForRental = (rental) => {
    if (!rental.endDate) return [];
    const end = new Date(rental.endDate);
    const now = new Date();
    const months = [];
    let d = new Date(end.getFullYear(), end.getMonth(), 1);
    while (d <= now) {
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!isRentalPaidForMonth(rental, mk)) months.push(mk);
      d.setMonth(d.getMonth() + 1);
    }
    return months;
  };

  useEffect(() => {
    const todayStr = getToday();
    const needsUpdate = rentals.some(r => {
      if (r.status === 'finalizado' || !r.startDate) return false;
      if (!r.endDate) return true; // sin vencimiento -> hay que ponerlo automaticamente
      if (alignDueDay(r.endDate, r.startDate) !== r.endDate) return true; // vencimiento no cae el dia de inicio
      if (cappedDueDate(r) !== r.endDate) return true; // vencimiento a mas de un mes del que corresponde
      if (r.status === 'activo' && r.endDate <= todayStr) return true;
      if (r.status === 'vencido' && r.endDate > todayStr) return true;
      if (r.status === 'vencido' && r.endDate <= todayStr && getUnpaidMonthsForRental(r).length === 0) return true;
      return false;
    });
    if (!needsUpdate) return;

    updateData(cur => {
      const updated = cur.rentals.map(rental => {
        if (rental.status === 'finalizado' || !rental.startDate) return rental;
        let r = rental;
        // 0) Si no tiene vencimiento, ponerlo automaticamente: dia de inicio, proximo vencimiento desde hoy.
        if (!r.endDate) r = { ...r, endDate: rollingDueDate(r.startDate) };
        if (!r.endDate) return r; // startDate invalido: no se pudo calcular
        // 1) El vencimiento SIEMPRE cae el dia de inicio (corrige desfases automaticamente).
        const aligned = alignDueDay(r.endDate, r.startDate);
        if (aligned !== r.endDate) r = { ...r, endDate: aligned };
        // 2) Tope: el vencimiento nunca a mas de un mes del que corresponde por inicio.
        const capped = cappedDueDate(r);
        if (capped !== r.endDate) r = { ...r, endDate: capped };
        // 3) Estado segun la fecha ya normalizada.
        if (r.status === 'activo' && r.endDate <= todayStr) return { ...r, status: 'vencido' };
        if (r.status === 'vencido' && r.endDate > todayStr) return { ...r, status: 'activo' };
        if (r.status === 'vencido' && r.endDate <= todayStr && getUnpaidMonthsForRental(r).length === 0) {
          // Pago al dia: el proximo vencimiento es el dia de inicio del mes siguiente.
          return { ...r, status: 'activo', endDate: nextDueAfter(r.endDate, r.startDate) };
        }
        return r;
      });
      return { ...cur, rentals: updated };
    });
  }, [rentals, today, updateData]);

  const activeRentals = rentals.filter(r => r.status === 'activo');
  const expiringRentals = rentals.filter(r => {
    if (r.status !== 'activo' || !r.endDate) return false;
    const today = getToday();
    return r.endDate >= today && r.endDate.substring(0, 7) === today.substring(0, 7);
  });

  const homeTodayStr = getToday();
  const homeTodayParts = homeTodayStr.split('-').map(Number);
  const homeIn2DaysDate = new Date(homeTodayParts[0], homeTodayParts[1] - 1, homeTodayParts[2] + 2);
  const homeIn2DaysStr = `${homeIn2DaysDate.getFullYear()}-${String(homeIn2DaysDate.getMonth()+1).padStart(2,'0')}-${String(homeIn2DaysDate.getDate()).padStart(2,'0')}`;
  const homeExpiringToday = rentals.filter(r => r.endDate === homeTodayStr && r.status !== 'finalizado');
  const homeExpiringSoon = rentals.filter(r => r.endDate && r.endDate > homeTodayStr && r.endDate <= homeIn2DaysStr && r.status !== 'finalizado');
  const getPatientNameHome = (id) => patients.find(p => p.id === id)?.name || '-';
  const getEquipmentNameHome = (id) => equipment.find(e => e.id === id)?.name || '-';
  // Vencidos de dias anteriores (los que vencen HOY van en el bloque "Vencen HOY" de arriba).
  const homeAlreadyExpired = rentals.filter(r => {
    if (r.status === 'finalizado' || !r.endDate) return false;
    return r.endDate < homeTodayStr;
  });
  // Tarjeta "Vencidos": vencidos (hoy inclusive) con meses sin pagar.
  const expiredRentals = rentals.filter(r => {
    if (r.status === 'finalizado' || !r.endDate || r.endDate > today) return false;
    return getUnpaidMonthsForRental(r).length > 0;
  });
  // Disponibilidad derivada de los alquileres reales, no del campo equipment.available (que esta desactualizado).
  const availableEquipment = equipment.filter(e => e.status !== 'mantenimiento' && !getOccupyingRental(rentals, e.id));
  // Un alquiler cuenta como cobrado del mes si se tildo como pagado ese mes, o si
  // ES NUEVO de este mes (el primer mes se cobra al iniciar; recien vence el mes que viene).
  const startsThisMonth = (r) => (r.startDate || '').slice(0, 7) === currentMonthKey;
  const isCollectedThisMonth = (r) => isRentalPaidForMonth(r, currentMonthKey) || (r.status !== 'finalizado' && startsThisMonth(r));

  const monthlyRentals = rentals.filter(rental => isRentalInMonth(rental, currentMonthKey));
  const monthlyTotal = monthlyRentals.reduce((sum, rental) => sum + Number(rental.price || 0), 0);
  const monthlyCollected = monthlyRentals.reduce((sum, rental) => (
    isCollectedThisMonth(rental) ? sum + Number(rental.price || 0) : sum
  ), 0);
  const monthlyPending = monthlyTotal - monthlyCollected;

  // Cobrados del mes: tildados como cobrados + altas nuevas del mes.
  const collectedRentals = rentals.filter(isCollectedThisMonth);
  const collectedTotal = collectedRentals.reduce((s, r) => s + Number(r.price || 0), 0);

  const [activeFilter, setActiveFilter] = useState(null);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Inser Salud</h1>
        <p className="page-subtitle">Gestión de Equipos Respiratorios</p>
      </div>

      {homeExpiringToday.length > 0 && (
        <div style={{ background: '#FFEBEE', border: '2px solid #EF5350', borderRadius: 10, padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#C62828', marginBottom: 4 }}>🔴 Vencen HOY ({homeExpiringToday.length})</div>
          {homeExpiringToday.map(r => (
            <div key={r.id} style={{ fontSize: 13, color: '#B71C1C', marginTop: 2 }}>
              • {getPatientNameHome(r.patientId)} — {getEquipmentNameHome(r.equipmentId)} — vence {formatDate(r.endDate)}
            </div>
          ))}
        </div>
      )}

      {homeExpiringSoon.length > 0 && (
        <div style={{ background: '#FFF3E0', border: '2px solid #FFA726', borderRadius: 10, padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#E65100', marginBottom: 4 }}>🟠 Por vencer en 2 dias ({homeExpiringSoon.length})</div>
          {homeExpiringSoon.map(r => (
            <div key={r.id} style={{ fontSize: 13, color: '#BF360C', marginTop: 2 }}>
              • {getPatientNameHome(r.patientId)} — {getEquipmentNameHome(r.equipmentId)} — vence {formatDate(r.endDate)}
            </div>
          ))}
        </div>
      )}

      {homeAlreadyExpired.length > 0 && (
        <div style={{ background: '#F3E5F5', border: '2px solid #AB47BC', borderRadius: 10, padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#6A1B9A', marginBottom: 4 }}>⚠️ Vencidos ({homeAlreadyExpired.length})</div>
          {homeAlreadyExpired.map(r => (
            <div key={r.id} style={{ fontSize: 13, color: '#4A148C', marginTop: 2 }}>
              • {getPatientNameHome(r.patientId)} — {getEquipmentNameHome(r.equipmentId)} — vencio {formatDate(r.endDate)}
            </div>
          ))}
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card" style={{ cursor: 'pointer', outline: activeFilter === 'activos' ? '3px solid #1E5AA8' : 'none', borderRadius: 12 }} onClick={() => setActiveFilter(activeFilter === 'activos' ? null : 'activos')}>
          <div className="stat-icon">📋</div>
          <div className="stat-value">{activeRentals.length}</div>
          <div className="stat-label">Alquileres Activos</div>
        </div>
        <div className="stat-card warning" style={{ cursor: 'pointer', outline: activeFilter === 'porVencer' ? '3px solid #F9A825' : 'none', borderRadius: 12 }} onClick={() => setActiveFilter(activeFilter === 'porVencer' ? null : 'porVencer')}>
          <div className="stat-icon">⚠️</div>
          <div className="stat-value">{expiringRentals.length}</div>
          <div className="stat-label">Por Vencer</div>
        </div>
        <div className="stat-card error" style={{ cursor: 'pointer', outline: activeFilter === 'vencidos' ? '3px solid #E53935' : 'none', borderRadius: 12 }} onClick={() => setActiveFilter(activeFilter === 'vencidos' ? null : 'vencidos')}>
          <div className="stat-icon">❌</div>
          <div className="stat-value">{expiredRentals.length}</div>
          <div className="stat-label">Vencidos</div>
        </div>
        <div className="stat-card success" style={{ cursor: 'pointer', outline: activeFilter === 'cobrados' ? '3px solid #2E7D32' : 'none', borderRadius: 12 }} onClick={() => setActiveFilter(activeFilter === 'cobrados' ? null : 'cobrados')}>
          <div className="stat-icon">💵</div>
          <div className="stat-value">{collectedRentals.length}</div>
          <div className="stat-label">Alquileres Cobrados</div>
        </div>
        <div className="stat-card success">
          <div className="stat-icon">✓</div>
          <div className="stat-value">{availableEquipment.length}</div>
          <div className="stat-label">Equipos Disponibles</div>
        </div>
      </div>

      {activeFilter && (() => {
        const isCobrados = activeFilter === 'cobrados';
        const list = activeFilter === 'activos' ? activeRentals : activeFilter === 'porVencer' ? expiringRentals : isCobrados ? collectedRentals : expiredRentals;
        const title = activeFilter === 'activos' ? 'Alquileres Activos' : activeFilter === 'porVencer' ? 'Por Vencer' : isCobrados ? `Alquileres Cobrados de ${formatMonthLabel(currentMonthKey)}` : 'Vencidos';
        const color = activeFilter === 'activos' ? '#1E5AA8' : activeFilter === 'porVencer' ? '#F9A825' : isCobrados ? '#2E7D32' : '#E53935';
        const isVencidos = activeFilter === 'vencidos';

        const getUnpaidMonths = (rental) => {
          if (!rental.endDate) return [];
          const end = new Date(rental.endDate);
          const now = new Date();
          const months = [];
          let d = new Date(end.getFullYear(), end.getMonth(), 1);
          while (d <= now) {
            const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (!isRentalPaidForMonth(rental, mk)) months.push(mk);
            d.setMonth(d.getMonth() + 1);
          }
          return months;
        };

        const handlePayMonth = (rentalId, mk) => {
          const rentalPay = rentals.find(r => r.id === rentalId);
          const patientPay = patients.find(p => p.id === rentalPay?.patientId);
          if (!confirm(`¿Registrar el pago de ${formatMonthLabel(mk)} de ${patientPay?.name || 'este alquiler'}?`)) return;
          updateData(currentData => ({
            ...currentData,
            rentals: currentData.rentals.map(r => {
              if (r.id !== rentalId) return r;
              const updated = { ...r, paymentStatusByMonth: { ...(r.paymentStatusByMonth || {}), [mk]: { paid: true, updatedAt: new Date().toISOString() } } };
              const remaining = getUnpaidMonths(updated).filter(m => m !== mk);
              if (remaining.length === 0 && (r.status === 'vencido' || isRentalExpired(r))) {
                // El proximo vencimiento es el dia de INICIO del mes siguiente al vencimiento actual.
                updated.status = 'activo';
                updated.endDate = nextDueAfter(r.endDate, r.startDate);
              }
              return updated;
            })
          }));
        };

        const handleReminder = (r) => {
          const p = patients.find(x => x.id === r.patientId);
          const eq = equipment.find(e => e.id === r.equipmentId);
          if (!confirm(`¿Enviar recordatorio de vencimiento a ${p?.name || 'este paciente'} por WhatsApp?`)) return;
          const msg = `Hola ${p?.name || ''}, soy Santi de INSER SALUD. Te recuerdo el vencimiento del alquiler del equipo ${eq?.name || ''} (vence el ${formatDate(r.endDate)}). ¡Gracias!`;
          sendWhatsApp(p?.phone || '', msg);
        };

        return list.length > 0 ? (
          <div className="card" style={{ borderTop: `3px solid ${color}` }}>
            <h3 className="card-title" style={{ color }}>{title} ({list.length})</h3>
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
                <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid #E3F2FD' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{pat?.name || 'Sin paciente'}</div>
                      <div style={{ fontSize: 13, color: '#5A6978' }}>{eq?.name || 'Sin equipo'}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 600, color }}>{formatCurrency(r.price)}/mes</div>
                      <div style={{ fontSize: 12, color: '#5A6978' }}>Vence: {formatDate(r.endDate)}</div>
                      {isVencidos && unpaid.length > 0 && (
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#E53935', marginTop: 2 }}>{unpaid.length} {unpaid.length === 1 ? 'mes' : 'meses'} sin pagar</div>
                      )}
                    </div>
                  </div>
                  {isVencidos && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      <button className="btn btn-sm" style={{ background: '#FB8C00', color: '#fff', fontSize: 11, padding: '4px 8px' }} onClick={() => handleReminder(r)}>
                        📲 Recordatorio
                      </button>
                      {unpaid.map(mk => (
                        <button key={mk} className="btn btn-sm btn-success" onClick={() => handlePayMonth(r.id, mk)} style={{ fontSize: 11, padding: '4px 8px' }}>
                          Pagar {formatMonthLabel(mk)}
                        </button>
                      ))}
                    </div>
                  )}
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

      {expiringRentals.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Próximos a Vencer</h3>
          </div>
          <div className="monthly-summary-grid">
            <div className="monthly-summary-item warning">
              <span className="monthly-summary-label">Alquileres por vencer</span>
              <strong className="monthly-summary-value">{expiringRentals.length}</strong>
            </div>
            <div className="monthly-summary-item">
              <span className="monthly-summary-label">Ver detalle completo</span>
              <strong className="monthly-summary-value">Entrá a Alquileres</strong>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Accesos Rápidos</h3>
        </div>
        <div className="quick-actions">
          <div className="quick-action" onClick={() => setCurrentPage('patients')}>
            <div className="quick-action-icon">👤</div>
            <div className="quick-action-label">Nuevo Paciente</div>
          </div>
          <div className="quick-action" onClick={() => setCurrentPage('rentals')}>
            <div className="quick-action-icon">📋</div>
            <div className="quick-action-label">Nuevo Alquiler</div>
          </div>
          <div className="quick-action" onClick={() => setCurrentPage('equipment')}>
            <div className="quick-action-icon">🔧</div>
            <div className="quick-action-label">Nuevo Equipo</div>
          </div>
          <div className="quick-action" onClick={() => setCurrentPage('quotations')}>
            <div className="quick-action-icon">💰</div>
            <div className="quick-action-label">Cotización</div>
          </div>
          <div className="quick-action" onClick={() => setCurrentPage('api')}>
            <div className="quick-action-icon">🔌</div>
            <div className="quick-action-label">API</div>
          </div>
        </div>
      </div>

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
  const { patients } = data;
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null);

  const filteredPatients = [...patients].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.dni.includes(search) ||
    p.phone.includes(search)
  );

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
        <span>🔍</span>
        <input type="text" className="search-input" placeholder="Buscar por nombre, DNI o teléfono..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <button className="btn btn-primary btn-block" onClick={() => { setEditingPatient(null); setShowModal(true); }} style={{ marginBottom: 20 }}>
        + Agregar Paciente
      </button>

      {filteredPatients.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">👤</div>
          <div className="empty-title">Sin Pacientes</div>
          <div className="empty-message">Agrega tu primer paciente</div>
        </div>
      ) : (
        filteredPatients.map(patient => (
          <div key={patient.id} className="patient-card" onClick={() => { setEditingPatient(patient); setShowModal(true); }}>
            <div className="patient-avatar">{patient.name.charAt(0)}</div>
            <div className="patient-info">
              <div className="patient-name">{patient.name}</div>
              <div className="patient-detail">DNI: {patient.dni} • 📞 {patient.phone}</div>
              <div className="patient-detail">{patient.address}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); setEditingPatient(patient); setShowModal(true); }}>✏️</button>
              <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); handleDelete(patient.id); }}>🗑️</button>
            </div>
          </div>
        ))
      )}

      {showModal && (
        <PatientModal patient={editingPatient} onSave={handleSave} onClose={() => { setShowModal(false); setEditingPatient(null); }} />
      )}
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
  const { rentals, patients, equipment } = data;
  const [filter, setFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingRental, setEditingRental] = useState(null);

  const getPatientName = (id) => patients.find(p => p.id === id)?.name || '-';
  const getPatientAddress = (id) => patients.find(p => p.id === id)?.address || '';
  const getEquipmentName = (id) => equipment.find(e => e.id === id)?.name || '-';

  const rentTodayStr = getToday();
  const rentTodayParts = rentTodayStr.split('-').map(Number);
  const rentIn2Date = new Date(rentTodayParts[0], rentTodayParts[1] - 1, rentTodayParts[2] + 2);
  const rentIn2Str = `${rentIn2Date.getFullYear()}-${String(rentIn2Date.getMonth()+1).padStart(2,'0')}-${String(rentIn2Date.getDate()).padStart(2,'0')}`;
  const expiringToday = rentals.filter(r => r.endDate === rentTodayStr && r.status !== 'finalizado');
  const expiringSoon = rentals.filter(r => r.endDate && r.endDate > rentTodayStr && r.endDate <= rentIn2Str && r.status !== 'finalizado');

  const filteredRentals = rentals.filter(r => {
    if (filter === 'activo' && r.status !== 'activo') return false;
    if (filter === 'vencido' && r.status !== 'vencido' && !isRentalExpired(r)) return false;
    if (filter === 'finalizado' && r.status !== 'finalizado') return false;
    if (search) {
      const q = search.toLowerCase();
      const pName = getPatientName(r.patientId).toLowerCase();
      const eName = getEquipmentName(r.equipmentId).toLowerCase();
      const pAddr = getPatientAddress(r.patientId).toLowerCase();
      if (!pName.includes(q) && !eName.includes(q) && !pAddr.includes(q)) return false;
    }
    return true;
  });

  const handleSave = (payload) => {
    const confirmMsg = editingRental
      ? `¿Guardar los cambios del alquiler de ${getPatientName(payload.update?.patientId || payload.patientId)}?`
      : Array.isArray(payload)
        ? (payload.length === 1 ? `¿Crear el alquiler de ${getPatientName(payload[0].patientId)}?` : `¿Crear ${payload.length} alquileres?`)
        : `¿Crear el alquiler de ${getPatientName(payload.patientId)}?`;
    if (!confirm(confirmMsg)) return;
    updateData(cur => {
      let newRentals = [...cur.rentals];
      if (editingRental && payload.update) {
        newRentals = newRentals.map(r => r.id === payload.update.id ? payload.update : r);
        if (payload.create?.length) {
          const createdAt = getToday();
          newRentals = [...newRentals, ...payload.create.map(r => ({ ...r, id: generateId(), createdAt }))];
        }
      } else if (editingRental) {
        newRentals = newRentals.map(r => r.id === payload.id ? payload : r);
      } else if (Array.isArray(payload)) {
        const createdAt = getToday();
        newRentals = [...newRentals, ...payload.map(r => ({ ...r, id: generateId(), createdAt }))];
      } else {
        newRentals = [...newRentals, { ...payload, id: generateId(), createdAt: getToday() }];
      }
      return { ...cur, rentals: newRentals };
    });
    setShowModal(false);
    setEditingRental(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar alquiler?')) {
      updateData(cur => ({ ...cur, rentals: cur.rentals.filter(r => r.id !== id) }));
    }
  };

  const handleUnificarVencimientos = () => {
    const count = rentals.filter(r => r.status !== 'finalizado' && r.startDate).length;
    if (!confirm(`¿Normalizar vencimientos de ${count} alquileres? Cada uno quedara a 1 mes de su fecha de inicio, avanzando mes a mes hasta el proximo vencimiento.`)) return;
    updateData(cur => ({
      ...cur,
      rentals: cur.rentals.map(r => {
        if (r.status === 'finalizado' || !r.startDate) return r;
        const newEndDate = rollingDueDate(r.startDate);
        if (!newEndDate) return r;
        return { ...r, endDate: newEndDate };
      })
    }));
  };

  // Reseña: solo en alquileres nuevos del mes que todavia no la pidieron.
  const rentMonthKey = getToday().slice(0, 7);
  const esNuevoDelMes = (r) => r.status !== 'finalizado' && !r.reviewSent && (r.startDate || '').slice(0, 7) === rentMonthKey;

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
        <div style={{ background: '#FFEBEE', border: '2px solid #EF5350', borderRadius: 10, padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#C62828', marginBottom: 4 }}>🔴 Vencen HOY ({expiringToday.length})</div>
          {expiringToday.map(r => (
            <div key={r.id} style={{ fontSize: 13, color: '#B71C1C', marginTop: 2 }}>
              • {getPatientName(r.patientId)} — {getEquipmentName(r.equipmentId)} — vence {formatDate(r.endDate)}
            </div>
          ))}
        </div>
      )}

      {expiringSoon.length > 0 && (
        <div style={{ background: '#FFF3E0', border: '2px solid #FFA726', borderRadius: 10, padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#E65100', marginBottom: 4 }}>🟠 Por vencer en 2 dias ({expiringSoon.length})</div>
          {expiringSoon.map(r => (
            <div key={r.id} style={{ fontSize: 13, color: '#BF360C', marginTop: 2 }}>
              • {getPatientName(r.patientId)} — {getEquipmentName(r.equipmentId)} — vence {formatDate(r.endDate)}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 12, marginBottom: 15 }}>
        <input type="text" className="form-input" placeholder="Buscar por paciente, equipo o dirección..." value={search} onChange={e => setSearch(e.target.value)} />
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
          📅 Normalizar Vencimientos
        </button>
      </div>

      {filteredRentals.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <div className="empty-title">Sin Alquileres</div>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
          <div style={{ overflowX: 'auto', width: '100%' }}>
            <table className="table">
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
                      <td>{getPatientName(rental.patientId)}</td>
                      <td>{getEquipmentName(rental.equipmentId)}</td>
                      <td>{formatDate(rental.startDate)}</td>
                      <td>{formatDate(rental.endDate)}</td>
                      <td>{formatCurrency(rental.price)}</td>
                      <td><span className={`badge badge-${status}`}>{status}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                          <button className="btn btn-sm btn-secondary" onClick={() => { setEditingRental(rental); setShowModal(true); }}>✏️</button>
                          <button className="btn btn-sm btn-danger" onClick={() => handleDelete(rental.id)}>🗑️</button>
                          {esNuevoDelMes(rental) && (
                            <button className="btn btn-sm btn-success" title="Pedir reseña en Google" onClick={() => handleReview(rental)}>⭐ Reseña</button>
                          )}
                          {status === 'vencido' && (
                            <button className="btn btn-sm" style={{ background: '#FB8C00', color: '#fff' }} title="Enviar recordatorio de vencimiento por WhatsApp" onClick={() => handleReminder(rental)}>📲 Recordatorio</button>
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
function alignDueDay(refDate, startDate) {
  if (!refDate || !startDate || !/^\d{4}-\d{2}-\d{2}$/.test(refDate) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return refDate;
  const [y, m] = refDate.split('-').map(Number);
  const startDay = Number(startDate.split('-')[2]);
  const maxDay = new Date(y, m, 0).getDate();
  const day = Math.min(startDay, maxDay);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Proximo vencimiento: el dia de INICIO, en el mes siguiente al vencimiento actual.
function nextDueAfter(refDate, startDate) {
  if (!refDate || !/^\d{4}-\d{2}-\d{2}$/.test(refDate)) return nextMonthDate(startDate);
  const [y, m] = refDate.split('-').map(Number);
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return alignDueDay(`${ny}-${String(nm).padStart(2, '0')}-01`, startDate || refDate);
}

// Vencimiento = un mes despues del inicio, avanzando mes a mes sucesivamente
// hasta el primer vencimiento que sea hoy o futuro. Asi los alquileres viejos
// quedan con el proximo vencimiento real (no uno pasado que marque todo vencido).
function rollingDueDate(start) {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return '';
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
  const D = rollingDueDate(rental.startDate);
  if (!D) return rental.endDate;
  const paidActual = isRentalPaidForMonth(rental, D.slice(0, 7));
  const tope = paidActual ? nextDueAfter(D, rental.startDate) : D;
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
    return [{ equipmentId: '', endDate: nextMonthDate(getToday()), price: '' }];
  });
  const [showNewPatient, setShowNewPatient] = useState(false);
  const [newPatient, setNewPatient] = useState({ name: '', phone: '', dni: '', address: '', observations: '' });

  const handleStartDateChange = (start) => {
    const prevDefault = nextMonthDate(form.startDate);
    const newDefault = nextMonthDate(start);
    // El vencimiento sigue a la fecha de inicio (1 mes despues). Editable luego a mano.
    setForm({ ...form, startDate: start, ...(isEditing ? { endDate: newDefault } : {}) });
    if (!isEditing) {
      setItems(items.map(it => ({ ...it, endDate: it.endDate === prevDefault || !it.endDate ? newDefault : it.endDate })));
    }
  };

  const updateItem = (idx, patch) => {
    setItems(items.map((it, i) => i === idx ? { ...it, ...patch } : it));
  };

  const addItem = () => {
    setItems([...items, { equipmentId: '', endDate: nextMonthDate(form.startDate), price: '' }]);
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
      const validExtra = items.filter(it => it.equipmentId);
      if (validExtra.length > 0) {
        const extraRentals = validExtra.map(it => ({
          patientId: form.patientId,
          equipmentId: it.equipmentId,
          startDate: form.startDate,
          endDate: it.endDate,
          price: Number(it.price),
          status: form.status || 'activo',
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
                {patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button type="button" className="btn" onClick={() => setShowNewPatient(!showNewPatient)}>➕</button>
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
                <label className="form-label">Fecha de fin</label>
                <input type="date" className="form-input" value={form.endDate} onChange={e => setForm({...form, endDate: e.target.value})} />
              </div>
              <div className="form-group">
                <label className="form-label">Precio mensual ($)</label>
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
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 110px auto', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                    <select className="form-select" value={it.equipmentId} onChange={e => updateItem(idx, { equipmentId: e.target.value })} required>
                      <option value="">Equipo...</option>
                      {options.map(e => <option key={e.id} value={e.id}>{e.name} ({e.serialNumber})</option>)}
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
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 110px auto', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                    <select className="form-select" value={it.equipmentId} onChange={e => updateItem(idx, { equipmentId: e.target.value })}>
                      <option value="">Equipo...</option>
                      {options.map(e => <option key={e.id} value={e.id}>{e.name} ({e.serialNumber})</option>)}
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
    const isNew = !equip.id;
    if (!confirm(isNew ? `¿Agregar el equipo "${equip.name}"?` : `¿Guardar los cambios del equipo "${equip.name}"?`)) return;
    updateData(cur => ({
      ...cur,
      equipment: isNew
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
            {f === 'disponible' ? '🟢 Disponible' : f === 'alquilado' ? '🔴 Alquilado' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <button className="btn btn-primary btn-block" onClick={() => { setEditingEquipment(null); setShowModal(true); }} style={{ marginBottom: 20 }}>
        + Agregar Equipo
      </button>

      {filteredEquipment.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔧</div>
          <div className="empty-title">Sin Equipos</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {filteredEquipment.map(equip => {
            const currentPatient = getCurrentPatient(equip.id);
            const isRented = !!currentPatient;
            return (
              <div key={equip.id} className="card" style={{ padding: 14, borderLeft: isRented ? '4px solid #E53935' : '4px solid #43A047' }}>
                <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                  {equip.imageUrl ? (
                    <img src={equip.imageUrl} alt={equip.name} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 48, height: 48, borderRadius: 6, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 22 }}>🔧</div>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div title={equip.name} style={{ fontWeight: 700, fontSize: 14, color: isRented ? '#E53935' : '#1a1a1a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'default' }}>{equip.name}</div>
                    <div style={{ fontSize: 12, color: '#666' }}>Serie: {equip.serialNumber}</div>
                  </div>
                </div>
                {isRented ? (
                  <div style={{ background: '#FFEBEE', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
                    <span style={{ color: '#E53935', fontWeight: 600, fontSize: 13 }}>Alquilado a: {currentPatient.name}</span>
                  </div>
                ) : (
                  <div style={{ background: '#E8F5E9', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
                    <span style={{ color: '#43A047', fontWeight: 600, fontSize: 13 }}>Disponible</span>
                  </div>
                )}
                {equip.rentalPrice > 0 && (
                  <div style={{ fontSize: 12, color: '#1E5AA8', fontWeight: 600, marginBottom: 6 }}>
                    Alquiler: {formatCurrency(equip.rentalPrice)}/mes
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => { setEditingEquipment({ ...equip, id: null, serialNumber: equip.serialNumber + '-COPY' }); setShowModal(true); }}>📋</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => { setEditingEquipment(equip); setShowModal(true); }}>✏️</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(equip.id)}>🗑️</button>
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
  const [form, setForm] = useState(equipment || { name: '', serialNumber: '', type: 'otro', status: 'disponible', description: '', available: true, imageUrl: '', ownership: 'propio', rentalPrice: '' });

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
        setForm(f => ({ ...f, imageUrl: canvas.toDataURL('image/jpeg', 0.75) }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name || !form.serialNumber) {
      alert('Nombre y serie son obligatorios');
      return;
    }
    onSave({ ...form, rentalPrice: Number(form.rentalPrice) || 0 });
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
          
          <div className="form-group">
            <label className="form-label">Número de serie *</label>
            <input type="text" className="form-input" value={form.serialNumber} onChange={e => setForm({...form, serialNumber: e.target.value})} required />
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

          <div className="form-group">
            <label className="form-label">Precio de alquiler mensual $</label>
            <input type="number" className="form-input" placeholder="0" min="0" value={form.rentalPrice || ''} onChange={e => setForm({...form, rentalPrice: e.target.value})} />
          </div>

          <div className="form-group">
            <label className="form-label">Ownership</label>
            <select className="form-select" value={form.ownership} onChange={e => setForm({...form, ownership: e.target.value})}>
              <option value="propio">🏠 Propio</option>
              <option value="alquilado">📋 Alquilado (tercero)</option>
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

  const handleSave = (item) => {
    if (!confirm(item.id ? `¿Guardar los cambios de "${item.name}"?` : `¿Agregar "${item.name}" al catalogo?`)) return;
    updateData(cur => ({
      ...cur,
      equiposNuevos: item.id
        ? (cur.equiposNuevos || []).map(e => e.id === item.id ? item : e)
        : [...(cur.equiposNuevos || []), { ...item, id: generateId() }]
    }));
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
        <div className="empty-state"><div className="empty-icon">🆕</div><div className="empty-title">Sin equipos nuevos</div></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {filtered.map(eq => (
            <div key={eq.id} className="card" style={{ padding: 14 }}>
              {eq.imageUrl && <img src={eq.imageUrl} alt={eq.name} style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 8, marginBottom: 10 }} />}
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{eq.name}</div>
              {eq.description && <div style={{ fontSize: 13, color: '#5A6978', marginBottom: 4 }}>{eq.description}</div>}
              <div style={{ fontSize: 18, fontWeight: 700, color: '#1E5AA8' }}>{formatCurrency(eq.price)}</div>
              {eq.priceUsd > 0 && <div style={{ fontSize: 13, color: '#43A047', fontWeight: 600 }}>USD {eq.priceUsd}</div>}
              {eq.priceVentaUsd > 0 && <div style={{ fontSize: 12, color: '#5A6978', marginBottom: 8 }}>Venta: USD {eq.priceVentaUsd}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-secondary" onClick={() => { setEditing(eq); setShowModal(true); }}>✏️</button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(eq.id)}>🗑️</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showModal && (() => {
        const EquipoNuevoModal = () => {
          const [form, setForm] = useState(editing || { name: '', description: '', price: '', priceUsd: '', priceVentaUsd: '', imageUrl: '' });
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
                setForm(f => ({ ...f, imageUrl: canvas.toDataURL('image/jpeg', 0.75) }));
              };
              img.src = r.result;
            };
            r.readAsDataURL(file);
          };
          return (
            <div className="modal-overlay" onClick={() => { setShowModal(false); setEditing(null); }}>
              <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h2 className="modal-title">{editing ? 'Editar' : 'Nuevo'} Equipo</h2>
                  <span className="modal-close" onClick={() => { setShowModal(false); setEditing(null); }}>x</span>
                </div>
                <form onSubmit={e => { e.preventDefault(); if (!form.name) { alert('Nombre obligatorio'); return; } handleSave({ ...form, price: Number(form.price), priceUsd: Number(form.priceUsd || 0), priceVentaUsd: Number(form.priceVentaUsd || 0) }); }}>
                  <div className="form-group"><label className="form-label">Nombre *</label><input type="text" className="form-input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required /></div>
                  <div className="form-group"><label className="form-label">Descripcion (Marca / Modelo)</label><textarea className="form-textarea" value={form.description} onChange={e => setForm({...form, description: e.target.value})} /></div>
                  <div className="form-group"><label className="form-label">Precio ARS</label><input type="number" className="form-input" value={form.price} onChange={e => setForm({...form, price: e.target.value})} /></div>
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
        <h1 className="page-title">😷 Mascarillas y Consumibles</h1>
        <p className="page-subtitle">{mascaras.length} productos</p>
      </div>

      <div className="search-box">
        <span>🔍</span>
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
          <div className="empty-icon">😷</div>
          <div className="empty-title">Sin Productos</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20 }}>
          {filteredMascaras.map(mascara => (
            <div key={mascara.id} className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ width: '100%', height: 200, background: '#f0f4f8', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {mascara.imageUrl ? (
                  <img src={mascara.imageUrl} alt={mascara.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: 64 }}>😷</span>
                )}
              </div>
              <div style={{ padding: '16px', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <strong style={{ fontSize: 16 }}>{mascara.name}</strong>
                  <div style={{ fontSize: 12, color: '#5A6978', marginTop: 2 }}>{mascara.type}</div>
                  {mascara.description && <div style={{ fontSize: 12, color: '#5A6978', marginTop: 4 }}>{mascara.description}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <button className="btn btn-sm" onClick={() => updateStock(mascara.id, -1)}>➖</button>
                  <span style={{
                    minWidth: 44,
                    textAlign: 'center',
                    color: mascara.stock <= mascara.minStock ? '#E53935' : '#43A047',
                    fontWeight: 'bold',
                    fontSize: 20
                  }}>
                    {mascara.stock}
                  </span>
                  <button className="btn btn-sm" onClick={() => updateStock(mascara.id, 1)}>➕</button>
                  <span style={{ fontSize: 11, color: '#9AA5B4', marginLeft: 4 }}>min: {mascara.minStock}</span>
                </div>
                {mascara.precio > 0 && (
                  <div style={{ fontSize: 13, color: '#1565C0', fontWeight: 'bold' }}>{formatCurrency(mascara.precio)}</div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 8 }}>
                  <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} onClick={() => { setEditingMascara(mascara); setShowModal(true); }}>✏️ Editar</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => handleDuplicate(mascara)}>📋</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(mascara.id)}>🗑️</button>
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

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setForm({ ...form, imageUrl: reader.result });
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
    { value: 'equipos', label: '🔧 Equipos' },
    { value: 'equiposNuevos', label: '🆕 Equipos Nuevos' },
    { value: 'mascarillas', label: '😷 Mascarillas' },
    { value: 'descartables', label: '🧤 Descartables' }
  ];

  const allProducts = [
    ...(equipment || []).map(e => ({ ...e, price: getEquipPrice(e), _cat: 'equipos', _label: 'Equipo' })),
    ...(equiposNuevos || []).map(e => ({ ...e, _cat: 'equiposNuevos', _label: 'Equipo Nuevo' })),
    ...(mascaras || []).map(m => ({ ...m, price: m.precio || m.price || 0, _cat: 'mascarillas', _label: 'Mascarilla' })),
    ...(descartables || []).map(d => ({ ...d, _cat: 'descartables', _label: 'Descartable' }))
  ];

  const filtered = allProducts.filter(p => {
    if (category !== 'todos' && p._cat !== category) return false;
    if (search && !(p.name || '').toLowerCase().includes(search.toLowerCase())) return false;
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
      items: cart.map(c => ({ name: c.name, price: c.price, quantity: c.quantity, imageUrl: c.imageUrl || '' })),
      total: cartTotal,
      notes,
      ...(isRemito ? { sigFirma, sigAclaracion, sigDni } : {})
    };
    try {
      const doc = await generateInvoicePDF(invoiceData, settings, docType);
      downloadInvoicePDF(doc, number, docType);
      const record = { id: generateId(), ...invoiceData, customerName, customerPhone, cartItems: cart, createdAt: getToday() };
      updateData(cur => ({ ...cur, [collectionKey]: [...(cur[collectionKey] || []), record] }));
      alert(`${isRemito ? 'Remito' : (isCotizacion ? 'Cotizacion' : 'Factura')} ${number} generado`);
      clearCart();
    } catch (err) {
      console.error(err);
      alert('Error al generar PDF');
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
        <h1 className="page-title">{isRemito ? '📝' : (isCotizacion ? '💰' : '🛒')} {title}</h1>
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
              <div style={{ fontSize: 11, color: '#5A6978' }}>{p._label}</div>
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
            {(patients || []).map(p => <option key={p.id} value={p.name} />)}
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
          <button className="btn btn-success" style={{ flex: 1 }} onClick={handlePDF}>📄 {isRemito ? 'Remito' : (isCotizacion ? 'Cotizacion' : 'Factura')} PDF</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleWhatsApp}>📱 WhatsApp</button>
          <button className="btn btn-danger" onClick={clearCart}>🗑️</button>
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
                <button className="btn btn-sm btn-secondary" onClick={() => handleEditSaved(s)}>✏️ Editar</button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDeleteSaved(s.id)}>🗑️</button>
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

          <h4 style={{ color: '#E53935', margin: '8px 0 4px' }}>🔴 Vencen este día ({selectedDayExpiring.length})</h4>
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

      <div className="card">
        <h3 className="card-title">💾 Backup y Restauración</h3>
        <p style={{ color: '#5A6978', marginBottom: 16 }}>Guardá una copia de todos tus datos o restaurá desde un backup anterior.</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleBackup}>
            ⬇️ Descargar Backup
          </button>
          <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
            ⬆️ Restaurar Backup
            <input type="file" accept=".json" onChange={handleRestore} style={{ display: 'none' }} />
          </label>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">📁 Importar desde Excel</h3>
        <p style={{ color: '#5A6978', marginBottom: 16 }}>Importa pacientes, equipos y alquileres desde un archivo Excel (.xlsx)</p>
        <input type="file" accept=".xlsx,.xls" onChange={handleImport} disabled={importing} />
        {importing && <p>Importando...</p>}
      </div>

      <div className="card">
        <h3 className="card-title">🔌 API de Vencimientos (Hermes)</h3>
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
              <button className="btn btn-primary" onClick={() => handleCopyApiUrl(apiUrl)}>📋 Copiar vencimientos</button>
              <button className="btn btn-primary" onClick={() => handleCopyApiUrl(apiUrlPrecios)}>📋 Copiar precios</button>
              <button className="btn btn-secondary" onClick={handleGenerateApiKey}>♻️ Regenerar clave</button>
            </div>
            <p style={{ color: '#9AA5B4', fontSize: 12, marginTop: 10 }}>
              Cualquiera con este enlace puede ver los vencimientos. Si se filtró, regenerá la clave y el enlace viejo deja de funcionar.
            </p>
          </>
        ) : (
          <button className="btn btn-primary" onClick={handleGenerateApiKey}>🔑 Generar clave API</button>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">🏥 Datos de la Empresa</h3>
        
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
        <h3 className="card-title">💰 Precios por Defecto</h3>
        
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
        <h3 className="card-title">📊 Estadísticas</h3>
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

      <button className="btn btn-danger btn-block" onClick={handleClear}>🗑️ Borrar Todos los Datos</button>
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
    { value: 'consumibles', label: '🧤 Consumibles' },
    { value: 'filtros', label: '🔍 Filtros' },
    { value: 'mascarillas', label: '😷 Mascarillas' },
    { value: 'tubuladuras', label: '🫁 Tubuladuras' },
    { value: 'cables', label: '🔌 Cables' },
    { value: 'otros', label: '📦 Otros' }
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
        <h1 className="page-title">🧤 Descartables</h1>
        <button className="btn btn-primary" onClick={() => { setForm(defaultItem); setShowForm(true); setEditing(null); }}>
          + Nuevo Producto
        </button>
      </div>

      {lowStockItems.length > 0 && (
        <div className="card" style={{ background: '#FFF3E0', border: '1px solid #FF9800', marginBottom: 20 }}>
          <h3 className="card-title">⚠️ Stock Bajo</h3>
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
                      <button className="btn btn-sm" onClick={() => handleEdit(item)}>✏️</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(item.id)}>🗑️</button>
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

function FacturacionPage({ data, updateData }) {
  return <SalesCartPage data={data} updateData={updateData} pageType="factura" />;
}

export default App;
