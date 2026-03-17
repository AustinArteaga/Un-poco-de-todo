require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CW_BASE      = process.env.CW_BASE_URL;
const CW_TOKEN     = process.env.CW_API_TOKEN;
const CW_ACCOUNT   = process.env.CW_ACCOUNT_ID;
const CW_INBOX_ID  = process.env.CW_INBOX_ID;
const POLL_MS      = parseInt(process.env.POLL_MS) || 8000;

// Etiquetas que actúan como ETAPAS del CRM (separadas por coma en .env)
// Ejemplo: CRM_STAGES=nuevo_lead,contactado,interesado,propuesta,cerrado,perdido
// Si no se define, TODAS las etiquetas de Chatwoot se usan como etapas
const CRM_STAGES_ENV = process.env.CRM_STAGES
  ? process.env.CRM_STAGES.split(',').map(s => s.trim().toLowerCase())
  : null;

// ─── ALMACÉN LOCAL ─────────────────────────────────────────────────────────────
const contactosCache = {};   // { cw_contact_id: { id, nombre, numero, ... } }
const conversaciones = {};   // { numero: [{tipo, texto, timestamp, cw_id}] }
const clientes = {};         // { numero: { nombre, etiquetas, notas, crmColumna, ... } }
const conversacionCwMap = {}; // { cw_conversation_id: numero }

let ultimoFetch = {};        // { conversation_id: last_message_id }

// Columnas CRM — se construyen dinámicamente desde etiquetasDisponibles (Chatwoot)
// Ya no hay columnas hardcodeadas

// Etiquetas dinámicas — se cargan desde Chatwoot al arrancar
let etiquetasDisponibles = [];

async function cargarEtiquetasChatwoot() {
  try {
    const data = await cwGet('/labels');
    etiquetasDisponibles = (data.payload || []).map(l => ({
      id:     l.title,
      nombre: l.title,
      color:  l.color || '#6b7280',
    }));
    console.log(`🏷  ${etiquetasDisponibles.length} etiquetas cargadas desde Chatwoot`);
  } catch (e) {
    console.warn('⚠️  No se pudieron cargar etiquetas de Chatwoot:', e.message);
  }
}

// ─── RESPUESTAS RÁPIDAS ────────────────────────────────────────────────────────
let respuestasRapidas = [
  { id: 'r1', titulo: 'Saludo',     texto: '¡Hola! 👋 ¿En qué te puedo ayudar hoy?' },
  { id: 'r2', titulo: 'Disponible', texto: 'Estamos disponibles de lunes a viernes de 8am a 6pm.' },
  { id: 'r3', titulo: 'Gracias',    texto: '¡Muchas gracias por contactarnos! 😊' },
  { id: 'r4', titulo: 'Espera',     texto: 'Un momento, estoy revisando tu consulta...' },
];

// ─── HELPERS CHATWOOT ──────────────────────────────────────────────────────────
function cwHeaders() {
  return { 'api_access_token': CW_TOKEN, 'Content-Type': 'application/json' };
}

async function cwGet(path, params = {}) {
  const url = `${CW_BASE}/api/v1/accounts/${CW_ACCOUNT}${path}`;
  const res = await axios.get(url, { headers: cwHeaders(), params });
  return res.data;
}

async function cwPost(path, data) {
  const url = `${CW_BASE}/api/v1/accounts/${CW_ACCOUNT}${path}`;
  const res = await axios.post(url, data, { headers: cwHeaders() });
  return res.data;
}

// ─── SYNC CONVERSACIONES DESDE CHATWOOT ───────────────────────────────────────
function normalizePhone(raw = '') {
  // Chatwoot puede devolver el número con + o sin él
  return raw.replace(/\D/g, '');
}

