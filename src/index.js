const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');

// Manejo global de errores para evitar que el servidor se detenga
process.on('uncaughtException', (err) => {
  console.error('ERROR NO CAPTURADO:', err);
  console.error('El servidor continuará ejecutándose');
  // No hacer process.exit() para mantener el servidor funcionando
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('PROMESA RECHAZADA NO MANEJADA:');
  console.error('- Razón:', reason);
  console.error('- Promesa:', promise);
  console.error('El servidor continuará ejecutándose');
  // No hacer process.exit() para mantener el servidor funcionando
});

// Configuración del servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // En producción, limitar a dominios específicos
    methods: ['GET', 'POST', 'DELETE']
  }
});

// Puerto para el servidor
const PORT = process.env.PORT || 3112;

// Intervalo de verificación (en milisegundos) - cada 10 segundos
const CHECK_INTERVAL = 10000;

// Token del bot de Telegram (reemplazar con tu token real)
let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// ID de usuario de Telegram fijo para notificaciones
const ADMIN_TELEGRAM_USER_ID = 1191108091;

// Configuración del transporte de correo electrónico
let emailTransporter;

// Directorio para almacenamiento de datos
const dataDir = path.join(__dirname, 'data');
fs.ensureDirSync(dataDir);

// Archivo de log consolidado
const logFile = path.join(dataDir, 'notification-service.log');

// Función para añadir entrada al log
const logToFile = (message, data = null) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    message,
    data
  };
  
  try {
    // Añadir al archivo de log en modo append
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error('Error al escribir en el archivo de log:', error);
  }
  
  // También mostrar en consola
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(data);
  }
};

// Inicialización del transporter de email
const initializeEmailTransporter = async () => {
  try {
    // Crear una cuenta de prueba en Ethereal
    const testAccount = await nodemailer.createTestAccount();
    
    // Crear un transporter reutilizable
    emailTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false, // true para 465, false para otros puertos
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
    
    logToFile('Transporter de email configurado correctamente', {
      user: testAccount.user,
      previewUrl: 'https://ethereal.email'
    });
    
    console.log('Credenciales de prueba de Ethereal:');
    console.log('- Usuario:', testAccount.user);
    console.log('- Contraseña:', testAccount.pass);
    console.log('- URL para ver los correos enviados:', 'https://ethereal.email');
    
    return true;
  } catch (error) {
    logToFile('Error al configurar el transporter de email', error);
    return false;
  }
};

