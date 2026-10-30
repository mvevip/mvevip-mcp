# MEMORIA TÉCNICA — MVEVIP REMOTE MCP SERVER

**Proyecto:** servidor Remote MCP de MVEVIP (`mvevip-mcp`) · **Actualizada:** 30-oct-2026 (cierre de sesión)
**Repositorio:** https://github.com/mvevip/mvevip-mcp · **Estado y pendientes:** `ESTADO_PROYECTO.md` · **Despliegue/operación:** `docs/DEPLOY.md`

---

## 1. Qué es y cómo está armado

Servidor MCP (Model Context Protocol) en **TypeScript / Node / Express** que Claude (web/desktop) y ChatGPT usan como conector para consultar reportes
de MVEVIP en **solo lectura**. Lo usan solo administradores con correo `@mvevip.com`. No hay SQL libre: cada herramienta ejecuta consultas fijas con parámetros validados.

```
Claude / ChatGPT → CloudFront (mcp.mvevip.com, ACM) → Lambda Function URL (BUFFERED) → RDS MySQL (database-mvevip, us-west-2)
                                   login: usuario + contraseña → código de 6 dígitos por correo (SES) → OAuth 2.0 + PKCE
```

- **Región:** us-west-2 (Lambda, SES, stack `mvevip-mcp`). Certificado ACM `*.mvevip.com` en us-east-1 (requisito de CloudFront). Cuenta AWS `021891594659`.
- **DNS:** proveedor externo (no Route 53): CNAME `mcp` → CloudFront y 3 CNAME DKIM de SES.
- **Bases de datos** (mismo servidor RDS): `vtgsa_ventas` (negocio), `mve` (clientes, ciudades, usuarios del CRM), `mvevip_biometrico` (asistencia) y `mvevip_mcp_auth` (usuarios del MCP; sus tablas `mcp_users` y `mcp_login_challenges` se crean solas).
- **Código:** `src/index.ts` (Express, OAuth, JSON-RPC `/mcp`, catálogo de herramientas), `src/mcp/tools/*` (una por herramienta + `dates.ts` con utilidades de fechas),
  `src/services/dbService.ts` (pool MySQL, transacción `READ ONLY`, timeout 15 s, tope 500 filas, valores enlazados `?`), `src/services/sqlGuard.ts` (validador de solo lectura),
  `src/services/authStore.ts` y `src/auth/*` (login, códigos, tokens), `src/lambda.ts` (adaptador `serverless-http`), `infra/*.yaml` (CloudFormation), `.github/workflows/ci.yml` y `deploy.yml`.

## 2. Seguridad (resumen)
- `/mcp` exige Bearer token en todas las llamadas (401 con `WWW-Authenticate`). OAuth con PKCE S256, `redirect_uri` en lista blanca (`src/config.ts`: Claude, ChatGPT, GPTs con acciones, `https://chatgpt.com/connector/oauth/<id>`, `https://platform.openai.com/apps-manage/oauth`, loopback), cliente público, `client_id` validado.
- Login: contraseña con scrypt; bloqueo de cuenta tras 5 fallos (15 min, guardado en BD); código por correo de 10 min, 5 intentos, un solo uso, máximo 3 envíos por usuario cada 10 min; límite de intentos por IP. Token de 30 días. Usuarios deshabilitados pierden acceso en ≤60 s.
- Los usuarios los crea solo un administrador con `aws lambda invoke` (payload `mvevipAdmin`, comandos `create-user`, `set-password`, `disable-user`, `enable-user`, `list-users`, `init`). No hay auto-registro. No hay comando para cambiar el correo (habría que deshabilitar y recrear).
- La Function URL directa solo responde si la petición trae el secreto de CloudFront (`ORIGIN_VERIFY_SECRET`). Para revocar todos los tokens: cambiar `MCP_SIGNING_SECRET` y desplegar.
- Todo SQL pasa por `sqlGuard` (sin multi-sentencia, `INTO`, `SLEEP`, etc.) y corre en transacción `READ ONLY`. Fechas y nombres de columna del `ORDER BY` salen de listas cerradas o se validan (`YYYY-MM-DD`); los textos de búsqueda viajan como valores enlazados con comodines escapados.
- Registros (CloudWatch `/aws/lambda/mvevip-mcp-server`): método, ruta, id de usuario y herramienta; sin SQL ni cabeceras. `/register` registra los `redirect_uri` rechazados (útil si un cliente nuevo falla al conectar).