async function syncConversacion(conv) {
  const contacto = conv.meta?.sender;
  if (!contacto) return;

  const key = `cw_${contacto.id}`;
  let nombre = contacto.name || key;
  let telefono = '';

  try {
    const cData = await cwGet(`/contacts/${contacto.id}`);
    nombre = cData.name || contacto.name || key;

    // Teléfono
    const candidatos = [
      cData.phone_number,
      cData.additional_attributes?.phone_number,
      cData.identifier,
      conv.meta?.sender?.phone_number,
      /^\+?\d{7,15}$/.test(cData.name) ? cData.name : null,
    ];
    for (const c of candidatos) {
      const n = normalizePhone(c || '');
      if (n.length >= 7) { telefono = n; break; }
    }

    contactosCache[contacto.id] = { id: contacto.id, nombre, telefono };
  } catch (e) {
    contactosCache[contacto.id] = { id: contacto.id, nombre, telefono: '' };
  }

  const numero = key; // clave interna siempre estable
  conversacionCwMap[conv.id] = numero;

  if (!conversaciones[numero]) conversaciones[numero] = [];
  if (!clientes[numero]) {
    clientes[numero] = {
      numero,
      nombre,
      telefono,
      etiquetas: [],   // manejado localmente desde el portal
      notas: '',
      canal: 'WhatsApp',
      fechaRegistro: new Date().toISOString(),
      cw_conversation_id: conv.id,
      cw_contact_id: contacto.id,
    };
  } else {
    if (nombre && nombre !== key) clientes[numero].nombre = nombre;
    if (telefono) clientes[numero].telefono = telefono;
    clientes[numero].cw_conversation_id = conv.id;
    // NO sobreescribir etiquetas — se manejan desde el portal
  }

  // Traer mensajes de esta conversación
  try {
    const params = {};
    if (ultimoFetch[conv.id]) params.before = ultimoFetch[conv.id];

    const msgData = await cwGet(`/conversations/${conv.id}/messages`);
    const msgs = msgData.payload || [];

    // Ordenar por id ascendente
    msgs.sort((a, b) => a.id - b.id);

    let nuevoUltimo = ultimoFetch[conv.id] || 0;

    for (const m of msgs) {
      if (m.id <= (ultimoFetch[conv.id] || 0)) continue;
      if (!m.content) continue;

      const yaExiste = conversaciones[numero].some(x => x.cw_id === m.id);
      if (yaExiste) continue;

      const tipo = m.message_type === 1 ? 'enviado' : 'recibido';
      const ts   = new Date(m.created_at * 1000).toISOString();

      conversaciones[numero].push({ tipo, texto: m.content, timestamp: ts, cw_id: m.id });

      const tsLocal = new Date(m.created_at * 1000).toLocaleString('es-EC');
      const linea   = tipo === 'recibido'
        ? `Recibido de ${numero} (${tsLocal}): ${m.content}\n`
        : `Enviado a ${numero} (${tsLocal}): ${m.content}\n`;
      fs.appendFileSync('mensajes.txt', linea);

      if (m.id > nuevoUltimo) nuevoUltimo = m.id;
    }
    ultimoFetch[conv.id] = nuevoUltimo;
  } catch (e) {
    console.error(`❌ Mensajes conv ${conv.id}:`, e.message);
  }
}

async function pollChatwoot() {
  if (!CW_BASE || !CW_TOKEN || !CW_ACCOUNT) return;
  try {
    const params = { page: 1, status: 'open' };
    if (CW_INBOX_ID) params.inbox_id = CW_INBOX_ID;

    const data = await cwGet('/conversations', params);
    const convs = data.data?.payload || [];

    for (const conv of convs) {
      await syncConversacion(conv);
    }
    console.log(`🔄 Sync: ${convs.length} conversaciones · ${Object.keys(clientes).length} contactos`);
  } catch (e) {
    console.error('❌ Poll error:', e.response?.data?.message || e.message);
  }
}

// Arrancar polling si hay config
if (CW_BASE && CW_TOKEN && CW_ACCOUNT) {
  cargarEtiquetasChatwoot();           // carga etiquetas al arrancar
  setInterval(cargarEtiquetasChatwoot, 60 * 60 * 1000); // refresca cada hora
  pollChatwoot();
  setInterval(pollChatwoot, POLL_MS);
  console.log(`⚡ Polling Chatwoot cada ${POLL_MS}ms`);
} else {
  console.warn('⚠️  CW_BASE_URL / CW_API_TOKEN / CW_ACCOUNT_ID no configurados en .env');
}