// Función para enviar un correo electrónico
const sendEmail = async (to, subject, text, html) => {
  if (!emailTransporter) {
    logToFile('El transporter de email no está inicializado');
    return false;
  }

  try {
    logToFile(`Enviando email a ${to}`, { subject });
    
    // Enviar correo electrónico
    const info = await emailTransporter.sendMail({
      from: '"Qubic Explorer" <notificaciones@qubic-explorer.com>',
      to,
      subject,
      text,
      html
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    
    logToFile('Email enviado correctamente', {
      to,
      messageId: info.messageId,
      previewUrl
    });
    
    return true;
  } catch (error) {
    logToFile('Error al enviar email', { to, error: error.message });
    return false;
  }
};

// Cargar configuración de Telegram
const loadTelegramConfig = async () => {
  try {
    const configFile = path.join(dataDir, 'telegram-config.json');
    console.log(`Intentando cargar configuración de Telegram desde ${configFile}`);
    
    if (fs.existsSync(configFile)) {
      const config = await fs.readJson(configFile);
      console.log('Archivo de configuración encontrado:', config);
      
      if (config.token) {
        TELEGRAM_BOT_TOKEN = config.token;
        console.log('Token de Telegram cargado desde configuración');
        return true;
      } else {
        console.error('El archivo de configuración no contiene un token válido');
      }
    } else {
      console.error(`El archivo de configuración no existe en ${configFile}`);
    }
    return false;
  } catch (error) {
    console.error('Error al cargar configuración de Telegram:', error);
    return false;
  }
};

// Inicializar bot de Telegram
let telegramBot;
const initTelegramBot = async () => {
  if (!TELEGRAM_BOT_TOKEN) {
    await loadTelegramConfig();
  }
  
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'TU_TOKEN_DE_TELEGRAM') {
    console.log('Token de Telegram no configurado. Las notificaciones por Telegram no estarán disponibles.');
    return null;
  }
  
  try {
    // Cerrar cualquier instancia anterior del bot si existe
    if (telegramBot) {
      try {
        console.log('Cerrando instancia anterior del bot de Telegram...');
        await telegramBot.close();
      } catch (closeError) {
        console.error('Error al cerrar instancia anterior del bot:', closeError);
      }
    }
    
    console.log('Inicializando nueva instancia del bot de Telegram...');
    const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
      polling: true,
      onlyFirstMatch: true,
      // Añadir opciones para evitar conflictos entre múltiples instancias
      polling_options: {
        timeout: 10,
        limit: 100
      }
    });
    
    console.log('Bot de Telegram inicializado correctamente');
    
    // Manejar errores de polling específicamente
    bot.on('polling_error', (error) => {
      console.error('Error de polling en Telegram:', error);
      // No reiniciar automáticamente en caso de conflicto
      if (error.code === 'ETELEGRAM' && error.message && error.message.includes('Conflict')) {
        console.log('Detectado conflicto con otra instancia. Desactivando polling para esta instancia.');
        try {
          bot.stopPolling();
        } catch (e) {
          console.error('Error al detener polling:', e);
        }
      }
    });
    
    // Configurar manejadores de eventos
    setupTelegramHandlers(bot);
    
    return bot;
  } catch (error) {
    console.error('Error al inicializar el bot de Telegram:', error);
    console.log('Las notificaciones por Telegram no estarán disponibles');
    return null;
  }
};

