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

## Estado actual (todo desplegado en producción, 13 herramientas)
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
| `pagos_facturacion` | Solo lectura: abonos facturados (estado 5 y 6) por concepto contable, forma de pago, origen, destino o usuario; por fecha de venta, factura o abono; con comparativo del año anterior (**desplegada el 24-nov, despliegue #20; pendiente de prueba del usuario**) | `src/mcp/tools/pagosFacturacionTool.ts` |
| `encontrar_cliente` | Solo lectura: busca clientes de `mve_clientes` por documento, nombres y apellidos, teléfono (celular, teléfono 1 y 2) o correo; marca documentos repetidos (**código listo, sin desplegar**) | `src/mcp/tools/clienteTool.ts` |
| `buscar_base` | Solo lectura: contactos de `notas_registros` sin llamadas (cruce con Asterisk) y vista previa con código de confirmación | `src/mcp/tools/baseTool.ts` |
| `aplicar_base` | Libera la base de `buscar_base` (normal o predictivo) en una transacción, solo si el código coincide | `src/mcp/tools/baseTool.ts` |
| `encerar_cupos` | Pone en 0 los cupos de `notas_registros_cupos` (dos pasos, solo a pedido) | `src/mcp/tools/baseTool.ts` |

- Código: 157 pruebas (`npm test`), typecheck, empaquetado Lambda y `npm audit` de producción en 0 vulnerabilidades (zod 4, body-parser y qs actualizados).
- Último despliegue: workflow "Deploy to production" **#21** (24-nov, PR #19 `pagos_facturacion` con `vista=pendiente`, `main` = `c39125a`). `/health` = 200, Lambda actualizada. CI en verde.
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
1. Las 12 primeras herramientas están desplegadas, probadas y **cerradas**. La 13.ª, `pagos_facturacion` (con `vista=pendiente`), está desplegada y **en prueba por otra persona**; el usuario traerá sus resultados.
2. **Fecha a vigilar:** el certificado de `bases.mvevip.com` (servicio `asterisk-gateway` en Server Docker) vence el **8-feb-2027**; se renueva solo con certbot, pero hay que comprobar que lo hizo.
3. **Seguridad: va en otro proyecto** (RDS público, permisos de `mcp_ro`, `GRANT` de `punch`) y también el historial de `asignar_base_usuario` / `encerar_cupo_usuario`. No tocar aquí.
4. **Ideas futuras, aparte (no pendientes):** `asistencia` (horas trabajadas, feriados, ausentes) y `cuadro_ventas` (rutas del PHP no incluidas, descuento de requerimientos, uso del campo `estado`).
5. **Operación:** usuarios actuales suficientes; se crean más solo cuando el usuario lo pida (comando en `docs/DEPLOY.md`, solo `@mvevip.com`). Para revocar todos los tokens, cambiar el secret `MCP_SIGNING_SECRET` y desplegar.
6. Ramas: en el remoto solo quedan `main` y la rama de trabajo (revisado el 24-nov).
7. **`saldo_cliente` (PENDIENTE, análisis hecho, sin código):** herramienta para saber si un ID de cliente tiene saldo pendiente en la empresa. El usuario la dejó en pausa el 24-nov para hacer otra más urgente. Todo lo analizado y la regla propuesta están en `MEMORIA.md` sección 4 («saldo_cliente»). Para retomar faltan las respuestas del usuario a: (a) si los saldos que da la regla en los 8 clientes de prueba coinciden con lo que él sabe, (b) qué pasó con el cliente 42758, (c) si basta con el saldo total sin separar vencido y por vencer (no hay fechas de vencimiento en los datos) y (d) si existe un PHP o reporte del CRM que muestre el saldo del cliente para compararlo.

## HISTORIAL DE LIBERACIONES: `historial_base` (desplegado el 19-nov: PR #16, despliegue #18)
`aplicar_base` registra cada liberación (lote en `mcp_base_lotes` y estado anterior de cada contacto en `mcp_base_historial`, en la misma transacción) y `historial_base` la consulta por contacto o por lote. Reglas en `MEMORIA.md` sección 4; DDL en `db/historial_base.sql`. No registra `asignar_base_usuario`, `encerar_cupo_usuario`, liberaciones anteriores ni las hechas a mano.

## EN PRUEBA: `pagos_facturacion` y su `vista=pendiente` (desplegadas el 24-nov, despliegues #20 y #21)
Abonos facturados (concepto, forma de pago, origen, destino, usuario) y, en `vista=pendiente`, lo que falta por facturar (abonos en estado 1 y 2 y pagos de ventas sin abono), separado de lo facturado y sin total combinado. Detalle en `MEMORIA.md` sección 4. 164 pruebas, typecheck, paquete y `npm audit` en 0.

## EN CURSO: `encontrar_cliente` (código listo en la rama de trabajo, SIN desplegar)
Busca clientes de `mve.mve_clientes` (53 894) por documento, nombres y apellidos, teléfono (por dígitos, en celular y teléfonos 1 y 2) o correo, con `id_cliente` (= `cli_codigo`), ciudad, vendedor y aviso de documentos repetidos (hay 1 498 repetidos en 3 382 clientes). Detalle en `MEMORIA.md` sección 4. El `GRANT` de clientes está aplicado (incluye `cli_estado` por error: se sugiere `REVOKE SELECT (cli_estado) ON mve.mve_clientes FROM 'mcp_ro'@'%'`). 176 pruebas, typecheck, paquete y `npm audit` en 0.

## SIGUIENTE PASO (para retomar)
"crea el PR y despliega" para `encontrar_cliente` (PR → merge → "Deploy to production" `ref=main` → `/health`); después el usuario prueba en el chat (quitar y volver a agregar el conector): buscar por celular con y sin 0 inicial, por cédula, por correo y por nombre en cualquier orden. Pendientes en espera, sin tocar: resultados de la prueba de `pagos_facturacion` por otra persona, `saldo_cliente` (punto 7 de PENDIENTES) y el análisis de tarjetas (`MEMORIA.md` sección 4; falta el PHP del Flujo de Caja y saber qué se quiere hacer).
