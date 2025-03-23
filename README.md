# Servicio de Notificaciones Qubic

Este es un servicio backend para proporcionar notificaciones en tiempo real cuando se detectan transacciones en direcciones de Qubic.

## Funcionalidades

- Seguimiento de direcciones Qubic
- Detección de transacciones entrantes y salientes
- Notificaciones en tiempo real a través de WebSockets
- Persistencia de direcciones seguidas en JSON
- Comprobación periódica de cambios en el balance (cada 10 segundos)

## Estructura del proyecto

- `/src/index.js` - Punto de entrada principal y lógica del servidor
- `/src/data/tracked-addresses.json` - Almacenamiento persistente de direcciones seguidas

## Cómo funciona

1. El usuario activa el seguimiento para una dirección Qubic desde la interfaz
2. El frontend establece una conexión WebSocket con este servicio
3. El servicio guarda la dirección y monitorea los cambios en su balance
4. Cuando detecta cambios, envía notificaciones en tiempo real a todos los clientes suscritos
5. El frontend muestra las notificaciones y actualiza la UI

## Instalación

```bash
# Instalar dependencias
npm install

# Iniciar el servidor
npm start
```

## API

### WebSocket Events

**Cliente → Servidor:**
- `trackAddress` - Solicitar seguimiento de una dirección
- `untrackAddress` - Dejar de seguir una dirección

**Servidor → Cliente:**
- `trackingConfirmed` - Confirmación de seguimiento exitoso
- `trackingError` - Error al seguir dirección
- `transactionDetected` - Notificación de transacción detectada

### REST API

- `POST /api/track` - Agregar una dirección al seguimiento
- `DELETE /api/track` - Eliminar una dirección del seguimiento
- `GET /api/tracked` - Obtener todas las direcciones en seguimiento

## Requisitos para producción

Para un entorno de producción, se recomienda:

1. Configurar autenticación para el servicio
2. Limitar orígenes CORS a dominios específicos
3. Implementar un mecanismo de persistencia más robusto (base de datos)
4. Configurar HTTPS para conexiones seguras
5. Implementar límites de conexiones y throttling

## Integración con el frontend

En el frontend (`AddressDetail.tsx`), el usuario puede activar o desactivar el seguimiento de una dirección. Cuando está activo, recibirá notificaciones en tiempo real para cualquier transacción detectada en esa dirección. 