// Configurar manejadores de eventos de Telegram
const setupTelegramHandlers = (bot) => {
  // Manejar comando /start
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '¡Bienvenido al servicio de notificaciones Qubic! Usa /subscribe DIRECCION para seguir una dirección Qubic.');
  });
  
  // Manejar comando /help
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `
Comandos disponibles:
/start - Iniciar el bot
/help - Mostrar esta ayuda
/subscribe DIRECCION - Seguir una dirección Qubic
/unsubscribe DIRECCION - Dejar de seguir una dirección
/list - Listar direcciones seguidas
/status - Ver estado del servicio
    `;
    bot.sendMessage(chatId, helpText);
  });
  
  // Manejar comando /subscribe
  bot.onText(/\/subscribe (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const addressId = match[1].trim();
    
    bot.sendMessage(chatId, `Procesando solicitud para seguir la dirección ${addressId}...`);
    
    try {
      // Validar la dirección
      if (!addressId || addressId.length < 10) {
        return bot.sendMessage(chatId, 'Por favor, proporciona una dirección Qubic válida.');
      }
      
      // Obtener detalles de la dirección para validar
      const addressDetails = await fetchAddressDetails(addressId);
      
      if (!addressDetails) {
        return bot.sendMessage(chatId, `No se pudo obtener información para la dirección ${addressId}. Verifica que sea una dirección válida.`);
      }
      
      // Crear el ID del chat de Telegram para usarlo como identificador
      const telegramUserId = `telegram-${chatId}`;
      
      // Agregar al seguimiento en memoria
      if (!trackedAddresses.has(addressId)) {
        trackedAddresses.set(addressId, {
          balance: addressDetails.balance,
          users: new Set([telegramUserId]),
          lastCheck: new Date(),
          firstCheck: false,
          telegramUsers: new Set([chatId]) // Nuevo conjunto para usuarios de Telegram
        });
      } else {
        trackedAddresses.get(addressId).users.add(telegramUserId);
        
        // Agregar al conjunto de usuarios de Telegram si existe
        if (!trackedAddresses.get(addressId).telegramUsers) {
          trackedAddresses.get(addressId).telegramUsers = new Set();
        }
        trackedAddresses.get(addressId).telegramUsers.add(chatId);
      }
      
      // Agregar al mapa de usuarios
      if (!userTracking.has(telegramUserId)) {
        userTracking.set(telegramUserId, new Set([addressId]));
      } else {
        userTracking.get(telegramUserId).add(addressId);
      }
      
      // Guardar cambios en el archivo
      await saveTrackedAddresses();
      
      // Confirmar al usuario
      bot.sendMessage(
        chatId, 
        `✅ ¡Ahora estás siguiendo la dirección ${addressId}!\n\nBalance actual: ${addressDetails.balance} QU\n\nRecibirás notificaciones cuando ocurran transacciones.`
      );
      
      console.log(`Usuario de Telegram ${chatId} ahora sigue la dirección ${addressId}`);
    } catch (error) {
      console.error(`Error al procesar solicitud de Telegram para dirección ${addressId}:`, error);
      bot.sendMessage(chatId, `Error al procesar la solicitud: ${error.message}`);
    }
  });
  
  // Manejar comando /unsubscribe
  bot.onText(/\/unsubscribe (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const addressId = match[1].trim();
    const telegramUserId = `telegram-${chatId}`;
    
    // Verificar si la dirección está siendo seguida
    if (trackedAddresses.has(addressId)) {
      const tracked = trackedAddresses.get(addressId);
      
      // Eliminar del seguimiento
      tracked.users.delete(telegramUserId);
      
      // Eliminar del conjunto de usuarios de Telegram si existe
      if (tracked.telegramUsers) {
        tracked.telegramUsers.delete(chatId);
      }
      
      // Si no quedan usuarios siguiendo esta dirección, eliminarla del mapa
      if (tracked.users.size === 0) {
        trackedAddresses.delete(addressId);
      }
      
      // Eliminar del mapa de usuarios
      if (userTracking.has(telegramUserId)) {
        userTracking.get(telegramUserId).delete(addressId);
        
        // Si el usuario no sigue ninguna dirección, eliminar del mapa
        if (userTracking.get(telegramUserId).size === 0) {
          userTracking.delete(telegramUserId);
        }
      }
      
      // Guardar cambios en el archivo
      await saveTrackedAddresses();
      
      bot.sendMessage(chatId, `✅ Has dejado de seguir la dirección ${addressId}.`);
    } else {
      bot.sendMessage(chatId, `❌ No estás siguiendo la dirección ${addressId}.`);
    }
  });
  
  // Manejar comando /list
  bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramUserId = `telegram-${chatId}`;
    
    // Verificar si el usuario sigue alguna dirección
    if (userTracking.has(telegramUserId) && userTracking.get(telegramUserId).size > 0) {
      const addresses = Array.from(userTracking.get(telegramUserId));
      
      let message = '📋 Direcciones que estás siguiendo:\n\n';
      
      for (const addressId of addresses) {
        if (trackedAddresses.has(addressId)) {
          const balance = trackedAddresses.get(addressId).balance || '0';
          message += `• ${addressId}\n  Balance: ${balance} QU\n\n`;
        } else {
          message += `• ${addressId}\n  (Información no disponible)\n\n`;
        }
      }
      
      bot.sendMessage(chatId, message);
    } else {
      bot.sendMessage(chatId, '❌ No estás siguiendo ninguna dirección. Usa /subscribe DIRECCION para comenzar a seguir una dirección Qubic.');
    }
  });
  
  // Manejar comando /status
  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    
    const message = `
🔄 Estado del servicio:

Direcciones seguidas: ${trackedAddresses.size}
Usuarios conectados: ${userTracking.size}
Última verificación: ${new Date().toLocaleString()}
    `;
    
    bot.sendMessage(chatId, message);
  });
};