// ─── WEBHOOK DESDE n8n → SINCRONIZAR ETAPA CRM ────────────────────────────────
// En n8n: HTTP Request → POST → https://TU_URL/api/n8n/etapa
// Body:
// {
//   "telefono": "593998173870",       ← número del contacto
//   "etiqueta_nueva": "remarketing",  ← etiqueta que n8n acaba de agregar (o null)
//   "etiqueta_anterior": "interesado" ← etiqueta que n8n acaba de quitar (o null)
// }

const N8N_SECRET = process.env.N8N_SECRET || ''; // opcional: clave para autenticar n8n

app.post('/api/n8n/etapa', (req, res) => {
  // Verificación opcional con secret
  if (N8N_SECRET) {
    const auth = req.headers['x-n8n-secret'] || req.body.secret;
    if (auth !== N8N_SECRET) return res.status(401).json({ error: 'No autorizado' });
  }

  const { telefono, etiqueta_nueva, etiqueta_anterior, cw_contact_id } = req.body;

  // Buscar cliente por teléfono o por cw_contact_id
  let cliente = null;
  if (telefono) {
    const tel = String(telefono).replace(/\D/g, '');
    cliente = Object.values(clientes).find(c => c.telefono === tel);
  }
  if (!cliente && cw_contact_id) {
    cliente = Object.values(clientes).find(c => String(c.cw_contact_id) === String(cw_contact_id));
  }

  if (!cliente) {
    console.log(`⚠️  n8n: contacto no encontrado (tel: ${telefono}, cw_id: ${cw_contact_id})`);
    return res.status(404).json({ error: 'Contacto no encontrado en CRM', telefono, cw_contact_id });
  }

  // Mapeo etiqueta Chatwoot → columna CRM local
  const mapaEtapas = {
    'nuevo_lead':  'nuevo_lead',
    'nuevo lead':  'nuevo_lead',
    'contactado':  'contactado',
    'interesado':  'interesado',
    'remarketing': 'remarketing',
    'humano':      'interesado',  // cuando la IA detecta interés y llama a humano
    'perdido':     'nuevo_lead',  // perdido → vuelve a nuevo lead en tu CRM
  };

  const etapaAnterior = cliente.crmColumna;

  // Aplicar nueva etapa si viene
  if (etiqueta_nueva) {
    const clave = etiqueta_nueva.toLowerCase().trim();
    const columna = mapaEtapas[clave];
    if (columna) {
      cliente.crmColumna = columna;
      console.log(`✅ n8n: ${cliente.nombre} → ${etapaAnterior} ▶ ${columna}`);
    } else {
      console.log(`ℹ️  n8n: etiqueta "${etiqueta_nueva}" no mapea a columna CRM (ignorada)`);
    }
  }

  // Si solo quita etiqueta y no pone nueva, volver a nuevo_lead
  if (!etiqueta_nueva && etiqueta_anterior) {
    const clave = etiqueta_anterior.toLowerCase().trim();
    if (mapaEtapas[clave] && cliente.crmColumna === mapaEtapas[clave]) {
      cliente.crmColumna = 'nuevo_lead';
      console.log(`↩️  n8n: ${cliente.nombre} quitó "${etiqueta_anterior}" → nuevo_lead`);
    }
  }

  res.json({
    ok: true,
    nombre: cliente.nombre,
    telefono: cliente.telefono,
    etapa_anterior: etapaAnterior,
    etapa_actual: cliente.crmColumna,
  });
});

// ─── ENVIAR MENSAJE VÍA CHATWOOT ───────────────────────────────────────────────
async function enviarMensajeVia(numero, texto) {
  // Buscar conversation_id
  const cwConvId = clientes[numero]?.cw_conversation_id;
  if (!cwConvId) throw new Error('No se encontró conversación en Chatwoot para ' + numero);

  await cwPost(`/conversations/${cwConvId}/messages`, {
    content: texto,
    message_type: 'outgoing',
    private: false,
  });
  console.log(`✅ Enviado a ${numero}: "${texto}"`);
}

