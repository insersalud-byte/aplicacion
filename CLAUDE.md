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
- NO volver a meter logica de "merge local+remoto": eso causaba que cada navegador tuviera datos distintos aunque el indicador dijera "Sincronizado".
- `seedEquiposNuevos` (src/data/seedEquiposNuevos.js) son 42 equipos por defecto que se siembran solo si la base no tiene ninguno.

### Flujo de deploy
editar src/ -> `npm run build` -> `git add` (codigo fuente) -> commit -> `git push origin main` -> verificar en produccion con Ctrl+F5.

## Estilo
- Conciso en la salida, exhaustivo en el razonamiento. Sin emojis ni em-dashes. Sin adulacion.
- Leer los archivos antes de editarlos. No re-leer salvo que hayan cambiado.
