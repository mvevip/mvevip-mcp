# 🧠 MEMORIA DE SESIÓN: Servidor Remote MCP MVEVIP para Claude

> **HISTÓRICO (7-oct-2026).** Describe la primera versión (clave corporativa, Docker local, herramientas genéricas de BD) que ya no existe.
> El estado vigente está en `ESTADO_PROYECTO.md` y la memoria técnica en `MEMORIA.md`.

**Fecha de la Sesión:** 7 de Octubre, 2026  
**Proyecto:** `mvevip_mcp` (`c:\codigos\mvevip\mvevip_mcp`)  
**Autor:** Pair Programming con CaloloDev & Antigravity AI  
**Estado Actual:** Servidor Dockerizado en puerto `6420`, 100% probado localmente, con flujo de seguridad obligatorio y paquete para AWS listo.

---

## 📌 1. Resumen de lo Realizado en la Sesión

### A. Arquitectura y Dockerización en Puerto 6420
* Se creó el servidor Remote MCP en **TypeScript/Express** con compatibilidad dual:
  * **Modo Contenedor Docker:** Escuchando en el puerto configurable **`6420`** vía `.env`.
  * **Modo AWS Lambda Serverless:** Listo para ejecutarse mediante `serverless-http` con Function URL en modo `BUFFERED`.
* Se crearon [`Dockerfile`](Dockerfile) (multi-stage Node.js 20 Alpine) y [`docker-compose.yml`](docker-compose.yml).
* El contenedor `mvevip_mcp_server` está actualmente levantado y operativo en `http://localhost:6420`.

### B. Flujo de Seguridad Obligatorio (OAuth 2.0 Login Gate)
* **Requerimiento cumplido:** Obligatoriedad de ingresar clave corporativa antes de permitir cualquier uso en Claude.
* **Pantalla de Confirmación:** [`src/auth/loginView.ts`](src/auth/loginView.ts) renderiza una interfaz web moderna con branding MVEVIP en `GET /authorize`.
* **Criptografía Stateless:** [`src/auth/tokenManager.ts`](src/auth/tokenManager.ts) valida la clave contra `MCP_ACCESS_KEY` y genera códigos temporales HMAC-SHA256 (TTL 5 min) y Bearer Tokens (30 días).
* **Manejo de Pruebas Manuales vs Claude:** Si el usuario entra manualmente al navegador a probar la clave (sin parámetro `state`), el servidor muestra una pantalla verde de confirmación; si la petición proviene de Claude, realiza la redirección oficial con `code` y `state`.
* Toda petición a `/mcp` sin Bearer token es rechazada con **HTTP 401**.

### C. Herramientas MCP Iniciales
1. **`test_db_connection`**: Función de prueba que evalúa ping, latencia, versión de MySQL, base de datos activa y tiempo del servidor.
2. **`describe_database`**: Entrega el catálogo de tablas con filas estimadas, tamaño y comentarios.
3. **`get_table_schema`**: Detalla columnas, tipos de datos, nulabilidad y claves de una tabla seleccionada.
4. **`query_database_sample`**: Ejecuta sentencias SQL de solo lectura (`SELECT`, `SHOW`, `DESCRIBE`) con límites de seguridad automáticos (evita mutaciones `INSERT`, `UPDATE`, `DELETE`).

### D. Batería de Pruebas Locales (100% Aprobada)
* Se creó [`scripts/test_local.js`](scripts/test_local.js) y [`scripts/test_local.ps1`](scripts/test_local.ps1).
* Se verificó:
  1. `GET /health` -> 200 OK (`service: mvevip-mcp-server`, `port: 6420`).
  2. `GET /authorize` -> Pantalla HTML renderizada correctamente.
  3. Rechazo de clave errónea -> 401 Unauthorized.
  4. Aceptación de clave correcta -> Generación de Auth Code.
  5. Emisión de Bearer Token en `/token`.
  6. Respuestas a `initialize`, `tools/list` y ejecución de las 4 herramientas en `/mcp`.

### E. Preparación para AWS con Perfil `marketingvip`
* [`build_zip.ps1`](build_zip.ps1): Generó el archivo optimizado `function.zip` (~2.76 MB).
* [`deploy_aws.ps1`](deploy_aws.ps1): Automatiza el despliegue a AWS Lambda con `--profile marketingvip`, configurando la Function URL en modo `BUFFERED` y CORS abierto.
* Verificación exitosa de credenciales de AWS CLI para la cuenta `021891594659` (usuario `admin-cli`).

---

## 💡 2. Concepto Clave Resuelto: ¿Cómo sabe Claude qué tablas y SQL usar?

Para consultas analíticas complejas como: *"Dame las ventas de esta semana por asesor y líder"*:
1. **Flujo Autónomo (Ya disponible):**  
   Claude invoca `describe_database` para ubicar las tablas de ventas y asesores, luego llama a `get_table_schema` para descubrir los nombres de campos y llaves foráneas (`id_asesor`, `id_lider`, etc.), y finalmente ejecuta el `SELECT` con `JOIN` y `GROUP BY` a través de `query_database_sample`.
2. **Flujo Optimizado de Negocio (Recomendado para mañana):**  
   Crear **herramientas dedicadas de negocio** (ej: `get_sales_by_advisor_and_leader`) con el SQL exacto y probado de la empresa (extraído de los modelos actuales de MVEVIP). Esto garantiza 100% de precisión en los cálculos contables y comisiones sin depender de que el LLM deduzca la lógica contable.

---

## 📋 3. Pendientes por Confirmar y Pasos para Mañana

1. **Configuración de Credenciales de Base de Datos Real en [`.env`](.env):**
   - Definir `DB_HOST`: Si la base corre en el host Windows, usar `host.docker.internal`; si corre en un servidor/RDS, poner la IP o dominio.
   - Definir `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
   - Reiniciar el contenedor (`docker-compose restart`) y correr `scripts/test_local.ps1` para ver la conexión a la base real en verde.
2. **Definir Herramientas de Negocio Específicas:**
   - Confirmar qué tablas exactas almacenan las ventas, asesores y líderes en la base de datos de MVEVIP (ej: `mve_ventas`, `mve_cotizaciones`, `mve_asesores`, etc.).
   - Crear las herramientas MCP personalizadas de reportes según los requerimientos del equipo.
3. **Despliegue a AWS:**
   - Ejecutar `powershell -ExecutionPolicy Bypass -File deploy_aws.ps1 -Profile marketingvip`.
   - Obtener la URL pública HTTPS de AWS Lambda.
4. **Conexión en Claude.ai Web:**
   - Ir a Claude.ai -> **Personalizar > Conectores** -> Agregar conector.
   - Ingresar la URL de AWS.
   - En la pantalla emergente de MVEVIP, ingresar la clave corporativa de `.env` (`MCP_ACCESS_KEY`).
   - Validar consultas directamente en una conversación con Claude.

---

## 🛠️ Comandos Rápidos de Referencia

```powershell
# Ver estado del contenedor local
docker ps

# Reiniciar contenedor local tras cambios en .env
docker-compose restart

# Correr batería de pruebas locales
powershell -ExecutionPolicy Bypass -File scripts/test_local.ps1

# Empaquetar para AWS Lambda
powershell -ExecutionPolicy Bypass -File build_zip.ps1

# Desplegar en AWS con perfil marketingvip
powershell -ExecutionPolicy Bypass -File deploy_aws.ps1
```

*Sesión cerrada y guardada para reanudar sin fricción.*
