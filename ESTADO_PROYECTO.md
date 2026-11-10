# ESTADO DEL PROYECTO — mvevip-mcp (actualizado 10-nov-2026)

Servidor MCP remoto (TypeScript/Express/MySQL) para que Claude y ChatGPT consulten reportes de MVEVIP (ventas, cuadro de ventas,
requerimientos, asistencia y validación de cruces de ventas). Solo lo usan administradores de la empresa con correo `@mvevip.com`.

- **URL del conector:** `https://mcp.mvevip.com/mcp` (OAuth con registro dinámico; funciona en Claude y en ChatGPT).
- **Infraestructura:** AWS **us-west-2** (Lambda `mvevip-mcp-server`, stack `mvevip-mcp`, SES) + CloudFront con certificado ACM en us-east-1,
  cuenta `021891594659`. Base de datos: RDS MySQL `database-mvevip` (us-west-2, público, sin VPC; la seguridad de red se resolverá en otro proyecto).
- **Memoria técnica detallada** (arquitectura, reglas de negocio por herramienta, permisos de BD, trucos de operación): `MEMORIA.md`.
  **Guía de despliegue y operación:** `docs/DEPLOY.md`. **Reglas para Claude:** `CLAUDE.md`.

## Reglas de trabajo acordadas con el usuario (cmino@mvevip.com)
- **Claude nunca ejecuta SQL ni cambia bases de datos**: entrega el script (consultas de verificación y `GRANT`) y el usuario lo ejecuta y pega los resultados (capturas o `.xlsx`).
- Avanzar **de a un paso**, esperando la confirmación del usuario.
- **Solo crear PR cuando el usuario lo pide.** Cuando dice "crea el PR y despliega": crear PR → fusionar (`merge`) → ejecutar el workflow "Deploy to production" con `ref=main` → verificar → actualizar este archivo.
- Los secretos y contraseñas **no** se guardan en el repo. Las contraseñas generadas de usuarios se entregan una sola vez en el chat y el usuario las guarda en su gestor.
- Rama de trabajo de la sesión actual: `claude/eager-bell-u1yr44` (las anteriores, `claude/wonderful-dirac-8op1t3` y `claude/festive-thompson-nd74zw`, ya fusionadas) (tras cada PR fusionado se reinicia desde `origin/main` con `git checkout -B ... origin/main` y `git push --force-with-lease`).

## Estado actual (todo desplegado en producción)
Herramientas MCP (solo lectura, sin SQL libre desde el chat):

| Herramienta | Qué da | Archivo |
|---|---|---|
| `reporte_ventas_mes` | Ventas del mes (por fecha de venta): detalle o agrupado por asesor, líder, líder asistente, ciudad, contrato o tipo de contrato; con `incluir_requerimientos` suma requerimientos y comisión neta por asesor | `src/mcp/tools/salesReportTool.ts` |
| `cuadro_ventas` | El cuadro de la pantalla de la oficina a una fecha: resumen, días laborables, equipos, grupos, líderes por cierres, ventas del día por asesor | `src/mcp/tools/cuadroTool.ts` |
| `requerimientos` | Devoluciones y reclamos de ventas, contados en el mes en que ingresaron; su valor se descuenta de la comisión | `src/mcp/tools/requerimientosTool.ts` |
| `asistencia` | Entradas del biométrico y atrasos (lunes a viernes, primera entrada del día, sin salidas); vistas por empleado, día o departamento | `src/mcp/tools/asistenciaTool.ts` |
| `validar_cruce_ventas` | Detecta ventas cruzadas: contacto asignado a otro asesor (`CRUCE_CONTACTO`) y cuotas cuyo cliente es de otro asesor (`CRUCE_CUOTA`) | `src/mcp/tools/cruceVentasTool.ts` |

- Código: 82 pruebas (`npm test`), typecheck, empaquetado Lambda y `npm audit` de producción en 0 vulnerabilidades (zod 4, body-parser y qs actualizados).
- Último despliegue: workflow "Deploy to production" **#14** (PR #11, 9-nov). `/health` = 200.
- Usuarios activos del MCP: `cmino`, `dproano`, `aveintimilla`, `amorales` (todos @mvevip.com; sin contraseñas en el repo).
- SES sigue en sandbox y AWS **denegó** el acceso a producción (caso 179337882700292): no importa, el MCP solo envía códigos a direcciones `@mvevip.com` (dominio verificado con DKIM).
- Conector de ChatGPT funcionando (se corrigió el metadato `/.well-known/oauth-protected-resource/mcp` y se permitieron sus URL de retorno `https://chatgpt.com/connector/oauth/<id>`).