## 3. Permisos de base de datos (los ejecuta el usuario; Claude solo entrega el script)
- **`mcp_ro`** (secrets `DB_USER`, `DB_NAME=vtgsa_ventas`): `SELECT` sobre `vtgsa_ventas.*` y `SELECT` **por columna** en:
  - `mve.mve_clientes` (cli_codigo, cli_apellido, cli_nombre, cli_ciudad, cli_fecha_ingreso), `mve.mve_geo_ciudades` (id, nombre), `mve.mve_usuarios` (usu_codigo, usu_apellido, usu_nombre).
  - `mvevip_biometrico.mve_asistencias` (`timestamp`, user_id_biometrico, dispositivo_id, punch — `punch` ya no se usa), `mve_usuarios` (user_id_biometrico, nombre, departamento_id, pico_placa_dia, pico_placa_hora), `mve_departamentos` (id, nombre, hora_entrada, hora_salida), `mve_dispositivos` (id, nombre).
- **`mcp_auth`** (secrets `AUTH_DB_USER`, `AUTH_DB_PASSWORD`): CREATE, INDEX, SELECT, INSERT, UPDATE, DELETE solo sobre `mvevip_mcp_auth`.
- Una herramienta nueva que lea tablas o columnas nuevas necesita su `GRANT` por columna (mínimo privilegio) **antes** de desplegar; si se despliega antes, la herramienta falla por permisos.

## 4. Herramientas y reglas de negocio acordadas con el usuario

### `reporte_ventas_mes` (`salesReportTool.ts`)
- Período por **fecha de venta** (`registros.fecha_venta`, tipo date); por defecto el mes actual en America/Guayaquil; parámetros `mes`, `anio`. Rango semiabierto `>= primer día` y `< primer día del mes siguiente`.
- Excluye estados **9 y 13** (anulados), fijos en el SQL. Incluye **todos los líderes** (sin filtrar `estado` ni `visual`) para poder comparar meses; los líderes sin ventas no aparecen.
- Columnas: fecha_venta, grupos (líder), lider_asistente, id_cliente, nombre_del_cliente, ciudad, abono_pagado, valor_total, valor_pendiente, comision_asesor, contrato, tipoContrato, fecha_ingreso_cliente, nombre_del_asesor.
  `abono_pagado` = suma de **todos** los `valor_voucher` de la venta (`registros_pagos`); `comision_asesor` = suma de `comision`. `pago_cuadro` **no** se usa.
- `agrupar_por`: asesor, lider, lider_asistente, ciudad, contrato, tipo_contrato (ventas, valor_total, abono_pagado, valor_pendiente, comision_asesor por grupo). Siempre devuelve los totales del mes (aunque el detalle se recorte a 500 filas).
- El asesor se une por `usuarios.id_referencia = registros.id_vendedor`; `usuarios.id_referencia = 0` es personal que no vende (72 filas repetidas) y se ignora (un solo registro por vendedor).
- **`incluir_requerimientos`**: con `agrupar_por=asesor` agrega `requerimientos_cantidad`, `requerimientos_valor` y `comision_neta` (= comisión − requerimientos, incluye asesores con requerimientos y sin ventas); con otras agrupaciones solo en los totales.

