# InserSaludWeb

La aplicacion ahora expone una API HTTP sobre la misma estructura de datos que ya usa el frontend, sin cambiar las pantallas ni el modelo general.

## Base compartida

Los datos quedan guardados en:

- `C:\Users\Hp\OneDrive\Documentos\json\aplicacion\InserSaludWeb\data\database.json`

La web sigue funcionando igual, pero ahora lee y guarda por API. Si la API no responde, hace fallback a `localStorage` para no romper el uso actual.

## Como iniciar

1. Ejecutar `npm run build`
2. Ejecutar `npm run serve`
3. Abrir `http://localhost:3000`

Si queres desarrollar con Vite:

1. Ejecutar `npm run serve` en una terminal
2. Ejecutar `npm run dev` en otra terminal
3. Vite va a redirigir `/api` al servidor en `http://localhost:3000`

## Endpoints

### Base completa

- `GET /api/health`
- `GET /api/db`
- `PUT /api/db`

### Configuracion

- `GET /api/settings`
- `PATCH /api/settings`
- `PUT /api/settings`

### Colecciones disponibles

- `patients`
- `equipment`
- `rentals`
- `quotations`
- `descartables`
- `mascaras`
- `invoices`

Para cada coleccion:

- `GET /api/{collection}`
- `POST /api/{collection}`
- `GET /api/{collection}/{id}`
- `PATCH /api/{collection}/{id}`
- `PUT /api/{collection}/{id}`
- `DELETE /api/{collection}/{id}`

## Ejemplos

Leer todos los equipos:

```bash
curl http://localhost:3000/api/equipment
```

Cambiar el precio de un alquiler:

```bash
curl -X PATCH http://localhost:3000/api/rentals/ID_DEL_ALQUILER ^
  -H "Content-Type: application/json" ^
  -d "{\"price\":25000}"
```

Cambiar el precio de una mascara o descartable:

```bash
curl -X PATCH http://localhost:3000/api/mascaras/ID ^
  -H "Content-Type: application/json" ^
  -d "{\"price\":18000}"
```

Actualizar configuracion general:

```bash
curl -X PATCH http://localhost:3000/api/settings ^
  -H "Content-Type: application/json" ^
  -d "{\"monthlyRentalPrice\":22000,\"salePriceMultiplier\":4}"
```