## Cómo se construyó (resumen; el detalle está en `MEMORIA.md`)
1. **22-oct** (sesiones anteriores): servidor, seguridad (OAuth 2.0 + PKCE), login usuario/contraseña + código por correo (SES), BD de autenticación, CI/CD con GitHub Actions + OIDC + CloudFormation, usuarios de BD `mcp_ro` y `mcp_auth`.
2. **30-oct** (esta sesión): rol OIDC, environment `production` de GitHub (4 variables y 8 secrets), primer despliegue, DNS (CNAME `mcp` + 3 DKIM de SES), primer usuario, conector en Claude.
3. Herramientas de negocio, siempre con el mismo flujo: el usuario pasa la consulta o el código PHP de referencia → Claude la revisa (rangos de fecha, duplicados, reglas ocultas) y propone el diseño → el usuario ejecuta los scripts de verificación y los `GRANT` por columna →
   Claude escribe la herramienta con pruebas (incluida una que reproduce cifras reales de la pantalla del usuario) → PR → merge → deploy → el usuario prueba en el chat y compara cifras.
4. Se eliminaron las herramientas genéricas (`test_db_connection`, `describe_database`, `get_table_schema`, `query_database_sample`) para que no haya SQL libre.

## PENDIENTES (cerrados por el usuario el 10-nov; se reabren solo si el usuario lo pide)
1. ~~`validar_cruce_ventas`~~ probada por el usuario en el chat: correcta.
2. ~~`asistencia`~~ funciona como está. Horas trabajadas, feriados y ausentes quedan para cuando el usuario lo pida.
3. ~~`cuadro_ventas`~~ y ~~`requerimientos`~~ funcionan como están; los ajustes (rutas del PHP no incluidas, descuento de requerimientos en el cuadro, uso del campo `estado`) se harán cuando el usuario los notifique.
4. ~~CI de GitHub~~ en verde.
5. **Seguridad:** se deja como está hasta resolver otros proyectos (RDS público, permisos de `mcp_ro`, `GRANT` de `punch`).
6. ~~Limpieza del repo~~ hecha el 10-nov: lo histórico quedó en `archivo/` (ver `archivo/README.md`: `MEMORIA_SESION.md`, Docker, scripts PowerShell y `referencia/`); `.dockerignore` eliminado.
7. **Operación:** usuarios actuales suficientes; se crean más solo cuando el usuario lo pida (comando en `docs/DEPLOY.md`, solo `@mvevip.com`). Para revocar todos los tokens, cambiar el secret `MCP_SIGNING_SECRET` y desplegar.

## EN CURSO: herramienta `buscar_base` (diseño acordado el 10-nov; sin código todavía)
Libera "base" (contactos de `notas_registros`) sin llamadas, para reasignarla. Reglas del usuario:
- **Filtros:** rango de `fecha_alta` obligatorio (hora Ecuador, -05). Por defecto `banco=2` (DIN), `LENGTH(telefono)=10` y `estado NOT IN (7,10,27,35)`; el usuario puede cambiar banco (DIN, BGR, PIC…), estados (por nombre), ciudad, `identificador`, `identificadorOriginal`, excluir `BLOQ`.
- **Asterisk** (MySQL local `192.168.0.40`, tabla `cdr`, `dst` con 0 inicial, texto): rango por defecto = año en curso. Por defecto se liberan los **sin registro o con `SUM(billsec)=0`**; el usuario puede ampliar ("de 0 a 10 segundos incluido sin registro").
- **Identificador:** el que diga el usuario o `AAAA-MM-DD <SIGLA>-<cantidad liberada>` (predictivo: `AAAA-MM-DD <SIGLA>-PREDICTIVO`).
- **Aplicar (normal):** `UPDATE notas_registros` (guarda los `...Anterior`, `asignado=0, estado=0, observaciones="", identificador=<nombre>`) + `INSERT INTO notas_registros_cupos` (id_usuario de `usuarios` tipo=6 y estado=0, id de banco, identificador, cupo 0) tal cual los dio el usuario. **Predictivo:** `UPDATE predictivo=0, codigo_predictivo=0 WHERE predictivo=1` + `UPDATE` con `predictivo=1, intentos_predictivo=0, codigo_predictivo=0`; sin `INSERT` de cupos.
- **Encerar cupos** (`UPDATE notas_registros_cupos SET cupo=0`, sin `WHERE`): solo si el usuario lo pide explícitamente.
- **Dos fases:** primero vista previa (encontrados, descartados por tener llamadas, a liberar, desgloses, identificador, cupos a crear, predictivos a desmarcar) y un código de confirmación; solo con la confirmación del usuario se ejecuta. Propuesta: 3 herramientas (`buscar_base` solo lectura, `aplicar_base` escritura, `encerar_cupos` escritura).
- **Conexión a Asterisk (opción A):** servicio HTTPS pequeño y de solo lectura en "Server Docker" (`192.168.0.211`, IP pública `59.153.47.219`, Meraki 1:1 NAT) que consulta `cdr` por la LAN; no se abre el 3306. Falta: scripts de verificación, `GRANT` (usuario de escritura `mcp_base`, usuario de solo lectura para `cdr`), puerto 443 y DNS en Meraki.