### `cuadro_ventas` (`cuadroTool.ts`) — réplica de la pantalla de la oficina (código PHP original: `cuadro.php`, `utiles.php`)
- Parámetro opcional `fecha` (por defecto hoy en America/Guayaquil). Devuelve: resumen (ventas de hoy, falta hoy, ventas del mes, comisión del mes, meta), días laborables, equipos, grupos, líderes por cierres y ventas del día por asesor.
- **Equipos** = tabla `lideres` (activos y visibles; sigla = iniciales del nombre). **Grupos** = `usuarios_agrupaciones` (por asesor, `usuarios.id_agrupacion`). **Líderes por cierres** = `id_lider_asistente` con `realiza_cierre = 1`.
- Las **metas se miden contra la comisión**. Meta diaria = meta mensual ÷ días laborables. "A fecha" = meta − meta diaria × días restantes. "Falta hoy" = suma de lo que falta de la meta diaria de cada equipo. La meta de comisión total (300 000 en octubre) es la suma de las metas.
- Ventas = `abono_pagado` (no `pago_cuadro`). Estados 9 y 13 **siempre** excluidos (el PHP original solo excluía el 9 en Grupos).
- **Días laborables** = lunes a viernes menos `cuadro_feriados` (cada feriado una sola vez; el PHP los restaba dos veces y restaba un día extra a los restantes). Restantes = laborables posteriores a la fecha consultada, mínimo 0. Octubre 2026: feriado 9-oct → 21 laborables.
- La prueba `tests/cuadro.test.ts` reproduce las cifras reales de la pantalla del 30-oct (ventas del mes 214 430,14; comisión 180 995,13; falta hoy 13 235,71).

### `requerimientos` (`requerimientosTool.ts`)
- Tabla `requerimientos` (devoluciones y reclamos de ventas de asesores): fecha_requerimiento (date), fecha_venta, fecha_alta (hora de registro), id_registro, id_cliente, id_asesor, valor, observaciones, estado.
- Se cuentan **siempre en el mes en que se ingresaron** (`fecha_requerimiento`); su valor **se descuenta de la comisión**. El `estado` no se usa por ahora.
- Parámetros: `mes`/`anio` o `fecha_desde`/`fecha_hasta` (inclusive; una sola fecha = ese día), `agrupar_por` (ninguno, asesor), `ordenar_por`, `direccion`. Observaciones recortadas a 500 caracteres. Asesor: nombre de `mve_usuarios` (o `usuarios.usuario_crm`).
- Referencia de octubre 2026 (al 30-oct): 8 requerimientos, valor total 4 134,00.

### `asistencia` (`asistenciaTool.ts`) — base `mvevip_biometrico` (reglas tomadas de `biometrico.php`)
- **Solo entradas, de lunes a viernes.** El campo `punch` del dispositivo **no es confiable** (punch 0: 11 168 entradas y 2 516 salidas por hora; punch 1: 2 553 entradas y 10 952 salidas), por eso **no se usa**: una marcación es entrada si su hora cae antes del punto medio entre `hora_entrada` y `hora_salida` del departamento del empleado. Las salidas nunca se consideran.
- Departamentos: todos con entrada 09:45; salidas 18:00 a 19:00 (3 = CALL CENTER, 18:30). `timestamp` es DATETIME (sin conversión de zona).
- Hora esperada = `pico_placa_hora` si `pico_placa_dia = WEEKDAY(ts) + 1`; si no, la `hora_entrada` del departamento. Atraso = minutos después de la hora esperada, solo en la **primera entrada del día** de cada empleado; `tolerancia_minutos` opcional (0 por defecto).
- Empleados sin departamento (hoy 0) se incluyen como `SIN DEPARTAMENTO` con la jornada estándar 09:45–18:00 (el PHP asumía 08:00–17:00, lo que habría dado atrasos falsos).
- Parámetros: `mes`/`anio` o `fecha_desde`/`fecha_hasta`, `departamento`, `empleado` y `dispositivo` (búsqueda parcial con valores enlazados), `agrupar_por` (ninguno, empleado, dia, departamento), `todas_las_marcaciones`, `ordenar_por`, `direccion`. Siempre devuelve totales; si un filtro no encuentra nada, devuelve los departamentos y dispositivos válidos.
- No incluye: horas trabajadas, feriados, ausentes (pendientes, ver `ESTADO_PROYECTO.md`).

