const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

// Configuración del servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // En producción, limitar a dominios específicos
    methods: ['GET', 'POST', 'DELETE']
  }
});

// Intervalo de verificación (en milisegundos) - cada 10 segundos
const CHECK_INTERVAL = 10000;

// Middleware
app.use(cors());
app.use(express.json());

// Rutas para archivos de seguimiento
const dataDir = path.join(__dirname, 'data');
const trackedAddressesFile = path.join(dataDir, 'tracked-addresses.json');

// Asegurar que el directorio de datos existe
fs.ensureDirSync(dataDir);

// Crear archivo de seguimiento si no existe
if (!fs.existsSync(trackedAddressesFile)) {
  fs.writeJsonSync(trackedAddressesFile, { addresses: [] });
}

// Mapa para mantener el estado de las direcciones seguidas en memoria
// Estructura: { addressId: { balance: string, users: Set<socketId>, lastCheck: Date } }
const trackedAddresses = new Map();

// Mapa para seguimiento de usuarios
// Estructura: { socketId: Set<addressId> }
const userTracking = new Map();

// Función para cargar direcciones seguidas desde el archivo JSON
const loadTrackedAddresses = async () => {
  try {
    const data = await fs.readJson(trackedAddressesFile);
    return data.addresses || [];
  } catch (error) {
    console.error('Error al cargar direcciones seguidas:', error);
    return [];
  }
};

// Función para guardar direcciones seguidas en el archivo JSON
const saveTrackedAddresses = async () => {
  try {
    const addresses = Array.from(trackedAddresses.keys());
    await fs.writeJson(trackedAddressesFile, { addresses });
  } catch (error) {
    console.error('Error al guardar direcciones seguidas:', error);
  }
};