// Middleware
app.use(cors());
app.use(express.json());

// Rutas para archivos de seguimiento
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

// Endpoint para configurar el token del bot de Telegram
app.post('/api/telegram/set-token', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Falta el token de Telegram' });
  }
  
  try {
    // Guardar el token en un archivo
    const configFile = path.join(dataDir, 'telegram-config.json');
    await fs.writeJson(configFile, { token });
    
    // Actualizar la variable global
    TELEGRAM_BOT_TOKEN = token;
    
    // Cerrar el bot actual si existe
    if (telegramBot) {
      telegramBot.close();
    }
    
    // Inicializar el bot con el nuevo token
    telegramBot = await initTelegramBot();
    
    if (telegramBot) {
      console.log('Bot de Telegram reiniciado con nuevo token');
      res.status(200).json({ 
        success: true, 
        message: 'Token configurado correctamente' 
      });
    } else {
      res.status(500).json({ 
        error: 'No se pudo inicializar el bot con el token proporcionado',
      });
    }
  } catch (error) {
    console.error('Error al configurar el token de Telegram:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Endpoint para enviar un mensaje de prueba a un chat de Telegram
app.post('/api/telegram/send-test', async (req, res) => {
  const { chatId, message } = req.body;
  
  if (!chatId || !message) {
    return res.status(400).json({ error: 'Faltan parámetros: chatId y message son requeridos' });
  }
  
  if (!telegramBot) {
    return res.status(500).json({ error: 'Bot de Telegram no inicializado. Configure el token primero.' });
  }
  
  try {
    const result = await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    console.log(`Mensaje de prueba enviado al chat ${chatId}`);
    
    res.status(200).json({ 
      success: true, 
      message: 'Mensaje enviado correctamente',
      result: result
    });
  } catch (error) {
    console.error(`Error al enviar mensaje a Telegram (chat ${chatId}):`, error);
    res.status(500).json({ 
      error: 'Error al enviar mensaje',
      details: error.message 
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
  socket.on('trackAddress', async (data) => {
    try {
      let addressId;
      let notificationConfig = null;
      
      // Verificar si el formato es el nuevo (con configuración) o el antiguo (solo addressId)
      if (typeof data === 'object' && data.addressId) {
        addressId = data.addressId;
        notificationConfig = data.notificationConfig;
        console.log(`Cliente ${socket.id} está siguiendo la dirección ${addressId} con configuración:`, notificationConfig);
      } else {
        addressId = data;
        console.log(`Cliente ${socket.id} está siguiendo la dirección ${addressId} sin configuración`);
      }
      
      if (!addressId) {
        socket.emit('trackingError', { 
          addressId: 'unknown', 
          error: 'ID de dirección no proporcionado' 
        });
        return;
      }
      
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
          firstCheck: false,
          notificationConfigs: new Map() // Mapa para almacenar las configuraciones de notificación
        });
      } else {
        console.log(`Añadiendo usuario ${socket.id} al seguimiento existente de dirección ${addressId}`);
        trackedAddresses.get(addressId).users.add(socket.id);
        
        // Asegurarse de que existe el mapa de configuraciones
        if (!trackedAddresses.get(addressId).notificationConfigs) {
          trackedAddresses.get(addressId).notificationConfigs = new Map();
        }
      }
      
      // Guardar la configuración de notificaciones si se proporcionó
      if (notificationConfig) {
        trackedAddresses.get(addressId).notificationConfigs.set(socket.id, {
          email: notificationConfig.email,
          telegram: notificationConfig.telegram,
          chrome: notificationConfig.chrome
        });
        console.log(`Configuración de notificación guardada para ${socket.id}:`, 
                    trackedAddresses.get(addressId).notificationConfigs.get(socket.id));
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
        console.log(`- Configuraciones de notificación: ${addressInfo.notificationConfigs ? addressInfo.notificationConfigs.size : 0}`);
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
      console.error(`Error al seguir dirección:`, error);
      socket.emit('trackingError', { 
        addressId: typeof data === 'object' ? data.addressId : data, 
        error: 'Error interno del servidor' 
      });
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

// Función para enviar notificación por Telegram
const sendTelegramNotification = async (chatId, message) => {
  if (!telegramBot) {
    console.log('Bot de Telegram no disponible, omitiendo notificación');
    return;
  }
  
  try {
    await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    console.log(`Notificación enviada al chat de Telegram ${chatId}`);
  } catch (error) {
    console.error(`Error al enviar notificación a Telegram (chat ${chatId}):`, error);
  }
};

// Función para verificar cambios en los saldos
const checkAddressChanges = async () => {
  console.log(`Verificando cambios en ${trackedAddresses.size} direcciones...`);
  logToFile(`Verificando cambios en ${trackedAddresses.size} direcciones`);
  
  // Crear un registro de seguimiento
  const monitorLog = {
    timestamp: new Date().toISOString(),
    checkCount: 0,
    changes: []
  };
  
  // Guardar un archivo de registro con los cambios detectados
  const saveMonitorLog = async (log) => {
    try {
      // Añadimos al log consolidado en lugar de crear muchos archivos
      logToFile('Verificación de cambios completada', log);
      
      // Para mantener compatibilidad, seguimos guardando el archivo individual
      // pero lo hacemos solo para transacciones detectadas
      if (log.changes && log.changes.some(change => change.changeDetected)) {
        const logFilePath = path.join(dataDir, `monitor-log-${new Date().toISOString().replace(/:/g, '-')}.json`);
        await fs.writeJson(logFilePath, log);
        console.log(`Registro de transacción detectada guardado en ${logFilePath}`);
      }
    } catch (error) {
      console.error('Error al guardar registro de monitoreo:', error);
      logToFile('Error al guardar registro de monitoreo', error);
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
        
        // Preparar datos comunes para notificaciones
        const notificationData = {
          addressId,
          oldBalance: oldBalance.toString(),
          newBalance: newBalance.toString(),
          difference,
          type: isIncoming ? 'incoming' : 'outgoing',
          timestamp: new Date().toISOString()
        };
        
        // Notificar a todos los usuarios que siguen esta dirección
        for (const socketId of tracked.users) {
          console.log(`Enviando notificación a socket ${socketId}`);
          
          // Verificar si el socket existe para notificaciones Chrome
          if (io.sockets.sockets.has(socketId)) {
            // Verificar las preferencias de notificación del usuario
            const userConfig = tracked.notificationConfigs && tracked.notificationConfigs.get(socketId);
            
            // Siempre enviar a través de Socket.IO para clientes conectados (para la notificación Chrome)
            io.to(socketId).emit('transactionDetected', notificationData);
            console.log(`Notificación Socket.IO enviada correctamente a ${socketId}`);
            
            // Si hay configuración de notificación para este usuario
            if (userConfig) {
              // Enviar email si está configurado
              if (userConfig.email) {
                console.log(`Preparando email para ${userConfig.email}`);
                const emailSubject = `${isIncoming ? 'Nueva transacción entrante' : 'Nueva transacción saliente'} - Qubic Explorer`;
                const emailText = `${isIncoming ? 'Has recibido' : 'Se han enviado'} ${difference} QU ${isIncoming ? 'en' : 'desde'} la dirección ${addressId}`;
                const emailHtml = `
                  <h2>${isIncoming ? 'Nueva transacción entrante' : 'Nueva transacción saliente'}</h2>
                  <p>${isIncoming ? 'Has recibido' : 'Se han enviado'} <strong>${difference} QU</strong> ${isIncoming ? 'en' : 'desde'} la dirección:</p>
                  <p style="background-color: #f5f5f5; padding: 10px; font-family: monospace;">${addressId}</p>
                  <p>Balance anterior: ${oldBalance} QU</p>
                  <p>Balance actual: ${newBalance} QU</p>
                  <p>Fecha: ${new Date().toLocaleString()}</p>
                  <hr>
                  <p style="color: #666; font-size: 12px;">Este es un mensaje automático del sistema de notificaciones de Qubic Explorer.</p>
                `;
                
                sendEmail(userConfig.email, emailSubject, emailText, emailHtml)
                  .then(success => {
                    if (success) {
                      logToFile(`Email enviado correctamente a ${userConfig.email}`, {
                        addressId,
                        difference,
                        type: isIncoming ? 'incoming' : 'outgoing'
                      });
                    } else {
                      logToFile(`Error al enviar email a ${userConfig.email}`);
                    }
                  })
                  .catch(err => logToFile(`Error al enviar email a ${userConfig.email}`, err));
              }
              
              // Enviar notificación de Telegram si está configurado
              if (userConfig.telegram && telegramBot) {
                console.log(`Preparando notificación de Telegram para usuario con nombre: ${userConfig.telegram}`);
                
                // Aquí deberíamos implementar un sistema para mapear usernames a chat_ids
                // Por ahora, si el nombre de Telegram coincide con el del admin, usamos su ID
                const userTelegramId = ADMIN_TELEGRAM_USER_ID;
                
                if (userTelegramId) {
                  const telegramMessage = `
🔔 *${isIncoming ? 'Nueva transacción entrante' : 'Nueva transacción saliente'}*

${isIncoming ? '✅ Has recibido' : '⬆️ Se han enviado'} *${difference} QU* ${isIncoming ? 'en' : 'desde'} la dirección:
\`${addressId}\`

💰 Balance anterior: ${oldBalance} QU
💰 Balance actual: ${newBalance} QU
🕒 Fecha: ${new Date().toLocaleString()}
                  `;
                  
                  sendTelegramNotification(userTelegramId, telegramMessage)
                    .catch(err => logToFile(`Error al enviar notificación a Telegram (${userTelegramId})`, err));
                }
              }
            }
          } else {
            console.warn(`Socket ${socketId} ya no está conectado, no se envió notificación Socket.IO`);
            // Eliminar usuario desconectado
            tracked.users.delete(socketId);
            if (tracked.notificationConfigs) {
              tracked.notificationConfigs.delete(socketId);
            }
          }
        }
        
        // Actualizar el balance almacenado
        trackedAddresses.get(addressId).balance = newBalance.toString();
        
        // Mantener compatibilidad con el sistema anterior de telegramUsers
        if (tracked.telegramUsers && tracked.telegramUsers.size > 0) {
          console.log(`Enviando notificaciones a ${tracked.telegramUsers.size} usuarios de Telegram (sistema antiguo)`);
          
          const type = isIncoming ? 'entrante' : 'saliente';
          const emoji = isIncoming ? '🟢' : '🔴';
          
          const message = `
${emoji} <b>Transacción ${type} detectada</b>

<b>Dirección:</b> ${addressId}
<b>Cambio:</b> ${difference} QU
<b>Balance anterior:</b> ${oldBalance} QU
<b>Nuevo balance:</b> ${newBalance} QU
<b>Fecha:</b> ${new Date().toLocaleString()}
`;
          
          for (const chatId of tracked.telegramUsers) {
            sendTelegramNotification(chatId, message)
              .catch(err => logToFile(`Error al enviar notificación a Telegram (chat ${chatId})`, err));
          }
        }
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

// Inicializar el bot de Telegram al inicio
(async () => {
  telegramBot = await initTelegramBot();
})();

// Inicializar servicios
async function initialize() {
  // Inicializar transporter de email
  await initializeEmailTransporter();
  
  // Iniciar el servidor HTTP
  server.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
  });
  
  // Iniciar el bot de Telegram si se ha configurado
  telegramBot = await initTelegramBot();
  
  // Iniciar verificación de cambios
  setTimeout(checkAddressChanges, 5000);
}

// Iniciar todo
initialize(); 