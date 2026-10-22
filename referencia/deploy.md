# ☁️ Guía Paso a Paso: Configuración de AWS Lambda, API Gateway y Function URL

**Proyecto:** `mcp-lead-sales-automation` (CaloloDev Remote MCP)  
**Región AWS:** `us-east-2` (Ohio)  
**Autor:** CaloloDev & Antigravity AI  
**Estado:** Producción 100% Verificado  

---

## 📋 Índice
1. [Creación y Configuración de AWS Lambda](#1-creación-y-configuración-de-aws-lambda)
2. [Configuración de la URL de Función (Function URL - Ruta Principal)](#2-configuración-de-la-url-de-función-function-url---ruta-principal)
3. [Configuración de AWS API Gateway REST API & Dominio Personalizado](#3-configuración-de-aws-api-gateway-rest-api--dominio-personalizado)
4. [Configuración de Servicios Auxiliares (DynamoDB & AWS SES)](#4-configuración-de-servicios-auxiliares-dynamodb--aws-ses)
5. [Empaquetado y Actualización de Código (ZIP)](#5-empaquetado-y-actualización-de-código-zip)
6. [Resumen de Variables de Entorno](#6-resumen-de-variables-de-entorno)

---

## 1. Creación y Configuración de AWS Lambda

### A. Crear la Función Lambda
1. Ingresa a la consola de AWS y ve a **AWS Lambda** (Asegúrate de estar en la región **us-east-2 Ohio**).
2. Haz clic en **Crear una función** (*Create function*).
3. Selecciona **Autor desde cero** (*Author from scratch*).
4. **Nombre de la función:** `mcp-lead-sales-automation`
5. **Runtime (Tiempo de ejecución):** Node.js 20.x o superior.
6. **Arquitectura:** `x86_64`.
7. Haz clic en **Crear función**.

### B. Ajustes Generales y de Rendimiento
1. En la pestaña **Configuración** (*Configuration*) -> **Configuración general** (*General configuration*) -> **Editar**:
   - **Memoria:** `1024 MB`
   - **Tiempo de espera (Timeout):** `30 segundos`
   - **Controlador (Handler):** `dist/lambda.handler`
2. Haz clic en **Guardar**.

---

## 2. Configuración de la URL de Función (Function URL - Ruta Principal)

Claude Web y Claude Desktop requieren comunicación HTTP directa y limpia para el flujo OAuth 2.0 y mensajes JSON-RPC.

### A. Crear la URL de Función
1. En la consola de tu función Lambda `mcp-lead-sales-automation`, ve a **Configuración** -> **URL de función** (*Function URL*).
2. Haz clic en **Crear URL de función** (*Create Function URL*).
3. Configura exactamente los siguientes parámetros:
   - **Tipo de autorización:** `NONE` (Público, para permitir la comunicación desde la infraestructura de Anthropic).
4. En **Configuración adicional**:
   - **Modo de invocación:** **`BUFFERED (predeterminado)`** 👈 *(Crucial: Este modo entrega el formato JSON nativo de tokens OAuth sin envoltorios que causen errores de autenticación)*.
5. Marca la casilla **Configurar el uso compartido de recursos entre orígenes (CORS)**:
   - **Permitir origen (Allow origins):** `*`
   - **Exponer encabezados (Expose headers):** `*`
   - **Permitir encabezados (Allow headers):** `*`
   - **Permitir métodos (Allow methods):** `*` (o marca `GET`, `POST`, `OPTIONS`).
6. Haz clic en **Guardar**.

### B. URL Resultante Generada
AWS creará una URL segura HTTPS del tipo:
```text
https://fuz7dedw3cyvuff4fdhn4ntbri0houeh.lambda-url.us-east-2.on.aws/
```

La dirección remota para registrar en Claude Web/Desktop es:
```text
https://fuz7dedw3cyvuff4fdhn4ntbri0houeh.lambda-url.us-east-2.on.aws/mcp
```

---

## 3. Configuración de AWS API Gateway REST API & Dominio Personalizado

Si deseas exponer la API a través de un dominio propio (ej. `https://mcp.calolomino.dev/mcp`):

### A. Crear la API REST
1. Ve a **AWS API Gateway** -> **Crear API** -> Selecciona **REST API** (Construir).
2. **Nombre de la API:** `mcp-sales-rest-api`.
3. **Tipo de extremo:** Regional.
4. Haz clic en **Crear API**.

### B. Crear Recurso Proxy y Métodos
1. En **Recursos**, haz clic en **Crear recurso**:
   - Marca **Recurso proxy** (*Proxy resource*).
   - **Ruta de acceso:** `{proxy+}`.
   - Marca **Habilitar CORS en el API Gateway**.
   - Haz clic en **Crear recurso**.
2. En la integración del recurso proxy `{proxy+}`:
   - **Tipo de integración:** Integración Lambda Proxy (*Lambda Proxy integration*).
   - **Región Lambda:** `us-east-2`.
   - **Función Lambda:** `mcp-lead-sales-automation`.
   - Haz clic en **Guardar**.

### C. Tipos de Medios Binarios (Binary Media Types)
1. Ve a **Configuración de la API** (*API Settings*).
2. En **Tipos de medios binarios** (*Binary Media Types*), agrega `*/*` o `text/event-stream`.
3. Guarda los cambios.

### D. Desplegar la API
1. Haz clic en **Acciones** / **Desplegar API** (*Deploy API*).
2. **Etapa de despliegue:** `prod`.
3. Guarda el Endpoint HTTPS (ej. `https://u4viehrci6.execute-api.us-east-2.amazonaws.com/prod/`).

### E. Configurar Dominio Personalizado (`mcp.calolomino.dev`)
1. Ve a **API Gateway** -> **Nombres de dominio personalizados** (*Custom Domain Names*).
2. Haz clic en **Crear**:
   - **Nombre de dominio:** `mcp.calolomino.dev`
   - **Certificado ACM:** Certificado SSL emitido por ACM en `us-east-2`.
3. En **Mapeos de rutas de API** (*API mappings*):
   - **API:** `mcp-sales-rest-api`
   - **Etapa:** `prod`
   - **Ruta de acceso (Path):** `mcp`
4. En **Route 53**, crea un registro tipo `A` o `CNAME` apuntando `mcp.calolomino.dev` hacia el nombre de dominio de destino de API Gateway (`d-u4viehrci6.execute-api.us-east-2.amazonaws.com`).

---

## 4. Configuración de Servicios Auxiliares (DynamoDB & AWS SES)

### A. Tabla en Amazon DynamoDB
1. Ve a **Amazon DynamoDB** -> **Tablas** -> **Crear tabla**.
2. **Nombre de la tabla:** `mpc_leads`
3. **Clave de partición (Partition key):** `leadId` (Tipo: String `S`).
4. Configuración de capacidad: En la carta a petición (*On-Demand*).
5. Haz clic en **Crear tabla**.

### B. Identidad Verificada en AWS SES
1. Ve a **Amazon Simple Email Service (SES)** -> **Identidades** -> **Crear identidad**.
2. **Tipo de identidad:** Dirección de correo electrónico (*Email address*).
3. **Correo:** `contacto@calolomino.dev`
4. Revisa la bandeja de entrada y haz clic en el enlace de verificación enviado por AWS.

---

## 5. Empaquetado y Actualización de Código (ZIP)

Para compilar el proyecto TypeScript y generar el paquete listo para desplegar:

1. En la raíz del repositorio local (`c:\codigos\otros\mpc_google_cv`), ejecuta en PowerShell:
   ```powershell
   powershell -ExecutionPolicy Bypass -File build_zip.ps1
   ```
2. El script realizará:
   - `npm run build` (Compila `.ts` a JavaScript en `dist/`).
   - Copia `node_modules` de producción y `package.json`.
   - Genera el paquete zip empaquetado **`function.zip`** (~16.6 MB).

3. **Subir a AWS Lambda:**
   - Ve a tu función en **AWS Lambda** -> `mcp-lead-sales-automation`.
   - Haz clic en **Cargar desde** (*Upload from*) -> **Archivo .zip** (*.zip file*).
   - Selecciona `function.zip` y haz clic en **Guardar**.

---

## 6. Resumen de Variables de Entorno

En la pestaña **Configuración** -> **Variables de entorno** de AWS Lambda, debes tener configuradas las siguientes variables:

| Variable | Ejemplo de Valor | Descripción |
| :--- | :--- | :--- |
| `GOOGLE_PLACES_API_KEY` | `AIzaSyA5...` | Clave API de Google Places (New) |
| `GEMINI_API_KEY` | `AIzaSyBD...` | Clave API de Google Gemini 2.5 Flash |
| `AWS_REGION` | `us-east-2` | Región AWS de infraestructura |
| `DYNAMODB_TABLE_LEADS` | `mpc_leads` | Nombre de la tabla de DynamoDB |
| `SES_SENDER_EMAIL` | `contacto@calolomino.dev` | Correo remitente verificado en AWS SES |
| `PORT` | `3000` | Puerto interno Express |

---

## 🛠️ Verificación y Pruebas de Salud (Health Checks)

Puedes validar el funcionamiento de los endpoints directamente realizando peticiones GET:

* **Health Check Lambda:**
  `GET https://fuz7dedw3cyvuff4fdhn4ntbri0houeh.lambda-url.us-east-2.on.aws/health`
  *Respuesta:* `{"status":"ok","service":"mcp-lead-sales-automation", ...}`

* **Descubrimiento OAuth 2.0:**
  `GET https://fuz7dedw3cyvuff4fdhn4ntbri0houeh.lambda-url.us-east-2.on.aws/.well-known/oauth-authorization-server`
  *Respuesta:* JSON con endpoints `/authorize`, `/token`, `/register`.

* **Stateless MCP JSON-RPC:**
  `POST https://fuz7dedw3cyvuff4fdhn4ntbri0houeh.lambda-url.us-east-2.on.aws/mcp`
  *(Con body `{"jsonrpc":"2.0", "id":1, "method":"tools/list"}`)*
  *Respuesta:* Lista de las 6 herramientas MCP en JSON.