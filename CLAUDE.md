## NORMA GENERAL (obligatoria)
- TESTEAR SIEMPRE todos los cambios antes de darlos por terminados. No alcanza con compilar (`npm run build`): hay que verificar el comportamiento real en la app desplegada (https://aplicacion-beta.vercel.app) abriendola en el navegador via la extension Claude-in-Chrome, recargando con Ctrl+F5, y confirmando que el cambio funciona de punta a punta. Recien ahi se informa al usuario.
- No asumir que algo anda porque el codigo "se ve bien". Reproducir el flujo del usuario y mirar el resultado.
- CONTROLAR DESPUES DE GUARDAR (obligatorio): tras cualquier cambio que escriba datos (especialmente operaciones masivas como "Normalizar Vencimientos" o cualquier cosa que recorra todos los registros), verificar el ESTADO COMPLETO en Supabase, no solo un conteo o un caso. Confirmar explicitamente que NO se rompio ni se perdio nada que antes estaba bien. Antes de correr una operacion masiva, capturar el estado previo (ej: cuales estaban vencidos, sus fechas) para poder comparar el "antes vs despues" y detectar lo que se haya pisado.
- Una operacion que "pisa" datos validos previos es un BUG, aunque el resultado nuevo sea consistente. Nunca reportar exito mostrando solo que el resultado nuevo cuadra; hay que confirmar que lo que ya estaba correcto sigue correcto.

## Proyecto: InserSaludWeb (app de alquiler de equipos medicos)
- Ruta local: C:\Users\Hp\OneDrive\Documentos\json\aplicacion\InserSaludWeb-clon-20260507-113542
- Repo: https://github.com/insersalud-byte/aplicacion.git (rama main)
- Produccion: https://aplicacion-beta.vercel.app (deploy automatico al hacer push a main; Vercel buildea desde el codigo fuente, `dist/` esta en .gitignore)
- Stack: React 19 + Vite 8, sin TypeScript. Casi toda la logica esta en src/App.jsx. Capa de datos en src/data/database.js.

### Persistencia de datos (CRITICO)
- Supabase es la UNICA fuente de verdad. Tabla `inser_app_data`, fila id=1, columna JSON `data`.
- URL: https://gvharyztavhugqiaihjq.supabase.co
- `loadData()` lee SIEMPRE de Supabase; localStorage es solo cache offline.
- `saveData()` escribe a Supabase y luego cachea local.

### Acceso con contraseña (desde 13-oct-2026)
- La tabla `inser_app_data` NO tiene acceso anonimo (se quito la politica `anon_full_access`): con la clave publica no se lee ni se escribe. NUNCA volver a abrirla ni leerla/escribirla con `fetch` directo a `/rest/v1/inser_app_data`.
- Todo pasa por funciones SECURITY DEFINER de la base: `app_login(p_password)` -> token de sesion (30 dias desde el ultimo uso, se guarda en localStorage `insersalud_session`), `app_load(p_token)`, `app_ts(p_token)`, `app_save(p_token, p_data)`, `app_logout`, `app_cambiar_clave`. La API de Santi (api/server.js) usa `app_api_data(p_key)` validando contra settings.apiKey.
- El hash bcrypt de la contraseña y las sesiones viven en el esquema `app_private` (no expuesto por la API). La contraseña se cambia desde Configuracion. Limite anti fuerza bruta: 8 fallos por IP / 40 globales cada 15 min.
- `app_save` rechaza un guardado que deje sin pacientes o sin alquileres de golpe.

### Vencimientos (regla unica)
- Un periodo se paga con la clave del periodo que VENCE: mensual = `YYYY-MM` del vencimiento, quincenal = la fecha. `periodosImpagos` recorre vencimientos (no meses calendario) desde endDate hasta hoy; `primerVencimientoImpago` lleva endDate al primer periodo sin pagar.
- "Por vencer" = vencen en los proximos `DIAS_AVISO` (7) dias, igual que el reporte de Santi. Vencer hoy = vencido.
- "Normalizar Vencimientos" NO adelanta alquileres con periodos impagos.
- El agente contador de Santi (`contabilidad.py`) replica `periodosImpagos`: si se cambia, actualizarlo tambien.
- NO volver a meter logica de "merge local+remoto": eso causaba que cada navegador tuviera datos distintos aunque el indicador dijera "Sincronizado".
- `seedEquiposNuevos` (src/data/seedEquiposNuevos.js) son 42 equipos por defecto que se siembran solo si la base no tiene ninguno.

### Flujo de deploy
editar src/ -> `npm run build` -> `git add` (codigo fuente) -> commit -> `git push origin main` -> verificar en produccion con Ctrl+F5.

## Estilo
- Conciso en la salida, exhaustivo en el razonamiento. Sin emojis ni em-dashes. Sin adulacion.
- Leer los archivos antes de editarlos. No re-leer salvo que hayan cambiado.

## API de solo lectura para Santi (Hermes) - api/server.js
- `GET /api/server?vencimientos=1&key=` (alquileres vencidos/por vencer), `?precios=1&key=` (lista de precios) y, desde el 26-sept-2026 (commit 54fe5d8), `?contabilidad=1&key=` (facturas, cotizaciones, alquileres con `pagos` = paymentStatusByMonth, parque de equipos con ownership y precios, catalogo de venta con `costo_usd` = priceUsd y `venta_usd` = priceVentaUsd, mascaras, descartables y `parametros` = settings.contabilidad). La clave es settings.apiKey (se genera en Configuracion). Ninguno escribe.
- La API devuelve datos normalizados SIN calculos: los indicadores (cobrado, contratado, ganancia, MRR, ocupacion) los recalcula el agente contador de Santi (`~/.hermes/plugins/inser/contabilidad.py` en el VPS) copiando las reglas de ContabilidadPage (periodosCobradosEnMes, periodosContratadosEnMes, vigenteEnMes, resumenDeMes, periodosImpagos, CATEGORIAS_*). **Si se cambia una de esas reglas en App.jsx, avisar: hay que replicarla en contabilidad.py** o los numeros de Santi dejan de coincidir con la pestaña.
