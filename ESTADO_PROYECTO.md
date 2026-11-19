# ESTADO DEL PROYECTO — mvevip-mcp (actualizado 17-nov-2026)

Servidor MCP remoto (TypeScript/Express/MySQL) para que Claude y ChatGPT consulten reportes de MVEVIP (ventas, cuadro de ventas,
requerimientos, asistencia, validación de cruces de ventas y liberación de base). Solo lo usan administradores de la empresa con correo `@mvevip.com`.

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
- Rama de trabajo de la sesión actual: `claude/intelligent-ritchie-gngbib`. Las ramas anteriores (todas fusionadas) se borraron el 17-nov (tras cada PR fusionado se reinicia desde `origin/main` con `git checkout -B ... origin/main` y `git push --force-with-lease`).

## Estado actual (todo desplegado en producción, 11 herramientas)
Herramientas MCP (sin SQL libre desde el chat; solo las de base escriben, en dos pasos con código de confirmación):

| Herramienta | Qué da | Archivo |
|---|---|---|
| `reporte_ventas_mes` | Ventas del mes (por fecha de venta): detalle o agrupado por asesor, líder, líder asistente, ciudad, contrato o tipo de contrato; con `incluir_requerimientos` suma requerimientos y comisión neta por asesor | `src/mcp/tools/salesReportTool.ts` |
| `cuadro_ventas` | El cuadro de la pantalla de la oficina a una fecha: resumen, días laborables, equipos, grupos, líderes por cierres, ventas del día por asesor | `src/mcp/tools/cuadroTool.ts` |
| `requerimientos` | Devoluciones y reclamos de ventas, contados en el mes en que ingresaron; su valor se descuenta de la comisión | `src/mcp/tools/requerimientosTool.ts` |
| `asistencia` | Entradas del biométrico y atrasos (lunes a viernes, primera entrada del día, sin salidas); vistas por empleado, día o departamento | `src/mcp/tools/asistenciaTool.ts` |
| `validar_cruce_ventas` | Detecta ventas cruzadas: contacto asignado a otro asesor (`CRUCE_CONTACTO`) y cuotas cuyo cliente es de otro asesor (`CRUCE_CUOTA`) | `src/mcp/tools/cruceVentasTool.ts` |
| `encontrar_contacto` | Busca contactos de `notas_registros` por documento, nombres, teléfono, correo o asesor (uno o varios registros) | `src/mcp/tools/contactoTool.ts` |
| `asignar_base_usuario` | Asigna cupo de una base (banco + identificador) a uno o varios asesores tipo 6 activos; modo `sumar` (defecto) o `fijar`; identificador obligatorio; dos pasos | `src/mcp/tools/cuposTool.ts` |
| `encerar_cupo_usuario` | Pone cupo 0 solo a los asesores indicados (todas sus bases o una); dos pasos | `src/mcp/tools/cuposTool.ts` |
| `historial_base` | Solo lectura: historial de liberaciones de `aplicar_base` por contacto (id_lista, teléfono o documento) o por lote/fecha/banco (**código listo, sin desplegar**) | `src/mcp/tools/historialBaseTool.ts` |
| `buscar_base` | Solo lectura: contactos de `notas_registros` sin llamadas (cruce con Asterisk) y vista previa con código de confirmación | `src/mcp/tools/baseTool.ts` |
| `aplicar_base` | Libera la base de `buscar_base` (normal o predictivo) en una transacción, solo si el código coincide | `src/mcp/tools/baseTool.ts` |
| `encerar_cupos` | Pone en 0 los cupos de `notas_registros_cupos` (dos pasos, solo a pedido) | `src/mcp/tools/baseTool.ts` |

- Código: 144 pruebas (`npm test`), typecheck, empaquetado Lambda y `npm audit` de producción en 0 vulnerabilidades (zod 4, body-parser y qs actualizados).
- Último despliegue: workflow "Deploy to production" **#17** (PR #15, 19-nov, `main` = `6621bbf`). `/health` = 200. CI en verde.
- Usuarios activos del MCP: `cmino`, `dproano`, `aveintimilla`, `amorales` (todos @mvevip.com; sin contraseñas en el repo).
- SES sigue en sandbox y AWS **denegó** el acceso a producción (caso 179337882700292): no importa, el MCP solo envía códigos a direcciones `@mvevip.com` (dominio verificado con DKIM).
- Conector de ChatGPT funcionando (se corrigió el metadato `/.well-known/oauth-protected-resource/mcp` y se permitieron sus URL de retorno `https://chatgpt.com/connector/oauth/<id>`).