// Obtener los detalles de una dirección desde la API
const fetchAddressDetails = async (addressId) => {
  try {
    console.log(`Obteniendo detalles para dirección ${addressId}...`);
    
    // Construir la URL de la API
    const apiUrl = `https://rpc.qubic.org/v1/balances/${addressId}`;
    
    console.log(`Consultando API: ${apiUrl}`);
    
    // Realizar solicitud a la API
    const response = await axios.get(apiUrl, {
      timeout: 10000, // Timeout de 10 segundos
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    // Verificar respuesta correcta
    if (response.status === 200 && response.data) {
      console.log(`Respuesta correcta de la API para dirección ${addressId}`);
      console.log(`Datos recibidos:`, JSON.stringify(response.data));
      
      // La API de Qubic devuelve los datos dentro de un objeto 'balance'
      if (response.data.balance) {
        const balanceData = response.data.balance;
        console.log(`Balance extraído: ${balanceData.balance}`);
        return balanceData;
      } else {
        console.error(`Error en estructura de respuesta para dirección ${addressId}: No se encontró balance`);
        throw new Error('Estructura de respuesta incorrecta');
      }
    } else {
      console.error(`Error al obtener detalles de dirección ${addressId}: Respuesta no válida`);
      throw new Error('Respuesta no válida');
    }
  } catch (error) {
    console.error(`Error al obtener detalles de dirección ${addressId}: ${error.message || error}`);
    
    if (error.response) {
      console.error(`Detalles de error: Status ${error.response.status}, Data:`, error.response.data);
    }
    
    // Crear un objeto mínimo con la dirección para que el seguimiento continúe funcionando
    console.log(`Creando objeto mínimo para dirección ${addressId} debido al error de API`);
    const fallbackObj = {
      id: addressId,
      balance: '0',
      validForTick: 0
    };
    
    console.log(`Usando objeto fallback:`, fallbackObj);
    return fallbackObj;
  }
};

// Endpoint para agregar una dirección al seguimiento
app.post('/api/track', async (req, res) => {
  const { addressId, socketId } = req.body;
  
  if (!addressId || !socketId) {
    return res.status(400).json({ error: 'Falta addressId o socketId' });
  }
  
  // Obtener detalles iniciales de la dirección
  const addressDetails = await fetchAddressDetails(addressId);
  
  if (!addressDetails) {
    return res.status(404).json({ error: 'No se pudo obtener la información de la dirección' });
  }
  
  // Agregar al seguimiento en memoria
  if (!trackedAddresses.has(addressId)) {
    trackedAddresses.set(addressId, {
      balance: addressDetails.balance,
      users: new Set([socketId]),
      lastCheck: new Date(),
      firstCheck: false
    });
  } else {
    trackedAddresses.get(addressId).users.add(socketId);
  }
  
  // Agregar al mapa de usuarios
  if (!userTracking.has(socketId)) {
    userTracking.set(socketId, new Set([addressId]));
  } else {
    userTracking.get(socketId).add(addressId);
  }
  
  // Guardar cambios en el archivo
  await saveTrackedAddresses();
  
  res.status(200).json({ success: true });
});

// Endpoint para dejar de seguir una dirección
app.delete('/api/track', async (req, res) => {
  const { addressId, socketId } = req.body;
  
  if (!addressId || !socketId) {
    return res.status(400).json({ error: 'Falta addressId o socketId' });
  }
  
  // Eliminar del seguimiento en memoria
  if (trackedAddresses.has(addressId)) {
    const tracked = trackedAddresses.get(addressId);
    tracked.users.delete(socketId);
    
    // Si no quedan usuarios siguiendo esta dirección, eliminarla del mapa
    if (tracked.users.size === 0) {
      trackedAddresses.delete(addressId);
    }
  }
  
  // Eliminar del mapa de usuarios
  if (userTracking.has(socketId)) {
    userTracking.get(socketId).delete(addressId);
    
    // Si el usuario no sigue ninguna dirección, eliminar del mapa
    if (userTracking.get(socketId).size === 0) {
      userTracking.delete(socketId);
    }
  }
  
  // Guardar cambios en el archivo
  await saveTrackedAddresses();
  
  res.status(200).json({ success: true });
});

// Endpoint para obtener todas las direcciones seguidas
app.get('/api/tracked', async (req, res) => {
  res.status(200).json({
    addresses: Array.from(trackedAddresses.keys())
  });
});

// Endpoint para simular una transacción (solo para pruebas)
app.post('/api/simulate-transaction', async (req, res) => {
  const { addressId, amount, type } = req.body;
  
  if (!addressId || !amount || !type) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos: addressId, amount, type (incoming/outgoing)' });
  }
  
  console.log(`Recibida solicitud para simular transacción ${type} de ${amount} para dirección ${addressId}`);
  
  try {
    // Verificar si la dirección está siendo seguida
    if (!trackedAddresses.has(addressId)) {
      console.log(`La dirección ${addressId} no está siendo seguida, intentando agregarla primero`);
      
      // Intentar obtener detalles actuales para simular agregar la dirección
      try {
        const addressDetails = await fetchAddressDetails(addressId);
        
        // Inicializar el seguimiento de esta dirección
        trackedAddresses.set(addressId, {
          balance: addressDetails.balance || '0',
          users: new Set(), // Inicialmente sin usuarios
          lastCheck: new Date(),
          firstCheck: false
        });
        
        console.log(`Dirección ${addressId} agregada para simulación con balance inicial: ${addressDetails.balance || '0'}`);
      } catch (error) {
        console.error(`No se pudo agregar la dirección ${addressId} para simulación:`, error);
        return res.status(404).json({ error: 'No se pudo agregar la dirección para simulación' });
      }
    }
    
    const tracked = trackedAddresses.get(addressId);
    
    if (!tracked.users || tracked.users.size === 0) {
      console.log(`Advertencia: La dirección ${addressId} no tiene seguidores activos`);
    }
    
    // Calcular nuevo balance
    const oldBalance = parseFloat(tracked.balance) || 0;
    const transactionAmount = parseFloat(amount);
    const newBalance = type === 'incoming' 
      ? oldBalance + transactionAmount 
      : oldBalance - transactionAmount;
    
    console.log(`Simulando transacción ${type} de ${amount} para dirección ${addressId}`);
    console.log(`Balance anterior: ${oldBalance}, Nuevo balance: ${newBalance}`);
    
    // Notificar a todos los usuarios que siguen esta dirección
    let notifiedUsers = 0;
    const activeUsers = [];
    
    for (const socketId of tracked.users) {
      console.log(`Intentando enviar notificación de simulación a socket ${socketId}`);
      
      // Verificar si el socket existe
      if (io.sockets.sockets.has(socketId)) {
        io.to(socketId).emit('transactionDetected', {
          addressId,
          oldBalance: oldBalance.toString(),
          newBalance: newBalance.toString(),
          difference: amount,
          type,
          timestamp: new Date().toISOString(),
          simulated: true
        });
        console.log(`Notificación simulada enviada correctamente a ${socketId}`);
        notifiedUsers++;
        activeUsers.push(socketId);
      } else {
        console.warn(`Socket ${socketId} ya no está conectado, no se envió notificación simulada`);
        // Eliminar usuario desconectado
        tracked.users.delete(socketId);
      }
    }
    
    // Actualizar el balance almacenado
    trackedAddresses.get(addressId).balance = newBalance.toString();
    trackedAddresses.get(addressId).lastCheck = new Date();
    
    // Guardar cambios en el archivo
    await saveTrackedAddresses();
    
    res.status(200).json({ 
      success: true, 
      message: `Transacción simulada enviada a ${notifiedUsers} usuarios`,
      oldBalance: oldBalance,
      newBalance: newBalance,
      difference: amount,
      type,
      notifiedUsers: activeUsers
    });
  } catch (error) {
    console.error('Error al simular transacción:', error);
    res.status(500).json({ error: 'Error interno del servidor', details: error.message });
  }
});

// Endpoint para probar la conexión a la API de Qubic
app.get('/api/test-connection/:addressId', async (req, res) => {
  try {
    const { addressId } = req.params;
    console.log(`Probando conexión a la API para dirección ${addressId}`);
    
    // Construir la URL de la API
    const apiUrl = `https://rpc.qubic.org/v1/balances/${addressId}`;
    console.log(`URL de API: ${apiUrl}`);
    
    // Realizar solicitud a la API
    const response = await axios.get(apiUrl, {
      timeout: 5000,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    // Verificar y enviar respuesta
    if (response.status === 200 && response.data) {
      console.log('Conexión exitosa a la API de Qubic');
      console.log('Datos recibidos:', response.data);
      
      return res.status(200).json({
        success: true,
        message: 'Conexión exitosa a la API de Qubic',
        data: response.data
      });
    } else {
      console.error('Error al conectar con la API: Respuesta no válida');
      return res.status(500).json({
        success: false,
        message: 'Error al conectar con la API: Respuesta no válida',
        error: 'Respuesta no válida'
      });
    }
  } catch (error) {
    console.error('Error al probar conexión con la API:', error.message || error);
    
    if (error.response) {
      console.error(`Detalles de error: Status ${error.response.status}, Data:`, error.response.data);
    }
    
    return res.status(500).json({
      success: false,
      message: 'Error al conectar con la API de Qubic',
      error: error.message || 'Error desconocido'
    });
  }
});

// Configuración de Socket.IO
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  
  // Para debug: mostrar todas las conexiones activas
  const connectedClients = Array.from(io.sockets.sockets.keys());
  console.log(`Clientes conectados: ${connectedClients.length}`, connectedClients);
  
  // Para debug: mostrar todas las direcciones seguidas
  console.log(`Direcciones seguidas: ${trackedAddresses.size}`, Array.from(trackedAddresses.keys()));
  
  // Manejar solicitud de seguimiento
  socket.on('trackAddress', async (addressId) => {
    try {
      console.log(`Recibida solicitud de seguimiento para dirección ${addressId} de socket ${socket.id}`);
      
      // Obtener detalles de la dirección
      const addressDetails = await fetchAddressDetails(addressId);
      
      if (!addressDetails) {
        console.error(`No se pudo obtener la información de la dirección ${addressId}`);
        socket.emit('trackingError', { addressId, error: 'No se pudo obtener la información de la dirección' });
        return;
      }
      
      console.log(`Detalles obtenidos para dirección ${addressId}:`, addressDetails);
      
      // Agregar al seguimiento en memoria
      if (!trackedAddresses.has(addressId)) {
        console.log(`Creando nuevo seguimiento para dirección ${addressId}`);
        trackedAddresses.set(addressId, {
          balance: addressDetails.balance,
          users: new Set([socket.id]),
          lastCheck: new Date(),
          firstCheck: false
        });
      } else {
        console.log(`Añadiendo usuario ${socket.id} al seguimiento existente de dirección ${addressId}`);
        trackedAddresses.get(addressId).users.add(socket.id);
      }
      
      // Agregar al mapa de usuarios
      if (!userTracking.has(socket.id)) {
        console.log(`Creando nuevo registro de usuario ${socket.id}`);
        userTracking.set(socket.id, new Set([addressId]));
      } else {
        console.log(`Añadiendo dirección ${addressId} al usuario ${socket.id}`);
        userTracking.get(socket.id).add(addressId);
      }
      
      // Verificar el estado después de la actualización
      console.log(`Estado de seguimiento después de la actualización para ${addressId}:`);
      if (trackedAddresses.has(addressId)) {
        const addressInfo = trackedAddresses.get(addressId);
        console.log(`- Balance: ${addressInfo.balance}`);
        console.log(`- Usuarios: ${Array.from(addressInfo.users).join(', ')}`);
        console.log(`- Última verificación: ${addressInfo.lastCheck}`);
      }
      
      // Guardar cambios en el archivo
      await saveTrackedAddresses();
      
      // Confirmar seguimiento exitoso al cliente
      console.log(`Enviando confirmación de seguimiento al cliente ${socket.id}`);
      socket.emit('trackingConfirmed', { addressId });
      console.log(`Usuario ${socket.id} ahora sigue la dirección ${addressId}`);
      
      // Verificar si el usuario tiene conexión activa
      if (io.sockets.sockets.has(socket.id)) {
        console.log(`Conexión activa confirmada para socket ${socket.id}`);
        
        // Forzar una verificación inmediata
        setTimeout(() => {
          console.log(`Iniciando verificación inmediata para dirección recién seguida ${addressId}`);
          checkAddressChanges();
        }, 1000);
      } else {
        console.warn(`Advertencia: El socket ${socket.id} ya no está conectado`);
      }
    } catch (error) {
      console.error(`Error al seguir dirección ${addressId}:`, error);
      socket.emit('trackingError', { addressId, error: 'Error interno del servidor' });
    }
  });
  
  // Manejar solicitud para dejar de seguir
  socket.on('untrackAddress', async (addressId) => {
    // Eliminar del seguimiento en memoria
    if (trackedAddresses.has(addressId)) {
      const tracked = trackedAddresses.get(addressId);
      tracked.users.delete(socket.id);
      
      // Si no quedan usuarios siguiendo esta dirección, eliminarla del mapa
      if (tracked.users.size === 0) {
        trackedAddresses.delete(addressId);
      }
    }
    
    // Eliminar del mapa de usuarios
    if (userTracking.has(socket.id)) {
      userTracking.get(socket.id).delete(addressId);
      
      // Si el usuario no sigue ninguna dirección, eliminar del mapa
      if (userTracking.get(socket.id).size === 0) {
        userTracking.delete(socket.id);
      }
    }
    
    // Guardar cambios en el archivo
    await saveTrackedAddresses();
    
    // Confirmar al cliente
    socket.emit('untrackingConfirmed', { addressId });
    console.log(`Usuario ${socket.id} dejó de seguir la dirección ${addressId}`);
  });
  
  // Manejar desconexión del cliente
  socket.on('disconnect', async () => {
    console.log(`Cliente desconectado: ${socket.id}`);
    
    // Limpiar seguimiento cuando el cliente se desconecta
    if (userTracking.has(socket.id)) {
      // Obtener todas las direcciones que seguía este usuario
      const addresses = userTracking.get(socket.id);
      
      // Eliminar este usuario del seguimiento de cada dirección
      for (const addressId of addresses) {
        if (trackedAddresses.has(addressId)) {
          const tracked = trackedAddresses.get(addressId);
          tracked.users.delete(socket.id);
          
          // Si no quedan usuarios siguiendo esta dirección, eliminarla del mapa
          if (tracked.users.size === 0) {
            trackedAddresses.delete(addressId);
          }
        }
      }
      
      // Eliminar el usuario del mapa de seguimiento
      userTracking.delete(socket.id);
      
      // Guardar cambios en el archivo
      await saveTrackedAddresses();
    }
  });
});

// Función para verificar cambios en los saldos
const checkAddressChanges = async () => {
  console.log(`Verificando cambios en ${trackedAddresses.size} direcciones...`);
  
  // Crear un registro de seguimiento
  const monitorLog = {
    timestamp: new Date().toISOString(),
    checkCount: 0,
    changes: []
  };
  
  // Guardar un archivo de registro con los cambios detectados
  const saveMonitorLog = async (log) => {
    try {
      const logFilePath = path.join(dataDir, `monitor-log-${new Date().toISOString().replace(/:/g, '-')}.json`);
      await fs.writeJson(logFilePath, log);
      console.log(`Registro de monitoreo guardado en ${logFilePath}`);
    } catch (error) {
      console.error('Error al guardar registro de monitoreo:', error);
    }
  };
  
  for (const [addressId, tracked] of trackedAddresses.entries()) {
    try {
      monitorLog.checkCount++;
      const addressLog = {
        addressId,
        previousBalance: tracked.balance,
        newBalance: null,
        hasUsers: tracked.users && tracked.users.size > 0,
        userCount: tracked.users ? tracked.users.size : 0,
        usersArray: tracked.users ? Array.from(tracked.users) : [],
        timestamp: new Date().toISOString(),
        changeDetected: false
      };
      
      // Si no hay usuarios siguiendo esta dirección, continuar con la siguiente
      if (!tracked.users || tracked.users.size === 0) {
        console.log(`La dirección ${addressId} ya no tiene seguidores (users: ${JSON.stringify(Array.from(tracked.users || []))}), omitiendo verificación.`);
        monitorLog.changes.push(addressLog);
        continue;
      }
      
      console.log(`Verificando cambios para dirección ${addressId} con ${tracked.users.size} seguidores: ${JSON.stringify(Array.from(tracked.users))}`);
      
      // Obtener detalles actuales
      const addressDetails = await fetchAddressDetails(addressId);
      
      if (!addressDetails) {
        console.error(`No se pudo obtener detalles para la dirección ${addressId}`);
        monitorLog.changes.push(addressLog);
        continue;
      }
      
      // Actualizar el log
      addressLog.newBalance = addressDetails.balance;
      
      // Log para depuración
      console.log(`Balance actual: ${addressDetails.balance}, Balance anterior: ${tracked.balance}`);
      
      // Si es la primera vez que se verifica (balance inicial es "0"), actualizar y continuar
      if (tracked.balance === "0" && tracked.firstCheck) {
        console.log(`Inicializando balance para dirección ${addressId}: ${addressDetails.balance}`);
        trackedAddresses.get(addressId).balance = addressDetails.balance;
        trackedAddresses.get(addressId).firstCheck = false;
        trackedAddresses.get(addressId).lastCheck = new Date();
        monitorLog.changes.push(addressLog);
        continue;
      }
      
      // Convertir los balances a números para la comparación
      const oldBalance = parseFloat(tracked.balance) || 0;
      const newBalance = parseFloat(addressDetails.balance) || 0;
      
      // Detectar cambios en el balance con una pequeña tolerancia para evitar problemas de punto flotante
      if (Math.abs(newBalance - oldBalance) > 0.000001) {
        console.log(`Cambio detectado en dirección ${addressId}: ${oldBalance} → ${newBalance}`);
        addressLog.changeDetected = true;
        
        // Determinar si es transacción entrante o saliente
        const isIncoming = newBalance > oldBalance;
        const difference = Math.abs(newBalance - oldBalance).toFixed(6);
        
        console.log(`Tipo de transacción: ${isIncoming ? 'entrante' : 'saliente'}, Diferencia: ${difference}`);
        console.log(`Enviando notificación a ${tracked.users.size} usuarios: ${JSON.stringify(Array.from(tracked.users))}`);
        
        // Notificar a todos los usuarios que siguen esta dirección
        for (const socketId of tracked.users) {
          console.log(`Enviando notificación a socket ${socketId}`);
          
          // Verificar si el socket existe
          if (io.sockets.sockets.has(socketId)) {
            io.to(socketId).emit('transactionDetected', {
              addressId,
              oldBalance: oldBalance.toString(),
              newBalance: newBalance.toString(),
              difference,
              type: isIncoming ? 'incoming' : 'outgoing',
              timestamp: new Date().toISOString()
            });
            console.log(`Notificación enviada correctamente a ${socketId}`);
          } else {
            console.warn(`Socket ${socketId} ya no está conectado, no se envió notificación`);
            // Eliminar usuario desconectado
            tracked.users.delete(socketId);
          }
        }
        
        // Actualizar el balance almacenado
        trackedAddresses.get(addressId).balance = newBalance.toString();
      } else {
        console.log(`Sin cambios en la dirección ${addressId}, balance: ${newBalance}`);
      }
      
      // Actualizar la última verificación
      trackedAddresses.get(addressId).lastCheck = new Date();
      monitorLog.changes.push(addressLog);
    } catch (error) {
      console.error(`Error al verificar dirección ${addressId}:`, error);
    }
  }
  
  // Guardar el log si hay cambios o al menos una vez cada 6 verificaciones
  if (monitorLog.changes.some(change => change.changeDetected) || monitorLog.checkCount % 6 === 0) {
    await saveMonitorLog(monitorLog);
  }
  
  // Programar la siguiente verificación
  setTimeout(checkAddressChanges, CHECK_INTERVAL);
};

// Cargar direcciones iniciales
loadTrackedAddresses().then(addresses => {
  console.log(`Cargadas ${addresses.length} direcciones desde el archivo`);
  // Inicializar el mapa con las direcciones cargadas
  addresses.forEach(addressId => {
    if (!trackedAddresses.has(addressId)) {
      trackedAddresses.set(addressId, {
        balance: '0', // Se actualizará en la primera verificación
        users: new Set(),
        lastCheck: new Date(),
        firstCheck: true // Indicador para la primera verificación
      });
    }
  });
  
  // Iniciar verificación inicial
  checkAddressChanges();
});

// Iniciar servidor
const PORT = process.env.PORT || 3112;
server.listen(PORT, () => {
  console.log(`Servidor de notificaciones Qubic ejecutándose en puerto ${PORT}`);
}); 