// ─── API CHATS ────────────────────────────────────────────────────────────────
app.get('/api/chats', (req, res) => {
  const list = Object.entries(conversaciones).map(([numero, msgs]) => {
    const ultimo  = msgs[msgs.length - 1];
    const cliente = clientes[numero] ?? {};
    const noLeidos = msgs.filter(m => m.tipo === 'recibido' && !m.leido).length;
    return {
      numero,
      ultimoMensaje: ultimo?.texto ?? '',
      timestamp: ultimo?.timestamp ?? '',
      total: msgs.length,
      nombre: cliente.nombre ?? '',
      telefono: cliente.telefono ?? '',
      etiquetas: cliente.etiquetas ?? [],
      noLeidos,
    };
  }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(list);
});

app.get('/api/chats/:numero', (req, res) => {
  const msgs = conversaciones[req.params.numero] ?? [];
  // Marcar como leídos
  msgs.forEach(m => { if (m.tipo === 'recibido') m.leido = true; });
  res.json(msgs);
});

app.post('/api/enviar', async (req, res) => {
  const { numero, texto } = req.body;
  if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' });
  try {
    await enviarMensajeVia(numero, texto);
    const ts = new Date().toISOString();
    if (!conversaciones[numero]) conversaciones[numero] = [];
    conversaciones[numero].push({ tipo: 'enviado', texto, timestamp: ts });
    const tsLocal = new Date().toLocaleString('es-EC');
    fs.appendFileSync('mensajes.txt', `Enviado a ${numero} (${tsLocal}): ${texto}\n`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API CLIENTES / CRM ───────────────────────────────────────────────────────
app.get('/api/clientes', (req, res) => res.json(Object.values(clientes)));

app.get('/api/clientes/:numero', (req, res) => {
  const c = clientes[req.params.numero];
  if (!c) return res.status(404).json({ error: 'No encontrado' });
  res.json(c);
});

app.put('/api/clientes/:numero', (req, res) => {
  const num = req.params.numero;
  if (!clientes[num]) clientes[num] = { numero: num, fechaRegistro: new Date().toISOString(), crmColumna: 'nuevo' };
  Object.assign(clientes[num], req.body);
  res.json(clientes[num]);
});

app.post('/api/clientes', (req, res) => {
  const { numero, nombre, etiquetas, notas, canal, crmColumna } = req.body;
  if (!numero) return res.status(400).json({ error: 'Número requerido' });
  clientes[numero] = {
    numero, nombre: nombre ?? '', etiquetas: etiquetas ?? [],
    notas: notas ?? '', canal: canal ?? 'Manual',
    fechaRegistro: new Date().toISOString(), crmColumna: crmColumna ?? 'nuevo',
  };
  if (!conversaciones[numero]) conversaciones[numero] = [];
  res.json(clientes[numero]);
});

// Columnas CRM — locales, independientes de Chatwoot
const crmColumnas = {
  'nuevo_lead':  { nombre: 'Nuevo Lead',  color: '#4a9eff', orden: 0 },
  'contactado':  { nombre: 'Contactado',  color: '#f59e0b', orden: 1 },
  'interesado':  { nombre: 'Interesado',  color: '#8b5cf6', orden: 2 },
  'remarketing': { nombre: 'Remarketing', color: '#f97316', orden: 3 },
};

app.get('/api/crm/columnas', (req, res) => res.json(crmColumnas));

app.patch('/api/crm/mover', (req, res) => {
  const { numero, columna } = req.body;
  const cliente = clientes[numero];
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  cliente.crmColumna = columna;
  res.json({ ok: true });
});

app.get('/api/crm/leads', (req, res) => {
  const result = {};
  Object.keys(crmColumnas).forEach(k => result[k] = []);
  Object.values(clientes).forEach(c => {
    const col = c.crmColumna || 'nuevo_lead';
    if (result[col]) result[col].push(c);
  });
  res.json(result);
});

// ─── API RESPUESTAS RÁPIDAS ────────────────────────────────────────────────────
app.get('/api/respuestas', (req, res) => res.json(respuestasRapidas));

app.post('/api/respuestas', (req, res) => {
  const { titulo, texto } = req.body;
  if (!titulo || !texto) return res.status(400).json({ error: 'Faltan datos' });
  const r = { id: `r${Date.now()}`, titulo, texto };
  respuestasRapidas.push(r);
  res.json(r);
});

app.delete('/api/respuestas/:id', (req, res) => {
  respuestasRapidas = respuestasRapidas.filter(r => r.id !== req.params.id);
  res.json({ ok: true });
});

// ─── DEBUG: ver etiquetas raw de un contacto en Chatwoot ─────────────────────
app.get('/api/debug/contacto/:cw_id', async (req, res) => {
  try {
    const [info, labels] = await Promise.all([
      cwGet(`/contacts/${req.params.cw_id}`),
      cwGet(`/contacts/${req.params.cw_id}/labels`),
    ]);
    res.json({
      name:          info.name,
      phone:         info.phone_number,
      labels_en_info: info.labels,
      labels_endpoint: labels,
      cache:         contactosCache[req.params.cw_id],
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ─── API ETIQUETAS (desde Chatwoot) ──────────────────────────────────────────
app.get('/api/etiquetas', (req, res) => res.json(etiquetasDisponibles));

// Devuelve etiquetas separadas en etapas CRM y tags adicionales
app.get('/api/etiquetas/separadas', (req, res) => {
  if (CRM_STAGES_ENV) {
    // El usuario definió cuáles son etapas
    const etapas = etiquetasDisponibles.filter(e => CRM_STAGES_ENV.includes(e.id.toLowerCase()));
    const tags   = etiquetasDisponibles.filter(e => !CRM_STAGES_ENV.includes(e.id.toLowerCase()));
    return res.json({ etapas, tags });
  }
  // Sin config: todas son etapas, ninguna es tag adicional
  res.json({ etapas: etiquetasDisponibles, tags: [] });
});

// PUT /api/clientes/:numero/etiquetas  →  guarda etiquetas en Chatwoot y local
app.put('/api/clientes/:numero/etiquetas', async (req, res) => {
  const num    = req.params.numero;
  const cliente = clientes[num];
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  const { etiquetas } = req.body; // array de strings ej: ['vip','urgente']
  if (!Array.isArray(etiquetas)) return res.status(400).json({ error: 'etiquetas debe ser un array' });

  // Guardar en Chatwoot si tenemos el contact_id
  if (cliente.cw_contact_id) {
    try {
      await axios.post(
        `${CW_BASE}/api/v1/accounts/${CW_ACCOUNT}/contacts/${cliente.cw_contact_id}/labels`,
        { labels: etiquetas },
        { headers: cwHeaders() }
      );
    } catch (e) {
      console.error('❌ Error guardando etiquetas en Chatwoot:', e.response?.data?.message || e.message);
      // No bloqueamos — guardamos local igualmente
    }
  }

  cliente.etiquetas = etiquetas;
  res.json({ ok: true, etiquetas });
});
app.get('/api/status', (req, res) => res.json({
  chatwoot: !!(CW_BASE && CW_TOKEN && CW_ACCOUNT),
  meta: !!(META_TOKEN && META_PHONE_ID && META_WABA_ID),
  cw_base: CW_BASE,
  poll_ms: POLL_MS,
  conversaciones: Object.keys(conversaciones).length,
  clientes: Object.keys(clientes).length,
}));

// ─── META CREDENTIALS ────────────────────────────────────────────────────────
const META_TOKEN    = process.env.ACCESS_TOKEN;
const META_PHONE_ID = process.env.PHONE_ID;
const META_WABA_ID  = process.env.WABA_ID; // WhatsApp Business Account ID

// ─── API CAMPAÑAS ─────────────────────────────────────────────────────────────

// GET /api/campanas/plantillas  →  lista plantillas aprobadas de Meta
app.get('/api/campanas/plantillas', async (req, res) => {
  if (!META_TOKEN || !META_WABA_ID) {
    return res.status(400).json({ error: 'Faltan ACCESS_TOKEN o WABA_ID en .env' });
  }
  try {
    const url = `https://graph.facebook.com/v21.0/${META_WABA_ID}/message_templates`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${META_TOKEN}` },
      params: { fields: 'name,status,language,components,category', limit: 100 },
    });
    // Solo las aprobadas
    const aprobadas = (data.data || []).filter(t => t.status === 'APPROVED');
    res.json(aprobadas);
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// GET /api/campanas/destinatarios?etapa=remarketing  →  clientes de esa etapa con teléfono
app.get('/api/campanas/destinatarios', (req, res) => {
  const etapa = (req.query.etapa || 'remarketing').toLowerCase();
  const lista = Object.values(clientes).filter(c =>
    (c.crmColumna || '').toLowerCase() === etapa && c.telefono
  ).map(c => ({ numero: c.numero, nombre: c.nombre, telefono: c.telefono, crmColumna: c.crmColumna }));
  res.json(lista);
});

// Mantener endpoint anterior por compatibilidad
app.get('/api/campanas/interesados', (req, res) => {
  const lista = Object.values(clientes).filter(c =>
    (c.crmColumna || '').toLowerCase() === 'remarketing' && c.telefono
  ).map(c => ({ numero: c.numero, nombre: c.nombre, telefono: c.telefono }));
  res.json(lista);
});

app.get('/api/campanas/label', (req, res) => res.json({ label: 'remarketing' }));

// Historial de campañas en memoria
const historialCampanas = [];

// POST /api/campanas/enviar  →  envío masivo
// Body: { templateName, languageCode, components, etapa, limpiarDespues }
app.post('/api/campanas/enviar', async (req, res) => {
  if (!META_TOKEN || !META_PHONE_ID) {
    return res.status(400).json({ error: 'Faltan ACCESS_TOKEN o PHONE_ID en .env' });
  }
  const { templateName, languageCode, components, etapa, limpiarDespues } = req.body;
  if (!templateName) return res.status(400).json({ error: 'Falta templateName' });

  const etapaFiltro = (etapa || 'remarketing').toLowerCase();

  const destinatarios = Object.values(clientes).filter(c =>
    (c.crmColumna || '').toLowerCase() === etapaFiltro && c.telefono
  );

  if (!destinatarios.length) {
    return res.status(400).json({ error: `No hay clientes en "${etapaFiltro}" con teléfono registrado` });
  }

  const url     = `https://graph.facebook.com/v21.0/${META_PHONE_ID}/messages`;
  const headers = { Authorization: `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' };

  let enviados = 0, fallidos = 0;
  const detalles = [];
  const numerosEnviados = [];

  for (const cliente of destinatarios) {
    const body = {
      messaging_product: 'whatsapp',
      to: cliente.telefono,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'es' },
      },
    };
    if (components && components.length) body.template.components = components;

    try {
      await axios.post(url, body, { headers });
      enviados++;
      numerosEnviados.push(cliente.numero);
      detalles.push({ nombre: cliente.nombre, telefono: cliente.telefono, ok: true });
      console.log(`📤 ${etapaFiltro} → ${cliente.nombre} (${cliente.telefono})`);
    } catch (e) {
      fallidos++;
      const errMsg = e.response?.data?.error?.message || e.message;
      detalles.push({ nombre: cliente.nombre, telefono: cliente.telefono, ok: false, error: errMsg });
      console.error(`❌ Falló ${cliente.telefono}: ${errMsg}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Limpiar etapa de los enviados exitosamente (mover a nuevo_lead)
  if (limpiarDespues && numerosEnviados.length) {
    numerosEnviados.forEach(num => {
      if (clientes[num]) clientes[num].crmColumna = 'nuevo_lead';
    });
    console.log(`🧹 ${numerosEnviados.length} contactos movidos a nuevo_lead después del envío`);
  }

  const registro = {
    id: Date.now(),
    fecha: new Date().toISOString(),
    plantilla: templateName,
    etapa: etapaFiltro,
    limpioDespes: !!limpiarDespues,
    enviados,
    fallidos,
    total: destinatarios.length,
    detalles,
  };
  historialCampanas.unshift(registro);
  res.json(registro);
});

// GET /api/campanas/historial
app.get('/api/campanas/historial', (req, res) => res.json(historialCampanas));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));