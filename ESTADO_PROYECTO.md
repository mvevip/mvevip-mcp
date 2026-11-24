# ESTADO DEL PROYECTO — mvevip-mcp (actualizado 24-nov-2026)

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
- Rama de trabajo de la sesión actual: `claude/intelligent-ritchie-gngbib`. Las ramas anteriores (todas fusionadas) se borraron el 19-nov (tras cada PR fusionado se reinicia desde `origin/main` con `git checkout -B ... origin/main` y `git push --force-with-lease`).

## Estado actual (12 herramientas desplegadas en producción; la 13.ª, `pagos_facturacion`, está lista y sin desplegar)
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
| `historial_base` | Solo lectura: historial de liberaciones de `aplicar_base` por contacto (id_lista, teléfono o documento) o por lote/fecha/banco | `src/mcp/tools/historialBaseTool.ts` |
| `pagos_facturacion` | Solo lectura: abonos facturados (estado 5 y 6) por concepto contable, forma de pago, origen, destino o usuario; por fecha de venta, factura o abono; con comparativo del año anterior (**código listo, sin desplegar**) | `src/mcp/tools/pagosFacturacionTool.ts` |
| `buscar_base` | Solo lectura: contactos de `notas_registros` sin llamadas (cruce con Asterisk) y vista previa con código de confirmación | `src/mcp/tools/baseTool.ts` |
| `aplicar_base` | Libera la base de `buscar_base` (normal o predictivo) en una transacción, solo si el código coincide | `src/mcp/tools/baseTool.ts` |
| `encerar_cupos` | Pone en 0 los cupos de `notas_registros_cupos` (dos pasos, solo a pedido) | `src/mcp/tools/baseTool.ts` |

- Código: 157 pruebas (`npm test`), typecheck, empaquetado Lambda y `npm audit` de producción en 0 vulnerabilidades (zod 4, body-parser y qs actualizados).
- Último despliegue: workflow "Deploy to production" **#19** (24-nov, PR #17 solo documentación, `main` = `383873f`; el último con cambios de código fue el #18, `historial_base`). `/health` = 200. CI en verde.
- Usuarios activos del MCP: `cmino`, `dproano`, `aveintimilla`, `amorales` (todos @mvevip.com; sin contraseñas en el repo).
- SES sigue en sandbox y AWS **denegó** el acceso a producción (caso 179337882700292): no importa, el MCP solo envía códigos a direcciones `@mvevip.com` (dominio verificado con DKIM).
- Conector de ChatGPT funcionando (se corrigió el metadato `/.well-known/oauth-protected-resource/mcp` y se permitieron sus URL de retorno `https://chatgpt.com/connector/oauth/<id>`).

## Cómo se construyó (resumen; el detalle está en `MEMORIA.md`)
1. **22-oct** (sesiones anteriores): servidor, seguridad (OAuth 2.0 + PKCE), login usuario/contraseña + código por correo (SES), BD de autenticación, CI/CD con GitHub Actions + OIDC + CloudFormation, usuarios de BD `mcp_ro` y `mcp_auth`.
2. **30-oct** (esta sesión): rol OIDC, environment `production` de GitHub (4 variables y 8 secrets), primer despliegue, DNS (CNAME `mcp` + 3 DKIM de SES), primer usuario, conector en Claude.
3. Herramientas de negocio, siempre con el mismo flujo: el usuario pasa la consulta o el código PHP de referencia → Claude la revisa (rangos de fecha, duplicados, reglas ocultas) y propone el diseño → el usuario ejecuta los scripts de verificación y los `GRANT` por columna →
   Claude escribe la herramienta con pruebas (incluida una que reproduce cifras reales de la pantalla del usuario) → PR → merge → deploy → el usuario prueba en el chat y compara cifras.
4. Se eliminaron las herramientas genéricas (`test_db_connection`, `describe_database`, `get_table_schema`, `query_database_sample`) para que no haya SQL libre.

## PENDIENTES (se reabren solo si el usuario lo pide)
1. Las 12 herramientas están desplegadas, probadas por el usuario en el chat (24-nov: las 4 nuevas funcionan bien) y **cerradas**.
2. **Fecha a vigilar:** el certificado de `bases.mvevip.com` (servicio `asterisk-gateway` en Server Docker) vence el **8-feb-2027**; se renueva solo con certbot, pero hay que comprobar que lo hizo.
3. **Seguridad: va en otro proyecto** (RDS público, permisos de `mcp_ro`, `GRANT` de `punch`) y también el historial de `asignar_base_usuario` / `encerar_cupo_usuario`. No tocar aquí.
4. **Ideas futuras, aparte (no pendientes):** `asistencia` (horas trabajadas, feriados, ausentes) y `cuadro_ventas` (rutas del PHP no incluidas, descuento de requerimientos, uso del campo `estado`).
5. **Operación:** usuarios actuales suficientes; se crean más solo cuando el usuario lo pida (comando en `docs/DEPLOY.md`, solo `@mvevip.com`). Para revocar todos los tokens, cambiar el secret `MCP_SIGNING_SECRET` y desplegar.
6. Ramas: en el remoto solo quedan `main` y la rama de trabajo (revisado el 24-nov).

## HISTORIAL DE LIBERACIONES: `historial_base` (desplegado el 19-nov: PR #16, despliegue #18)
`aplicar_base` registra cada liberación (lote en `mcp_base_lotes` y estado anterior de cada contacto en `mcp_base_historial`, en la misma transacción) y `historial_base` la consulta por contacto o por lote. Reglas en `MEMORIA.md` sección 4; DDL en `db/historial_base.sql`. No registra `asignar_base_usuario`, `encerar_cupo_usuario`, liberaciones anteriores ni las hechas a mano.

## EN CURSO: `pagos_facturacion` (código listo en la rama de trabajo, SIN desplegar)
Reporte de abonos facturados de `mve.mve_abonos` (no solo de ventas) con concepto (`cod_descripcion`), forma de pago (banco y tipo), origen, destino y usuario. Reglas y cifras reales en `MEMORIA.md` sección 4. El `GRANT` de facturación ya está aplicado (24-nov, 5 sentencias OK). 157 pruebas, typecheck, paquete y `npm audit` en 0. Pendiente: probar los SQL contra la base real (solo el usuario puede ejecutarlos; se verá al probar en el chat tras el despliegue) y comparar con octubre (por fecha de factura: 523 abonos / 269 791,95 sin ventas anuladas).

## SIGUIENTE PASO (para retomar)
"crea el PR y despliega" (PR → merge → "Deploy to production" `ref=main` → `/health`). Después el usuario prueba `pagos_facturacion` en el chat (quitar y volver a agregar el conector) y compara: octubre por fecha de factura debe dar 523 abonos y 269 791,95 (las ventas anuladas se excluyen: 14 abonos / 9 583,73); forma de pago más usada; comparativo con 2025. Si algo no cuadra: ajustar con los resultados que pegue el usuario.
