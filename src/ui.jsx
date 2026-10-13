// Piezas visuales compartidas: iconos de linea (reemplazan a los emojis) y
// fotos de equipos por categoria (fotos propias del catalogo de inser.ar,
// achicadas y servidas desde /public: no consumen egress de Supabase).
import { useState } from 'react';

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  clipboard: 'M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 12h8M8 16h5',
  device: 'M4 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2M6 11h5M6 14h3M16.5 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  mask: 'M3 9.5C5.5 7.2 8.6 6 12 6s6.5 1.2 9 3.5c0 5.8-4 10.5-9 10.5S3 15.3 3 9.5M8.5 12.5h7M9.5 15.5h5',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8M7.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M3 10h18M8 3v4M16 3v4',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  cart: 'M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2M18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2M2 3h3l2.6 12.4a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 7H6',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M18 6 6 18M6 6l12 12',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
  alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 8v4M12 16h.01',
  cash: 'M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9v.01M18 15v.01',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8 12l3 3 5-6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2',
  whatsapp: 'M3 21l1.7-5A8.5 8.5 0 1 1 8 19.3zM9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1c-1-.5-1.5-1-2-2l1-1-1-2z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z',
  stop: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9 9h6v6H9z',
  doc: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 15l2 2 4-4',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  key: 'M15.5 7.5a1 1 0 1 0 0-.01M21 2l-9.6 9.6a5.5 5.5 0 1 1-1-1L20 1M17 6l3 3',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1M8 11V7a4 4 0 0 1 8 0v4',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M8 7h4M8 11h4M8 15h4M3 21h18',
  plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7z',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  bars: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
};

export function Icon({ name, size = 20, stroke = 2, className = '', style, title }) {
  const d = PATHS[name] || PATHS.box;
  return (
    <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      style={style} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}

// Categoria de un equipo segun su nombre (el campo type casi siempre es "otro").
// El orden importa: respirador antes que BiPAP, BiPAP antes que CPAP, portatil
// antes que concentrador.
const CATEGORIAS = [
  ['ventilador', /stellar|puritan|bennet|legendair|respirador|ventilador|astral|trilogy|vivo\b/i],
  ['bipap', /bi\s?-?pap|\bbpap|avaps|resmart|s9/i],
  ['cpap', /c\s?-?pap|\bcpp\b|yamind|tango|airsense|airstart|yuwell|\bg\s?i{1,2}\b|\bg2/i],
  ['portatil', /port[aá]til|simplygo|activox|inogen|eclipse/i],
  ['concentrador', /concentrador/i],
  ['oxigeno', /mochila|tubo|cilindro|ox[ií]geno/i],
  ['poligrafo', /pol[ií]graf/i],
  ['mascara', /m[aá]scara|almohadilla|pillow|nasal/i],
];

function categoriaEquipo(nombre = '', tipo = '') {
  const texto = `${nombre} ${tipo}`;
  for (const [cat, re] of CATEGORIAS) if (re.test(texto)) return cat;
  if (tipo === 'concentrador') return 'concentrador';
  if (tipo === 'cilindro') return 'oxigeno';
  if (tipo === 'ventilador') return 'ventilador';
  return null;
}

// Foto para mostrar: la propia del equipo si tiene, si no la de su categoria.
function fotoEquipo(eq) {
  if (!eq) return null;
  if (typeof eq.imageUrl === 'string' && eq.imageUrl) return eq.imageUrl;
  const cat = categoriaEquipo(eq.name, eq.type);
  return cat ? `/img/equipos/${cat}.webp` : null;
}

export function EquipoFoto({ equipo, size = 44, className = '' }) {
  const src = fotoEquipo(equipo);
  const [fallo, setFallo] = useState(false);
  return (
    <span className={`eq-foto ${className}`} style={{ width: size, height: size }}>
      {src && !fallo
        ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFallo(true)} />
        : <span className="eq-foto-vacia"><img src="/img/marca.png" alt="" /></span>}
    </span>
  );
}

// Avatar con iniciales para pacientes.
export function Avatar({ nombre = '', size = 40 }) {
  const partes = String(nombre).replace(',', ' ').trim().split(/\s+/).filter(Boolean);
  const ini = ((partes[0]?.[0] || '') + (partes[1]?.[0] || '')).toUpperCase() || '?';
  let h = 0;
  for (const c of String(nombre)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${h} 55% 92%)`, color: `hsl(${h} 45% 32%)` }}>{ini}</span>
  );
}
