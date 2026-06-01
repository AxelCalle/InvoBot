# WhatsApp → Claude → SISCON — Servidor intermediario

Bot de WhatsApp que recibe boletas y facturas electrónicas, extrae los datos usando Claude y los registra automáticamente en SISCON.

## Arquitectura

```
Usuario WhatsApp
      │  envía PDF/imagen/XML
      ▼
Meta Webhook (POST /webhook)
      │
      ▼
whatsapp.service.js  ──→  Descarga el archivo de Meta CDN
      │
      ▼
claude.service.js    ──→  Extrae datos (claude-sonnet-4)
      │
      ▼
Validación mínima    ──→  serie, número, RUC presentes
      │
      ▼
siscon.service.js    ──→  Verifica duplicado → Registra
      │
      ▼
Confirmación por WhatsApp
```

## Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env con tus credenciales

# 3. Probar sin WhatsApp
npm test                          # demo con datos ficticios
npm test -- ./mi-boleta.pdf       # con archivo real

# 4. Iniciar en producción
npm start

# 5. En desarrollo (auto-reload)
npm run dev
```

## Variables de entorno requeridas

| Variable | Descripción |
|----------|-------------|
| `WHATSAPP_TOKEN` | Token de acceso permanente de Meta Business |
| `WHATSAPP_PHONE_ID` | Phone Number ID de tu cuenta |
| `WHATSAPP_VERIFY_TOKEN` | Token secreto que tú defines para verificar el webhook |
| `ANTHROPIC_API_KEY` | API key de Anthropic (`sk-ant-...`) |
| `SISCON_BASE_URL` | URL base de la API REST de SISCON |
| `SISCON_API_KEY` | API key para autenticar contra SISCON |

## Configurar el webhook en Meta

1. En [Meta for Developers](https://developers.facebook.com) → tu app → WhatsApp → Webhooks
2. URL del callback: `https://tudominio.com/webhook`
3. Token de verificación: el valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
4. Suscribir a: `messages`

> Para desarrollo local usa [ngrok](https://ngrok.com): `ngrok http 3000`

## Adaptar a tu SISCON

El archivo `src/services/siscon.service.js` tiene dos puntos de adaptación:

1. **`transformToSisconFormat()`** — mapea los campos del JSON de Claude a los campos que espera tu API de SISCON
2. **`mapTipoComprobante()`** — ajusta los códigos de tipo de documento a los de tu sistema
3. **`checkDuplicate()`** — ajusta el endpoint de verificación según tu API

## Estructura de archivos

```
whatsapp-siscon/
├── config/
│   └── index.js              # Configuración centralizada
├── src/
│   ├── index.js              # Servidor Express (punto de entrada)
│   ├── test-demo.js          # Prueba local sin WhatsApp
│   ├── routes/
│   │   ├── webhook.route.js  # GET y POST /webhook
│   │   └── health.route.js   # GET /health
│   ├── services/
│   │   ├── whatsapp.service.js   # Meta API: descarga y envío
│   │   ├── claude.service.js     # Extracción con Claude API
│   │   ├── siscon.service.js     # Registro en SISCON
│   │   └── processor.service.js  # Orquestador del flujo
│   ├── middleware/
│   │   └── errorHandler.js   # Manejo de errores
│   └── utils/
│       └── logger.js         # Winston logger
├── .env.example
├── package.json
└── README.md
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/health` | Estado del servidor y credenciales |
| `GET` | `/webhook` | Verificación de Meta |
| `POST` | `/webhook` | Recibe mensajes de WhatsApp |

## Flujos de respuesta al usuario

| Situación | Respuesta |
|-----------|-----------|
| Mensaje "hola" / "ayuda" | Instrucciones de uso |
| Archivo recibido | "⏳ Procesando..." |
| Registro exitoso | Resumen con datos y nº SISCON |
| Archivo ilegible | Solicita imagen más nítida |
| Duplicado | Avisa que ya existe en SISCON |
| Error de conexión | Mensaje de error y retry |

## Producción (recomendaciones)

- Despliega en **Railway**, **Render**, **AWS EC2** o **VPS** con dominio HTTPS
- Configura **PM2** para reinicio automático: `pm2 start src/index.js --name siscon-bot`
- Los logs se guardan en `logs/combined.log` y `logs/error.log`
