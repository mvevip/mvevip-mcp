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

## EN CURSO: herramientas `buscar_base`, `aplicar_base` y `encerar_cupos` (código listo, SIN desplegar)
Liberan "base" (contactos de `notas_registros`) sin llamadas para reasignarla. Reglas, seguridad y proceso: `MEMORIA.md` sección 4. Lo hecho el 10-nov:
- `GRANT` de `mcp_base` (RDS) y de `lectura` (Asterisk, base `asterisk`) aplicados y verificados; clave de `mcp_base` cambiada.
- Servicio **`asterisk-gateway/`** instalado en Server Docker y probado (cifras iguales al Excel); HTTPS en `https://bases.mvevip.com` (nginx + certbot, vence 8-feb-2027; renovación automática); desde fuera de la oficina responde. Tiene un reinicio del sistema pendiente (kernel).
- Código: `src/mcp/tools/baseTool.ts`, `src/services/dbWriteService.ts`, `src/services/asteriskClient.ts`, esquemas Zod, definiciones y despacho en `src/index.ts`, parámetros y secrets en `infra/template.yaml` y `deploy.yml`. 109 pruebas (`tests/baseBusqueda.test.ts` reproduce los 12 contactos reales del Excel: se liberan 5 con `DIN-5`), typecheck, empaquetado y `npm audit` en 0.
- **Falta antes de desplegar:** que el usuario cargue en el environment `production` de GitHub los secrets `ASTERISK_API_URL` (`https://bases.mvevip.com`), `ASTERISK_API_TOKEN` (el `GATEWAY_TOKEN` del `.env` de Server Docker), `DB_WRITE_USER` (`mcp_base`) y `DB_WRITE_PASSWORD` (la clave nueva). Si se despliega sin ellos, las herramientas responden que no están configuradas (no escriben).

## SIGUIENTE PASO
El usuario carga los 4 secrets; luego "crea el PR y despliega" (PR → merge → "Deploy to production" `ref=main` → `/health`). Después prueba en el chat (quitar y volver a agregar el conector): primero `buscar_base` de un rango pequeño, comparar con su Excel, y solo entonces `aplicar_base`. Opciones posteriores: ajustes a las herramientas, usuarios nuevos del MCP, seguridad (RDS público, permisos de `mcp_ro`).
