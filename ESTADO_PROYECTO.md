# ESTADO DEL PROYECTO — mvevip-mcp (actualizado 30-oct-2026, cierre de sesión)

Servidor MCP remoto (TypeScript/Express/MySQL) para que Claude y ChatGPT consulten reportes de MVEVIP (ventas, cuadro de ventas,
requerimientos y asistencia). Solo lo usan administradores de la empresa con correo `@mvevip.com`.

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
- Rama de trabajo de la sesión: `claude/festive-thompson-nd74zw` (tras cada PR fusionado se reinicia desde `origin/main` con `git checkout -B ... origin/main` y `git push --force-with-lease`).

## Estado actual (todo desplegado en producción)
Herramientas MCP (solo lectura, sin SQL libre desde el chat):

| Herramienta | Qué da | Archivo |
|---|---|---|
| `reporte_ventas_mes` | Ventas del mes (por fecha de venta): detalle o agrupado por asesor, líder, líder asistente, ciudad, contrato o tipo de contrato; con `incluir_requerimientos` suma requerimientos y comisión neta por asesor | `src/mcp/tools/salesReportTool.ts` |
| `cuadro_ventas` | El cuadro de la pantalla de la oficina a una fecha: resumen, días laborables, equipos, grupos, líderes por cierres, ventas del día por asesor | `src/mcp/tools/cuadroTool.ts` |
| `requerimientos` | Devoluciones y reclamos de ventas, contados en el mes en que ingresaron; su valor se descuenta de la comisión | `src/mcp/tools/requerimientosTool.ts` |
| `asistencia` | Entradas del biométrico y atrasos (lunes a viernes, primera entrada del día, sin salidas); vistas por empleado, día o departamento | `src/mcp/tools/asistenciaTool.ts` |

- Código: 77 pruebas (`npm test`), typecheck, empaquetado Lambda y `npm audit` de producción en 0 vulnerabilidades (zod 4, body-parser y qs actualizados).
- Último despliegue: workflow "Deploy to production" **#13** (PR #9). `/health` = 200.
- Usuarios activos del MCP: `cmino`, `dproano`, `aveintimilla`, `amorales` (todos @mvevip.com; sin contraseñas en el repo).
- SES sigue en sandbox y AWS **denegó** el acceso a producción (caso 179337882700292): no importa, el MCP solo envía códigos a direcciones `@mvevip.com` (dominio verificado con DKIM).
- Conector de ChatGPT funcionando (se corrigió el metadato `/.well-known/oauth-protected-resource/mcp` y se permitieron sus URL de retorno `https://chatgpt.com/connector/oauth/<id>`).

## Cómo se construyó (resumen; el detalle está en `MEMORIA.md`)
1. **22-oct** (sesiones anteriores): servidor, seguridad (OAuth 2.0 + PKCE), login usuario/contraseña + código por correo (SES), BD de autenticación, CI/CD con GitHub Actions + OIDC + CloudFormation, usuarios de BD `mcp_ro` y `mcp_auth`.
2. **30-oct** (esta sesión): rol OIDC, environment `production` de GitHub (4 variables y 8 secrets), primer despliegue, DNS (CNAME `mcp` + 3 DKIM de SES), primer usuario, conector en Claude.
3. Herramientas de negocio, siempre con el mismo flujo: el usuario pasa la consulta o el código PHP de referencia → Claude la revisa (rangos de fecha, duplicados, reglas ocultas) y propone el diseño → el usuario ejecuta los scripts de verificación y los `GRANT` por columna →
   Claude escribe la herramienta con pruebas (incluida una que reproduce cifras reales de la pantalla del usuario) → PR → merge → deploy → el usuario prueba en el chat y compara cifras.
4. Se eliminaron las herramientas genéricas (`test_db_connection`, `describe_database`, `get_table_schema`, `query_database_sample`) para que no haya SQL libre.

## PENDIENTES (por prioridad)
1. **`asistencia` — definiciones del negocio:**
   a. *Horas trabajadas*: el usuario las quiere, pero también dijo que las salidas nunca se consideran; falta aclarar el cálculo (¿primera entrada a última marcación del día, u otro?).
   b. *Feriados*: hoy solo se excluyen sábados y domingos; decidir si se excluyen feriados (tabla `cuadro_feriados` de `vtgsa_ventas`, ya usada por el cuadro).
   c. *Ausentes* (quién no marcó): etapa 2; requiere lista de empleados activos y días laborables.
2. **Cuadro de ventas:** el usuario revisará los valores y enviará ajustes si hace falta. Hoy el cuadro **no** descuenta los requerimientos de la comisión (decidido: así está bien por ahora). Rutas del PHP no incluidas: islas, ranking, dados, parejas, `cuadro-octubre`, pantalla (recursos/mensajes/música).
3. **`requerimientos`:** el campo `estado` no se usa por ahora (decisión del usuario).
4. **CI de GitHub:** los PR #5 a #9 se fusionaron con el CI todavía en cola; tras corregir las dependencias debería estar en verde, pero **no se verificó**. Revisar la pestaña Actions de `main` y corregir si algo falla.
5. **Seguridad (más adelante):** RDS público (acordado, otro proyecto); `mcp_ro` conserva `SELECT` sobre toda `vtgsa_ventas` aunque ya no haya SQL libre (se podría reducir a las tablas usadas); el `GRANT` de `punch` en `mve_asistencias` ya no se usa y podría revocarse; restringir herramientas por usuario si algún día se necesita.
6. **Limpieza del repo (opcional):** `build_zip.ps1`, `deploy_aws.ps1`, `docker-compose.yml`/`Dockerfile` (flujo anterior), `MEMORIA_SESION.md` y `referencia/` son históricos o de otro proyecto.
7. **Operación:** crear usuarios nuevos cuando se necesiten (comando en `docs/DEPLOY.md`, solo `@mvevip.com`); para revocar todos los tokens, cambiar el secret `MCP_SIGNING_SECRET` y desplegar.

## SIGUIENTE PASO
No hay un paso en curso: el trabajo de la sesión quedó cerrado y desplegado. Al reanudar, resumir en 2-3 líneas el estado anterior y preguntar al usuario cuál sigue:
- **(a)** definir horas trabajadas, feriados y ausentes de `asistencia`;
- **(b)** una herramienta nueva (pedir la consulta o el PHP de referencia y seguir el flujo del punto 3);
- **(c)** revisar que el CI de `main` esté en verde y limpiar archivos obsoletos;
- **(d)** crear más usuarios del MCP.