- **Verificaciones hechas (10-nov):** `notas_registros` (PK `id_lista`, sin índice por `fecha_alta` ni `banco`: el filtro recorre ~840 mil filas, aceptable; sin triggers), `notas_registros_cupos` (PK `id_cupo`, **sin clave única** por usuario+banco+identificador → se revisa antes de insertar para no duplicar), 39 usuarios tipo 6 activos, 761 registros con `predictivo=1`. Bancos vistos: 1 PIC, 2 DIN (también DISC/VISA), 3 BGR, 7 PAC. Asterisk: MariaDB **5.5.60**, `cdr` con índice `idx_dst_calldate` (dst, calldate), 25 millones de filas, hay filas con `calldate` 0000-00-00 (usar rango semiabierto), `dst` de 10 dígitos con 0 inicial; contextos `agentes`, `bases_predictivo`, `promotion`, etc. (la consulta manual no filtra contexto). "Server Docker" (192.168.0.211) llega a 192.168.0.40:3306; tiene un reinicio del sistema pendiente. `mcp_ro` ya tiene SELECT en `vtgsa_ventas.*` (las lecturas no necesitan `GRANT` nuevo).

- **Avance (10-nov):** `GRANT` de `mcp_base` aplicado en RDS (verificado). En Asterisk el usuario de solo lectura se llama **`lectura`**@`192.168.0.211` (`SELECT` en `calldate, dst, duration, billsec` de `cdr`; falta confirmar con `SHOW GRANTS` que el `GRANT` quedó sobre `asterisk.cdr`). Meraki: 1:1 NAT de Server Docker ya tiene 80 y 443; DNS `bases.mvevip.com` → 59.153.47.219 creado. **Servicio de Asterisk escrito** en `asterisk-gateway/` (Node en Docker, HTTPS con el nginx del servidor, 9 pruebas en `tests/asteriskGateway.test.ts`), pendiente de instalar en el servidor (ver su README). Siglas de bancos: columna `prefijo` de `notas_registros_bancos` (1 PIC, 2 DIN, 3 BGR, 6 INTER, 7 PAC, 8 PRODU, 11 AUSTRO, 12 MUPI, 18 LOJA, 21 AMA, 25 LEADS, 53 MACH, etc.; los bancos sin prefijo exigen que el usuario dé el nombre del identificador). La tabla `bancos` es otra (no usar). Server Docker ya tiene nginx en el puerto 80 (no en 443): el HTTPS se publica con ese nginx + certbot (`asterisk-gateway/nginx-bases.conf`). `GRANT` de `lectura` verificado (base `asterisk`, tabla `cdr`; prueba con teléfonos reales: 7 llamadas/1132 s y 6/69 s, igual que el Excel) y clave de `mcp_base` ya cambiados. Seguridad: la clave de `mcp_base` apareció en una captura del chat; se recomienda cambiarla (`ALTER USER`) y guardarla solo en secrets.

## SIGUIENTE PASO
Que el usuario instale `asterisk-gateway/` en Server Docker (README), pruebe `/health` y `/cdr/resumen` con `curl`, y confirme el resultado. Después: las herramientas `buscar_base`, `aplicar_base` y `encerar_cupos` (con secrets `ASTERISK_API_URL`, `ASTERISK_API_TOKEN`, `DB_WRITE_USER`, `DB_WRITE_PASSWORD` en el environment `production`), pruebas, PR y despliegue.
