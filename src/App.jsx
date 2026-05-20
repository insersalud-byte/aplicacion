import { useState, useEffect } from 'react';
import { loadData, saveData, generateId, getToday, formatDate, formatCurrency, getDaysUntilEnd, parseExcelData, sendWhatsApp, generateInvoicePDF, downloadInvoicePDF, sendInvoiceByEmail } from './data/database';
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

function App() {
  const [currentPage, setCurrentPage] = useState('home');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const initializeData = async () => {
      const loaded = await loadData();
      if (!active) return;
      setData(loaded);
      setLoading(false);
    };

    initializeData();

    return () => {
      active = false;
    };
  }, []);

  const updateData = (updater) => {
    setData(currentData => {
      const nextData = typeof updater === 'function' ? updater(currentData) : updater;
      void saveData(nextData);
      return nextData;
    });
  };

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
        
        <div className={`nav-item ${currentPage === 'quotations' ? 'active' : ''}`} onClick={() => setCurrentPage('quotations')}>
          <span className="nav-icon">💰</span>
          <span className="nav-label">Cotizaciones</span>
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

  // Actualizar automáticamente status de alquileres vencidos
  useEffect(() => {
    const expiredRentalsToUpdate = rentals.filter(r => 
      r.status === 'activo' && r.endDate && new Date(r.endDate) < new Date(today)
    );
    
    if (expiredRentalsToUpdate.length > 0) {
      updateData(currentData => ({
        ...currentData,
        rentals: currentData.rentals.map(rental => {
          const isExpired = rental.status === 'activo' && rental.endDate && new Date(rental.endDate) < new Date(today);
          return isExpired ? { ...rental, status: 'vencido' } : rental;
        })
      }));
    }
  }, [rentals, today, updateData]);
  
  const activeRentals = rentals.filter(r => r.status === 'activo');
  const expiringRentals = rentals.filter(r => {
    if (r.status !== 'activo' || !r.endDate) return false;
    const today = getToday();
    return r.endDate >= today && r.endDate.substring(0, 7) === today.substring(0, 7);
  });
  const expiredRentals = rentals.filter(r => (r.status === 'activo' || r.status === 'vencido') && r.endDate && new Date(r.endDate) < new Date(today));
  const availableEquipment = equipment.filter(e => e.available);
  const monthlyRentals = rentals.filter(rental => isRentalInMonth(rental, currentMonthKey));
  const monthlyTotal = monthlyRentals.reduce((sum, rental) => sum + Number(rental.price || 0), 0);
  const monthlyCollected = monthlyRentals.reduce((sum, rental) => (
    isRentalPaidForMonth(rental, currentMonthKey) ? sum + Number(rental.price || 0) : sum
  ), 0);
  const monthlyPending = monthlyTotal - monthlyCollected;

  const handleToggleMonthlyPayment = (rentalId) => {
    updateData(currentData => ({
      ...currentData,
      rentals: currentData.rentals.map(rental => {
        if (rental.id !== rentalId) return rental;

        const paid = !isRentalPaidForMonth(rental, currentMonthKey);
        return {
          ...rental,
          paymentStatusByMonth: {
            ...(rental.paymentStatusByMonth || {}),
            [currentMonthKey]: {
              paid,
              updatedAt: new Date().toISOString()
            }
          }
        };
      })
    }));
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Inser Salud</h1>
        <p className="page-subtitle">Gestión de Equipos Respiratorios</p>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">📋</div>
          <div className="stat-value">{activeRentals.length}</div>
          <div className="stat-label">Alquileres Activos</div>
        </div>
        <div className="stat-card warning">
          <div className="stat-icon">⚠️</div>
          <div className="stat-value">{expiringRentals.length}</div>
          <div className="stat-label">Por Vencer</div>
        </div>
        <div className="stat-card error">
          <div className="stat-icon">❌</div>
          <div className="stat-value">{expiredRentals.length}</div>
          <div className="stat-label">Vencidos</div>
        </div>
        <div className="stat-card success">
          <div className="stat-icon">✓</div>
          <div className="stat-value">{availableEquipment.length}</div>
          <div className="stat-label">Equipos Disponibles</div>
        </div>
      </div>

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
  const { patients, equipment, rentals } = data;
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null);

  const filteredPatients = patients.filter(p => 
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.dni.includes(search) ||
    p.phone.includes(search)
  );

  const handleSave = (patient) => {
    const newPatients = editingPatient 
      ? patients.map(p => p.id === patient.id ? patient : p)
      : [...patients, { ...patient, id: generateId(), createdAt: getToday() }];
    updateData({ ...data, patients: newPatients });
    setShowModal(false);
    setEditingPatient(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar paciente?')) {
      const newPatients = patients.filter(p => p.id !== id);
      updateData({ ...data, patients: newPatients });
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
  const getEquipmentName = (id) => equipment.find(e => e.id === id)?.name || '-';

  const filteredRentals = rentals.filter(r => {
    if (filter === 'activo' && r.status !== 'activo') return false;
    if (filter === 'vencido' && r.status !== 'vencido' && !(r.endDate && new Date(r.endDate) < new Date())) return false;
    if (filter === 'finalizado' && r.status !== 'finalizado') return false;
    if (search) {
      const q = search.toLowerCase();
      const pName = getPatientName(r.patientId).toLowerCase();
      const eName = getEquipmentName(r.equipmentId).toLowerCase();
      if (!pName.includes(q) && !eName.includes(q)) return false;
    }
    return true;
  });

  const handleSave = (payload) => {
    let newRentals;
    if (editingRental) {
      newRentals = rentals.map(r => r.id === payload.id ? payload : r);
    } else if (Array.isArray(payload)) {
      const createdAt = getToday();
      newRentals = [...rentals, ...payload.map(r => ({ ...r, id: generateId(), createdAt }))];
    } else {
      newRentals = [...rentals, { ...payload, id: generateId(), createdAt: getToday() }];
    }
    updateData(currentData => ({ ...currentData, rentals: newRentals }));
    setShowModal(false);
    setEditingRental(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar alquiler?')) {
      const newRentals = rentals.filter(r => r.id !== id);
      updateData(currentData => ({ ...currentData, rentals: newRentals }));
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Alquileres</h1>
        <p className="page-subtitle">{rentals.length} alquileres registrados</p>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 15 }}>
        <input type="text" className="form-input" placeholder="Buscar por paciente o equipo..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="filters">
        {['todos', 'activo', 'vencido', 'finalizado'].map(f => (
          <button key={f} className={`filter-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <button className="btn btn-primary btn-block" onClick={() => { setEditingRental(null); setShowModal(true); }} style={{ marginBottom: 20 }}>
        + Agregar Alquiler
      </button>

      {filteredRentals.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <div className="empty-title">Sin Alquileres</div>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
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
                  const isVencido = rental.endDate && new Date(rental.endDate) < new Date();
                  const status = isVencido ? 'vencido' : rental.status;
                  return (
                    <tr key={rental.id}>
                      <td>{getPatientName(rental.patientId)}</td>
                      <td>{getEquipmentName(rental.equipmentId)}</td>
                      <td>{formatDate(rental.startDate)}</td>
                      <td>{formatDate(rental.endDate)}</td>
                      <td>{formatCurrency(rental.price)}</td>
                      <td><span className={`badge badge-${status}`}>{status}</span></td>
                      <td>
                        <button className="btn btn-sm btn-secondary" onClick={() => { setEditingRental(rental); setShowModal(true); }}>✏️</button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(rental.id)}>🗑️</button>
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
          onSave={handleSave} 
          onAddPatient={(patient) => {
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

function RentalModal({ rental, patients, equipment, onSave, onAddPatient, onClose }) {
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
    setForm({ ...form, startDate: start, ...(isEditing ? { endDate: form.endDate === prevDefault ? newDefault : form.endDate } : {}) });
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
      onSave({ ...form, price: Number(form.price) });
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

  const handleAddNewPatient = () => {
    if (!newPatient.name) {
      alert('Ingrese nombre del paciente');
      return;
    }
    const patient = onAddPatient(newPatient);
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
                <label className="form-label">Equipo *</label>
                <select className="form-select" value={form.equipmentId} onChange={e => setForm({...form, equipmentId: e.target.value})} required>
                  <option value="">Seleccionar...</option>
                  {equipment.map(e => <option key={e.id} value={e.id}>{e.name} ({e.serialNumber})</option>)}
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
                const options = equipment.filter(e => !usedIds.includes(e.id));
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

  const getCurrentRental = (equipId) => {
    return rentals.find(r => r.equipmentId === equipId && (r.status === 'activo' || new Date(r.endDate) >= new Date()));
  };

  const getCurrentPatient = (equipId) => {
    const rental = getCurrentRental(equipId);
    return rental ? patients.find(p => p.id === rental.patientId) : null;
  };

  const filteredEquipment = equipment.filter(e => {
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
    const newEquipment = isNew
      ? [...equipment, { ...equip, id: generateId() }]
      : equipment.map(e => e.id === equip.id ? equip : e);
    updateData({ ...data, equipment: newEquipment });
    setShowModal(false);
    setEditingEquipment(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar equipo?')) {
      const newEquipment = equipment.filter(e => e.id !== id);
      updateData({ ...data, equipment: newEquipment });
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
                    <div style={{ fontWeight: 700, fontSize: 14, color: isRented ? '#E53935' : '#1a1a1a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{equip.name}</div>
                    <div style={{ fontSize: 12, color: '#666' }}>Serie: {equip.serialNumber}</div>
                    {equip.type && <div style={{ fontSize: 11, color: '#999' }}>{equip.type} {equip.ownership === 'propio' ? '| Propio' : '| Tercero'}</div>}
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
  const [form, setForm] = useState(equipment || { name: '', serialNumber: '', type: 'otro', status: 'disponible', description: '', available: true, imageUrl: '', ownership: 'propio' });

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
    if (!form.name || !form.serialNumber) {
      alert('Nombre y serie son obligatorios');
      return;
    }
    onSave(form);
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

function MascarasPage({ data, updateData }) {
  const { mascaras } = data;
  const [filter, setFilter] = useState('todos');
  const [showModal, setShowModal] = useState(false);
  const [editingMascara, setEditingMascara] = useState(null);

  const filteredMascaras = mascaras.filter(m => {
    if (filter === 'todos') return true;
    if (filter === 'stock') return m.stock > 0;
    return m.stock <= m.minStock;
  });

  const handleSave = (mascara) => {
    const isNew = !mascara.id;
    const newMascaras = isNew
      ? [...mascaras, { ...mascara, id: generateId() }]
      : mascaras.map(m => m.id === mascara.id ? mascara : m);
    updateData({ ...data, mascaras: newMascaras });
    setShowModal(false);
    setEditingMascara(null);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar?')) {
      const newMascaras = mascaras.filter(m => m.id !== id);
      updateData({ ...data, mascaras: newMascaras });
    }
  };

  const updateStock = (id, delta) => {
    const newMascaras = mascaras.map(m => 
      m.id === id ? { ...m, stock: Math.max(0, m.stock + delta) } : m
    );
    updateData({ ...data, mascaras: newMascaras });
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

function QuotationsPage({ data, updateData }) {
  const { quotations, equipment, mascaras, settings } = data;
  const [showModal, setShowModal] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState(null);

  const handleSave = (quotation) => {
    const newQuotations = editingQuotation
      ? quotations.map(q => q.id === quotation.id ? quotation : q)
      : [...quotations, { ...quotation, id: generateId(), createdAt: getToday() }];
    updateData({ ...data, quotations: newQuotations });
    setShowModal(false);
    setEditingQuotation(null);
  };

  const handleSend = (quotation) => {
    let message = `*COTIZACIÓN*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `*Equipo:* ${quotation.equipment?.name || 'Equipo'}\n`;
    if (quotation.equipment?.description) {
      message += `*Descripción:* ${quotation.equipment.description}\n`;
    }
    message += `*Tipo:* ${quotation.type}\n`;
    message += `*Precio:* ${formatCurrency(quotation.price)}${quotation.type === 'alquiler' ? '/mes' : ''}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `*Cliente:* ${quotation.customerName}\n`;
    if (quotation.customerPhone) message += `*Tel:* ${quotation.customerPhone}\n`;
    message += `\n📞 ${settings.companyPhone}\n`;
    if (settings.companyAddress) message += `${settings.companyAddress}\n`;
    
    sendWhatsApp(quotation.customerPhone, message);
  };

  const handleDelete = (id) => {
    if (confirm('¿Eliminar cotización?')) {
      const newQuotations = quotations.filter(q => q.id !== id);
      updateData({ ...data, quotations: newQuotations });
    }
  };

  const handleDownloadPDF = async (quote) => {
    const number = `COT-${(quote.id || Date.now()).toString(36).toUpperCase()}`;
    const invoiceData = {
      invoiceNumber: number,
      date: quote.createdAt || getToday(),
      clientName: quote.customerName,
      clientPhone: quote.customerPhone || '',
      items: [{
        name: `${quote.equipment?.name || 'Producto'} (${quote.type})`,
        price: Number(quote.price) || 0,
        quantity: 1
      }],
      total: Number(quote.price) || 0,
      notes: quote.notes || ''
    };
    try {
      const doc = await generateInvoicePDF(invoiceData, settings, 'cotizacion');
      downloadInvoicePDF(doc, number, 'cotizacion');
    } catch (err) {
      console.error(err);
      alert('Error al generar PDF');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Cotizaciones</h1>
        <p className="page-subtitle">{quotations.length} cotizaciones</p>
      </div>

      <button className="btn btn-primary btn-block" onClick={() => { setEditingQuotation(null); setShowModal(true); }} style={{ marginBottom: 20 }}>
        + Nueva Cotización
      </button>

      {quotations.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">💰</div>
          <div className="empty-title">Sin Cotizaciones</div>
        </div>
      ) : (
        quotations.map(quote => (
          <div key={quote.id} className="card">
            <div style={{ display: 'flex', gap: 16 }}>
              {quote.equipment?.imageUrl && (
                <img 
                  src={quote.equipment.imageUrl} 
                  alt={quote.equipment?.name} 
                  style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }} 
                />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{quote.customerName}</div>
                    <div style={{ color: '#5A6978', marginBottom: 4 }}>{quote.equipment?.name}</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#1E5AA8' }}>
                      {formatCurrency(quote.price)} {quote.type === 'alquiler' ? '/mes' : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`badge badge-${quote.type === 'alquiler' ? 'active' : 'finalizado'}`}>{quote.type}</span>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#8896A7' }}>{formatDate(quote.createdAt)}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button className="btn btn-success btn-sm" onClick={() => handleSend(quote)}>📱 WhatsApp</button>
                  <button className="btn btn-primary btn-sm" onClick={() => handleDownloadPDF(quote)}>📄 PDF</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditingQuotation(quote); setShowModal(true); }}>✏️</button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(quote.id)}>🗑️</button>
                </div>
              </div>
            </div>
          </div>
        ))
      )}

      {showModal && (
        <QuotationModal quotation={editingQuotation} equipment={equipment} mascaras={mascaras || []} onSave={handleSave} onClose={() => { setShowModal(false); setEditingQuotation(null); }} />
      )}
    </div>
  );
}

function QuotationModal({ quotation, equipment, mascaras, onSave, onClose }) {
  const [form, setForm] = useState(quotation || {
    customerName: '', customerPhone: '', equipmentId: '', type: 'alquiler', price: '', period: '', notes: ''
  });

  const allItems = [
    ...(equipment || []).map(e => ({ ...e, _kind: 'equipo' })),
    ...(mascaras || []).map(m => ({ ...m, _kind: 'mascarilla' }))
  ];

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.customerName || !form.equipmentId) {
      alert('Completa los campos obligatorios');
      return;
    }
    const item = allItems.find(i => i.id === form.equipmentId);
    onSave({ ...form, equipment: item, price: Number(form.price) });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{quotation ? 'Editar' : 'Nueva'} Cotización</h2>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Cliente *</label>
            <input type="text" className="form-input" value={form.customerName} onChange={e => setForm({...form, customerName: e.target.value})} required />
          </div>
          
          <div className="form-group">
            <label className="form-label">Teléfono</label>
            <input type="tel" className="form-input" value={form.customerPhone} onChange={e => setForm({...form, customerPhone: e.target.value})} />
          </div>
          
          <div className="form-group">
            <label className="form-label">Producto *</label>
            <select className="form-select" value={form.equipmentId} onChange={e => setForm({...form, equipmentId: e.target.value})} required>
              <option value="">Seleccionar...</option>
              {equipment.length > 0 && (
                <optgroup label="🔧 Equipos">
                  {equipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </optgroup>
              )}
              {mascaras.length > 0 && (
                <optgroup label="😷 Mascarillas">
                  {mascaras.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </optgroup>
              )}
            </select>
            {form.equipmentId && (() => {
              const item = allItems.find(i => i.id === form.equipmentId);
              return item ? (
                <div style={{ marginTop: 10 }}>
                  {item.imageUrl && (
                    <img src={item.imageUrl} alt={item.name} style={{ maxWidth: '100%', maxHeight: 150, borderRadius: 8, marginBottom: 8 }} />
                  )}
                  {item.description && <p style={{ fontSize: 13, color: '#5A6978' }}>{item.description}</p>}
                </div>
              ) : null;
            })()}
          </div>
          
          <div className="form-group">
            <label className="form-label">Tipo</label>
            <select className="form-select" value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
              <option value="alquiler">Alquiler</option>
              <option value="venta">Venta</option>
            </select>
          </div>
          
          <div className="form-group">
            <label className="form-label">Precio</label>
            <input type="number" className="form-input" value={form.price} onChange={e => setForm({...form, price: e.target.value})} />
          </div>
          
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
    const dateStr = date.toISOString().split('T')[0];
    return rentals.filter(r => {
      const start = r.startDate?.split('T')[0];
      const end = r.endDate?.split('T')[0];
      return dateStr >= start && dateStr <= end;
    });
  };

  const days = getDaysInMonth(currentDate);
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));

  const selectedDayRentals = selectedDate ? getRentalsForDay(selectedDate) : [];

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
            const rentalsForDay = getRentalsForDay(date);
            const isToday = date && date.toDateString() === new Date().toDateString();
            const isSelected = date && selectedDate && date.toDateString() === selectedDate.toDateString();
            
            return (
              <div 
                key={i} 
                className={`calendar-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${rentalsForDay.length > 0 ? 'has-event' : ''}`}
                onClick={() => date && setSelectedDate(date)}
              >
                {date?.getDate()}
              </div>
            );
          })}
        </div>
      </div>

      {selectedDate && (
        <div className="card">
          <h3 className="card-title">{selectedDate.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
          
          {selectedDayRentals.length === 0 ? (
            <p style={{ color: '#5A6978' }}>No hay alquileres en esta fecha</p>
          ) : (
            selectedDayRentals.map(rental => {
              const patient = patients.find(p => p.id === rental.patientId);
              const equip = equipment.find(e => e.id === rental.equipmentId);
              return (
                <div key={rental.id} className="patient-card" style={{ marginTop: 12 }}>
                  <div className="patient-info">
                    <div className="patient-name">{patient?.name}</div>
                    <div className="patient-detail">{equip?.name}</div>
                  </div>
                  <span className={`badge badge-${rental.status}`}>{rental.status}</span>
                </div>
              );
            })
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
    updateData({ ...data, settings: form });
    alert('Configuración guardada');
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
          
          const allPatients = [...patients, ...newPatients];
          const allEquipment = [...equipment, ...newEquipment];
          const allRentals = [...rentals, ...newRentals];
          
          updateData({ ...data, patients: allPatients, equipment: allEquipment, rentals: allRentals });
          
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

    let newDescartables;
    if (editing) {
      newDescartables = descartables.map(d => d.id === editing ? newItem : d);
    } else {
      newDescartables = [...descartables, newItem];
    }

    updateData({ ...data, descartables: newDescartables });
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
      updateData({ ...data, descartables: descartables.filter(d => d.id !== id) });
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
  const { descartables, mascaras, patients, settings } = data;
  const [cart, setCart] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('todos');
  const [notes, setNotes] = useState('');
  const [showPatientForm, setShowPatientForm] = useState(false);
  const [newPatient, setNewPatient] = useState({ name: '', phone: '', dni: '', address: '' });
  const [showLibreForm, setShowLibreForm] = useState(false);
  const [libreItem, setLibreItem] = useState({ name: '', price: 0, quantity: 1 });
  const [editingItem, setEditingItem] = useState(null);

  const categories = [
    { value: 'todos', label: 'Todas' },
    { value: 'consumibles', label: '🧤 Consumibles' },
    { value: 'filtros', label: '🔍 Filtros' },
    { value: 'mascarillas', label: '😷 Mascarillas' },
    { value: 'tubuladuras', label: '🫁 Tubuladuras' },
    { value: 'cables', label: '🔌 Cables' },
    { value: 'otros', label: '📦 Otros' }
  ];

  const mascarasAsProducts = (mascaras || []).map(m => ({
    ...m,
    category: 'mascarillas',
    price: m.precio || 0
  }));
  const allProducts = [...descartables, ...mascarasAsProducts];

  const filteredProducts = allProducts.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = categoryFilter === 'todos' || item.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const addToCart = (product) => {
    const existing = cart.find(item => item.id === product.id);
    if (existing) {
      setCart(cart.map(item => 
        item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
      ));
    } else {
      setCart([...cart, { ...product, quantity: 1 }]);
    }
  };

  const updateQuantity = (id, quantity) => {
    if (quantity <= 0) {
      setCart(cart.filter(item => item.id !== id));
    } else {
      setCart(cart.map(item => 
        item.id === id ? { ...item, quantity } : item
      ));
    }
  };

  const addLibreItem = () => {
    if (!libreItem.name || libreItem.price <= 0) {
      alert('Ingrese nombre y precio');
      return;
    }
    const newItem = {
      id: 'libre-' + Date.now(),
      name: libreItem.name,
      price: libreItem.price,
      quantity: libreItem.quantity,
      isLibre: true
    };
    setCart([...cart, newItem]);
    setLibreItem({ name: '', price: 0, quantity: 1 });
    setShowLibreForm(false);
  };

  const updateCartItem = (id, field, value) => {
    setCart(cart.map(item => 
      item.id === id ? { ...item, [field]: value } : item
    ));
  };

  const removeFromCart = (id) => {
    setCart(cart.filter(item => item.id !== id));
  };

  const clearCart = () => {
    setCart([]);
    setNotes('');
    setSelectedPatient('');
  };

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const selectedPatientData = patients.find(p => p.id === selectedPatient);

  const generateInvoice = () => {
    const invoiceNumber = `FAC-${Date.now().toString(36).toUpperCase()}`;
    const date = getToday();
    
    let message = `*${settings.companyName || 'Inser Salud'}*\n`;
    message += `📋 *FACTURA PROFORMA*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `N°: ${invoiceNumber}\n`;
    message += `Fecha: ${formatDate(date)}\n`;
    
    if (selectedPatientData) {
      message += `\n*Cliente:*\n${selectedPatientData.name}\n`;
      if (selectedPatientData.phone) message += `Tel: ${selectedPatientData.phone}\n`;
      if (selectedPatientData.address) message += `Dir: ${selectedPatientData.address}\n`;
    }
    
    message += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `*DETALLE:*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    
    cart.forEach(item => {
      const subtotal = item.price * item.quantity;
      message += `• ${item.name}\n`;
      message += `  ${item.quantity} x ${formatCurrency(item.price)} = ${formatCurrency(subtotal)}\n`;
    });
    
    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `*SUBTOTAL:* ${formatCurrency(cartTotal)}\n`;
    message += `*TOTAL:* ${formatCurrency(cartTotal)}\n`;
    
    if (notes) {
      message += `\n*Observaciones:*\n${notes}\n`;
    }
    
    message += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `Gracias por su confianza!\n`;
    if (settings.companyPhone) message += `Tel: ${settings.companyPhone}\n`;
    if (settings.companyAddress) message += `${settings.companyAddress}\n`;
    
    return message;
  };

  const sendViaWhatsApp = () => {
    if (cart.length === 0) {
      alert('Agregue productos al carrito');
      return;
    }
    
    let phone = selectedPatientData?.phone || '';
    if (!phone && !selectedPatient) {
      alert('Seleccione un paciente o ingrese un teléfono');
      return;
    }
    
    const message = generateInvoice();
    
    if (!phone && selectedPatient) {
      phone = prompt('Ingrese número de WhatsApp:', '+54');
    }
    
    if (phone) {
      sendWhatsApp(phone, message);
    }
  };

  const saveInvoice = async () => {
    if (cart.length === 0) {
      alert('Agregue productos al carrito');
      return;
    }
    
    if (!selectedPatient) {
      alert('Seleccione un paciente');
      return;
    }

    const invoiceNumber = `FAC-${Date.now().toString(36).toUpperCase()}`;
    const invoiceData = {
      id: generateId(),
      invoiceNumber,
      date: getToday(),
      patientId: selectedPatient,
      clientName: selectedPatientData?.name || 'Cliente',
      clientPhone: selectedPatientData?.phone || '',
      clientAddress: selectedPatientData?.address || '',
      items: cart,
      total: cartTotal,
      notes,
      status: 'generada',
      createdAt: getToday()
    };

    try {
      const doc = await generateInvoicePDF(invoiceData, settings, 'factura');

      const newInvoices = [...(data.invoices || []), invoiceData];
      updateData({ ...data, invoices: newInvoices });

      downloadInvoicePDF(doc, invoiceNumber, 'factura');

      alert(`Factura ${invoiceNumber} generada y guardada`);
      clearCart();
    } catch (error) {
      console.error('Error generando PDF:', error);
      alert('Error al generar la factura');
    }
  };

  const sendInvoiceEmail = () => {
    if (cart.length === 0) {
      alert('Agregue productos al carrito');
      return;
    }
    
    if (!selectedPatient) {
      alert('Seleccione un paciente');
      return;
    }

    const invoiceNumber = `FAC-${Date.now().toString(36).toUpperCase()}`;
    const email = selectedPatientData?.email || prompt('Ingrese correo electrónico:', '');
    
    if (email) {
      sendInvoiceByEmail(email, invoiceNumber, selectedPatientData?.name, formatCurrency(cartTotal));
    }
  };

  const handleAddNewPatient = () => {
    if (!newPatient.name) {
      alert('Ingrese nombre del paciente');
      return;
    }
    const patient = {
      id: generateId(),
      ...newPatient,
      createdAt: getToday()
    };
    updateData({ ...data, patients: [...patients, patient] });
    setSelectedPatient(patient.id);
    setShowPatientForm(false);
    setNewPatient({ name: '', phone: '', dni: '', address: '' });
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">🛒 Facturación</h1>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="card" style={{ width: '100%' }}>
          
          <div style={{ display: 'flex', gap: 10, marginBottom: 15 }}>
            <input
              type="text"
              className="form-input"
              placeholder="Buscar producto..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <select 
              className="form-input" 
              value={categoryFilter} 
              onChange={e => setCategoryFilter(e.target.value)}
              style={{ width: 'auto' }}
            >
              {categories.map(cat => (
                <option key={cat.value} value={cat.value}>{cat.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {filteredProducts.map(product => (
              <div key={product.id} style={styles.productCard}>
                <div style={{ fontWeight: 'bold', marginBottom: 5 }}>{product.name}</div>
                <div style={{ fontSize: 12, color: '#5A6978', marginBottom: 5 }}>
                  {categories.find(c => c.value === product.category)?.label || product.category}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#1E5AA8', fontWeight: 'bold' }}>{formatCurrency(product.price)}</span>
                  <span style={{ fontSize: 12, color: product.stock <= product.minStock ? '#E53935' : '#43A047' }}>
                    Stock: {product.stock}
                  </span>
                </div>
                <button 
                  className="btn btn-primary btn-sm" 
                  style={{ width: '100%', marginTop: 10 }}
                  onClick={() => addToCart(product)}
                  disabled={product.stock === 0}
                >
                  + Agregar
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ width: '100%' }}>
          
          <div style={{ background: '#FFF8E1', border: '1px solid #FFC107', borderRadius: 8, padding: 10, marginBottom: 15 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 'bold' }}>📝 Item Libre</span>
              <button className="btn btn-sm" onClick={() => setShowLibreForm(!showLibreForm)}>
                {showLibreForm ? '➖' : '➕'}
              </button>
            </div>

            {showLibreForm && (
              <div>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Nombre del producto"
                  value={libreItem.name}
                  onChange={e => setLibreItem({...libreItem, name: e.target.value})}
                  style={{ marginBottom: 6 }}
                />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <input 
                    type="number" 
                    className="form-input" 
                    placeholder="Precio $"
                    value={libreItem.price || ''}
                    onChange={e => setLibreItem({...libreItem, price: Number(e.target.value)})}
                  />
                  <input 
                    type="number" 
                    className="form-input" 
                    placeholder="Cantidad"
                    value={libreItem.quantity}
                    onChange={e => setLibreItem({...libreItem, quantity: Number(e.target.value)})}
                  />
                </div>
                <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={addLibreItem}>
                  Agregar al Carrito
                </button>
              </div>
            )}
          </div>

          <h3 className="card-title">🛒 Carrito</h3>

            <div className="form-group">
              <label className="form-label">Paciente</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <select 
                  className="form-input" 
                  value={selectedPatient} 
                  onChange={e => setSelectedPatient(e.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">Seleccionar paciente...</option>
                  {patients.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button className="btn" onClick={() => setShowPatientForm(!showPatientForm)}>➕</button>
              </div>
            </div>

            {showPatientForm && (
              <div style={{ background: '#F5F5F5', padding: 10, borderRadius: 8, marginBottom: 10 }}>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Nombre"
                  value={newPatient.name}
                  onChange={e => setNewPatient({...newPatient, name: e.target.value})}
                  style={{ marginBottom: 5 }}
                />
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Teléfono"
                  value={newPatient.phone}
                  onChange={e => setNewPatient({...newPatient, phone: e.target.value})}
                  style={{ marginBottom: 5 }}
                />
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Dirección"
                  value={newPatient.address}
                  onChange={e => setNewPatient({...newPatient, address: e.target.value})}
                  style={{ marginBottom: 5 }}
                />
                <button className="btn btn-primary btn-sm" onClick={handleAddNewPatient}>
                  Agregar Paciente
                </button>
              </div>
            )}

            {selectedPatientData && (
              <div style={{ background: '#E3F2FD', padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 13 }}>
                <strong>{selectedPatientData.name}</strong><br/>
                {selectedPatientData.phone && <span>📞 {selectedPatientData.phone}</span>}
                {selectedPatientData.address && <><br/><span>📍 {selectedPatientData.address}</span></>}
              </div>
            )}

            <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 10 }}>
              {cart.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#5A6978' }}>Carrito vacío</p>
              ) : (
                cart.map(item => (
                  <div key={item.id} style={styles.cartItem}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <input 
                        type="text" 
                        style={{ 
                          width: '100%', 
                          fontWeight: 'bold', 
                          border: '1px solid #E3F2FD',
                          borderRadius: 4,
                          padding: '4px 8px',
                          marginBottom: 4
                        }}
                        value={item.name}
                        onChange={e => updateCartItem(item.id, 'name', e.target.value)}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, color: '#5A6978' }}>$</span>
                        <input 
                          type="number" 
                          style={{ 
                            width: 70, 
                            fontSize: 12,
                            border: '1px solid #E3F2FD',
                            borderRadius: 4,
                            padding: '2px 4px'
                          }}
                          value={item.price}
                          onChange={e => updateCartItem(item.id, 'price', Number(e.target.value))}
                        />
                        <span style={{ fontSize: 12, color: '#5A6978' }}>x</span>
                        <input 
                          type="number" 
                          style={{ 
                            width: 50, 
                            fontSize: 12,
                            border: '1px solid #E3F2FD',
                            borderRadius: 4,
                            padding: '2px 4px'
                          }}
                          value={item.quantity}
                          onChange={e => updateCartItem(item.id, 'quantity', Number(e.target.value))}
                        />
                        <span style={{ fontWeight: 'bold', color: '#1E5AA8', fontSize: 13 }}>
                          = {formatCurrency(item.price * item.quantity)}
                        </span>
                      </div>
                    </div>
                    <button className="btn btn-sm btn-danger" onClick={() => removeFromCart(item.id)}>🗑️</button>
                  </div>
                ))
              )}
            </div>

            <div style={{ borderTop: '2px solid #E3F2FD', paddingTop: 10, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 'bold' }}>
                <span>Total:</span>
                <span style={{ color: '#1E5AA8' }}>{formatCurrency(cartTotal)}</span>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Observaciones</label>
              <textarea 
                className="form-input" 
                rows={2}
                placeholder="Notas adicionales..."
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-success" style={{ flex: 1 }} onClick={saveInvoice}>
                📄 Generar & Descargar PDF
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={sendViaWhatsApp}>
                📱 WhatsApp
              </button>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={sendInvoiceEmail}>
                ✉️ Enviar por Mail
              </button>
              <button className="btn btn-danger" onClick={clearCart}>🗑️</button>
            </div>
          </div>
        </div>
      </div>
  );
}

const styles = {
  productCard: {
    border: '1px solid #E3F2FD',
    borderRadius: 8,
    padding: 12,
    background: '#FAFDFF'
  },
  cartItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid #E3F2FD'
  }
};

export default App;
