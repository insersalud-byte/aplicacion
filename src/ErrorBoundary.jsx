import { Component } from 'react';

// Si una pantalla falla al dibujarse (por ejemplo un dato viejo con formato raro), se muestra
// un aviso con un boton para volver al inicio en vez de dejar toda la app en blanco.
// Los datos no se tocan: se guardan en la base, no en la pantalla.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Error en pantalla:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 520, margin: '60px auto', padding: 20, fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
        <h2 style={{ color: '#0F2A5C' }}>Algo falló al mostrar esta pantalla</h2>
        <p style={{ color: '#5A6978' }}>Tus datos están a salvo en la base. Volvé al inicio y, si se repite, sacale una foto a este mensaje.</p>
        <p style={{ color: '#B91C1C', fontSize: 12, wordBreak: 'break-word' }}>{String(this.state.error?.message || this.state.error)}</p>
        <button type="button" onClick={() => { window.location.href = '/'; }} style={{ background: '#1E5AA8', color: '#fff', border: 0, borderRadius: 8, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' }}>
          Volver al inicio
        </button>
      </div>
    );
  }
}