## Cómo se construyó (resumen; el detalle está en `MEMORIA.md`)
1. **22-oct** (sesiones anteriores): servidor, seguridad (OAuth 2.0 + PKCE), login usuario/contraseña + código por correo (SES), BD de autenticación, CI/CD con GitHub Actions + OIDC + CloudFormation, usuarios de BD `mcp_ro` y `mcp_auth`.
2. **30-oct** (esta sesión): rol OIDC, environment `production` de GitHub (4 variables y 8 secrets), primer despliegue, DNS (CNAME `mcp` + 3 DKIM de SES), primer usuario, conector en Claude.
3. Herramientas de negocio, siempre con el mismo flujo: el usuario pasa la consulta o el código PHP de referencia → Claude la revisa (rangos de fecha, duplicados, reglas ocultas) y propone el diseño → el usuario ejecuta los scripts de verificación y los `GRANT` por columna →
   Claude escribe la herramienta con pruebas (incluida una que reproduce cifras reales de la pantalla del usuario) → PR → merge → deploy → el usuario prueba en el chat y compara cifras.
4. Se eliminaron las herramientas genéricas (`test_db_connection`, `describe_database`, `get_table_schema`, `query_database_sample`) para que no haya SQL libre.

## PENDIENTES (todo cerrado; se reabre solo si el usuario lo pide)
1. Las 8 herramientas están desplegadas, usadas por el usuario sin problemas y **cerradas** (incluidas `buscar_base`, `aplicar_base` y `encerar_cupos`, desplegadas en el #15).
2. Servicio `asterisk-gateway` en Server Docker: operativo; el reinicio del sistema (kernel) ya se hizo. El certificado de `bases.mvevip.com` vence el 8-feb-2027 (renovación automática con certbot).
3. **Seguridad: aplazada**, se resuelve en otro proyecto (RDS público, permisos de `mcp_ro`, `GRANT` de `punch`).
4. **Funciones futuras: ninguna por ahora.** Ideas guardadas para cuando el usuario las pida: `asistencia` (horas trabajadas, feriados, ausentes) y `cuadro_ventas` (rutas del PHP no incluidas, descuento de requerimientos, uso del campo `estado`).
5. **Operación:** usuarios actuales suficientes; se crean más solo cuando el usuario lo pida (comando en `docs/DEPLOY.md`, solo `@mvevip.com`). Para revocar todos los tokens, cambiar el secret `MCP_SIGNING_SECRET` y desplegar.
6. Mantenimiento de ramas hecho el 17-nov: se borraron las ramas remotas ya fusionadas; quedan `main` y la rama de trabajo.

## EN CURSO: `historial_base` y registro de liberaciones (código listo en el PR, SIN desplegar)
Traído a `main` desde la rama `claude/eager-bell-u1yr44` (commit `237da06`, 10-nov) y adaptado a lo nuevo (conflictos resueltos 19-nov). `aplicar_base` ahora guarda, en la misma transacción y antes de modificar los contactos, un lote en `mcp_base_lotes` y una fila por contacto en `mcp_base_historial` (estado anterior); si no coinciden, revierte todo. `historial_base` (solo lectura con `mcp_ro`, que ya lee todo `vtgsa_ventas`) consulta por contacto o por lote. Detalle en `MEMORIA.md` sección 4. 144 pruebas, typecheck y paquete en 0. Las tablas y el `GRANT INSERT` a `mcp_base` existen (se ven en `SHOW GRANTS` del 19-nov); falta que el usuario pegue `SHOW CREATE TABLE` de ambas para confirmar que las columnas coinciden con los `INSERT` del código (el DDL no está en el repo). No registra `asignar_base_usuario` ni `encerar_cupo_usuario` ni lo anterior al despliegue.

## SIGUIENTE PASO
El usuario pega `SHOW CREATE TABLE` y `COUNT(*)` de `mcp_base_lotes` y `mcp_base_historial`; verificar columnas, guardar el DDL en `db/historial_base.sql` y luego "crea el PR y despliega". Después prueba en el chat (quitar y volver a agregar el conector): una liberación pequeña con `aplicar_base` y `historial_base` por ese contacto o por el lote. Si se despliega con columnas distintas, `aplicar_base` falla y revierte (no deja cambios a medias). Pendiente aparte: borrar las ramas remotas ya fusionadas desde GitHub (Settings → Branches); `eager-bell-u1yr44` se puede borrar cuando este PR esté fusionado.