## 5. Cómo trabajamos (método para una herramienta nueva)
1. El usuario pasa la consulta SQL o el PHP de referencia. Claude la revisa y señala: rangos de fecha con `BETWEEN` (usar semiabierto), funciones sobre columnas indexadas, duplicados por joins, estados que cuentan, permisos faltantes en otra base, reglas ocultas en el código PHP.
2. Claude entrega scripts de **verificación de solo lectura** y los `GRANT` por columna; el usuario los ejecuta y pega resultados (capturas o `.xlsx`, que se leen con `python3 -I` + openpyxl).
3. Claude escribe la herramienta (`src/mcp/tools/…`), el esquema Zod en `src/mcp/types.ts`, la definición y el despacho en `src/index.ts`, y las pruebas (`tests/…`), incluida una que reproduce cifras reales. Verifica con `npm run typecheck`, `npm test`, `npm run package`, `npm audit --omit=dev --audit-level=high`.
4. PR → merge → "Deploy to production" (`ref=main`) → comprobar `/health` → actualizar `ESTADO_PROYECTO.md` → el usuario prueba en el chat (quitar y volver a agregar el conector para refrescar la lista de herramientas).

## 6. Trucos de operación y lecciones aprendidas
- **GitHub Actions** a veces deja las ejecuciones en cola 10–25 min (CI y deploy). No cancelar ni relanzar: se pone al final de la cola. Si el CI de un PR sigue en cola, el workflow de deploy repite typecheck y pruebas antes de publicar.
- **Herramientas de GitHub** (`mcp__github__*`): pueden desconectarse; se recuperan con `ToolSearch`. No hay `gh` en el entorno.
- **AWS desde la sesión:** las llamadas a `*.amazonaws.com` se firman solas por el proxy del entorno, sin credenciales: sirven `curl` a CloudFormation (`DescribeStacks`), SES v2 (`/v2/email/account`, `/v2/email/identities/<dominio>`), Lambda (`POST https://lambda.us-west-2.amazonaws.com/2015-03-31/functions/mvevip-mcp-server/invocations`) y CloudWatch Logs (`FilterLogEvents`). No hay CLI `aws` instalada. Solo lectura, salvo lo que el usuario autorice (crear usuarios del MCP, solicitar SES).
- **ChatGPT** usa registro dinámico (DCR): consulta `/.well-known/oauth-protected-resource/mcp` (hay que servirlo), registra su `redirect_uri` en `/register` y recién entonces va a `/authorize`. Si falla al crear el conector, mirar en CloudWatch la línea `[REGISTER] redirect_uri rechazado` y agregar la URL a la lista.
- **mysql2** devuelve las fechas como `Date` de JavaScript; las herramientas nuevas formatean con `DATE_FORMAT` en el SQL, y las sumas de condiciones se convierten con `CAST(... AS SIGNED)` (si no, llegan como texto).
- **SES:** AWS denegó el acceso a producción; sigue en sandbox. Como el dominio `mvevip.com` está verificado, llegan los códigos a cualquier `@mvevip.com`. Un correo de otro dominio necesitaría verificar esa dirección en SES.
- Las contraseñas generadas de los usuarios se entregan una sola vez en el chat; no se escriben en el repo. Si se pierde una: `set-password`.
- Los PHP y las capturas de pantalla del usuario son la mejor fuente de las reglas de negocio: varias reglas (metas contra comisión, estado 13, feriados) solo se vieron al cruzar el código con la pantalla.

## 7. Historial resumido
- **7-oct-2026:** primer servidor Docker local con clave corporativa (`MEMORIA_SESION.md`, histórico).
- **22-oct-2026:** seguridad, OAuth + PKCE, login con código por correo, BD de autenticación, CI/CD, región us-west-2, rol OIDC (PR #1).
- **30-oct-2026:** environment `production`, primer despliegue, DNS, SES, usuarios, conectores (Claude y ChatGPT). Herramientas: `reporte_ventas_mes` (PR #2, #3), `cuadro_ventas` (PR #4), corrección de dependencias y de ChatGPT (PR #5), eliminación de herramientas genéricas (PR #6), `requerimientos` (PR #7), `asistencia` (PR #8 y #9). Despliegues #4 a #13.
