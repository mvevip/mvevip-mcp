# ESTADO DEL PROYECTO — mvevip-mcp (actualizado 30-oct-2026)

Servidor MCP remoto (TypeScript/Express/MySQL) para que Claude y ChatGPT consulten la BD de MVEVIP.
Destino: `https://mcp.mvevip.com/mcp` · AWS **us-west-2** (Lambda, SES, stack) + CloudFront/ACM (us-east-1) · RDS MySQL existente `database-mvevip` (us-west-2, público, sin VPC).
Detalle técnico: `MEMORIA.md` · Guía de despliegue paso a paso: `docs/DEPLOY.md`.

## Reglas de trabajo acordadas con el usuario (cmino@mvevip.com)
- **Nunca ejecutar nada en la base de datos**: Claude entrega el SQL y el usuario lo ejecuta.
- No hay nada desplegado en producción todavía (verificado: todo vive solo en el repo).
- El usuario ejecuta los comandos AWS desde su propio entorno; avanzar **de a un paso** y esperar confirmación.
- No crear PR salvo que lo pida. Rama de trabajo: `claude/modest-heisenberg-3mvjqy`.
- Los secretos/contraseñas NO se guardan en el repo (están en el gestor de contraseñas del usuario).

## Hecho
- [x] Código: seguridad endurecida, OAuth 2.0 + PKCE, login usuario/contraseña + código de 6 dígitos por correo (SES),
      BD de autenticación, guard SQL de solo lectura, 71 pruebas (`npm test`), build y bundle Lambda OK.
- [x] CI (`.github/workflows/ci.yml`) y deploy manual (`deploy.yml`, OIDC → CloudFormation `infra/template.yaml`).
- [x] **Paso 1 – BD (ejecutado por el usuario en el RDS y verificado):**
      - Usuario `mcp_ro` con SOLO `SELECT` sobre la base de negocio **`vtgsa_ventas`** → secret `DB_NAME=vtgsa_ventas`, `DB_USER=mcp_ro`.
      - Base `mvevip_mcp_auth` + usuario `mcp_auth` (CREATE, INDEX, SELECT, INSERT, UPDATE, DELETE solo sobre esa base)
        → secrets `AUTH_DB_USER=mcp_auth`; `AUTH_DB_NAME` por defecto `mvevip_mcp_auth`.
      - Las contraseñas (`mcp_ro`, `mcp_auth`), `MCP_SIGNING_SECRET` y `ORIGIN_VERIFY_SECRET` fueron generadas en la sesión
        anterior; el usuario debe tenerlas en su gestor (si se perdieron: generar nuevas y re-ejecutar `ALTER USER` en la BD).

## Decisiones tomadas
- Región us-west-2 (decidido 22-oct, junto al RDS). Dominio `mcp.mvevip.com`. DNS en proveedor externo (no Route 53) → CNAME manuales.
- Usuarios creados solo por un administrador (`aws lambda invoke` con payload `mvevipAdmin`), sin auto-registro.
- SES: dominio `mvevip.com` NO verificado aún / estado desconocido → el stack lo crea (`CREATE_SES_IDENTITY=true`) y
  entrega 3 CNAME DKIM; hay que pedir salida del sandbox de SES.
- ChatGPT y Claude permitidos como clientes OAuth (verificar redirect URIs al conectar).

- [x] **Paso 3 – Rol OIDC creado (22-oct, desde Claude):** stack `mvevip-mcp-github-oidc` en us-west-2, CREATE_COMPLETE.
- [x] **Paso 5 – Despliegue (workflow #4, 30-oct):** stack `mvevip-mcp` OK en us-west-2; endpoint CloudFront `d3enxcswftihjc.cloudfront.net`.
- [x] **Paso 6 – DNS y SES (30-oct):** 4 CNAME creados (mcp + 3 DKIM); `https://mcp.mvevip.com/health` = 200; SES `mvevip.com` verificado (DKIM SUCCESS).
      Solicitud de acceso a producción de SES enviada por Claude (estado PENDING, ~24 h). Mientras tanto SES envía solo a
      direcciones del dominio verificado `mvevip.com` (sandbox, 200/día).
- [x] **Paso 7 – Usuario `cmino` creado (30-oct, vía Lambda `mvevipAdmin`):** id 1, correo cmino@mvevip.com. Contraseña generada entregada
      una sola vez en el chat (guardarla en el gestor; si se pierde: comando `set-password`).
- [x] **Paso 8 – Conector en producción (30-oct):** login + código por correo OK; `test_db_connection` exitoso desde Claude
      (host RDS, BD `vtgsa_ventas`, MySQL 8.4.8, latencia 41 ms). El MCP ya es funcional.
- [x] **Paso 13a – Herramienta `requerimientos` escrita (30-oct, sin desplegar):** `src/mcp/tools/requerimientosTool.ts`. Requerimientos = devoluciones y reclamos de ventas de asesores (tabla
      `requerimientos`). Reglas acordadas: se cuentan siempre en el mes en que se INGRESARON (`fecha_requerimiento`, tipo date), se muestra también `fecha_venta` y `fecha_alta` (hora de registro);
      su valor se DESCUENTA de la comisión del asesor; el campo `estado` no se usa por ahora. Parámetros: mes, anio, fecha_desde/fecha_hasta (inclusive), agrupar_por (ninguno, asesor), ordenar_por, direccion.
      `reporte_ventas_mes` ganó `incluir_requerimientos`: por asesor agrega requerimientos_cantidad, requerimientos_valor y comision_neta (= comision_asesor − requerimientos_valor; incluye
      asesores con requerimientos y sin ventas); con otras agrupaciones solo en los totales. El asesor se resuelve con el mismo nombre de `mve_usuarios` (o `usuarios.usuario_crm`).
      Utilidades de fechas movidas a `src/mcp/tools/dates.ts`. 71 pruebas. Sin índice en `fecha_requerimiento` (tabla de ~200 filas, no hace falta).
- [x] **Paso 12b – Limpieza desplegada (30-oct):** PR #6 fusionado y deploy #10 exitoso.
- [x] **Paso 12a – Limpieza de herramientas (30-oct):** a pedido del usuario se eliminaron `test_db_connection`, `describe_database`, `get_table_schema` y
      `query_database_sample` (código, esquemas, métodos de `dbService` y pruebas). Quedan solo `reporte_ventas_mes` y `cuadro_ventas`. Ya no hay SQL libre desde el chat.
      `MEMORIA_SESION.md` y `referencia/` son históricos y siguen mencionándolas.
- [x] **Paso 11c – Conector en ChatGPT funcionando (30-oct):** confirmado por el usuario tras el deploy #9; la causa era la URL de retorno nueva de ChatGPT y el metadato con sufijo de ruta.
- [x] **Paso 11b – Desplegado (30-oct):** PR #5 fusionado y deploy #9 exitoso; `/.well-known/oauth-protected-resource/mcp` = 200 y `/register` acepta `https://chatgpt.com/connector/oauth/<id>`.
- [x] **Paso 11a – Dependencias y compatibilidad con ChatGPT (30-oct):** `npm audit` en 0 (body-parser y qs con `npm audit fix`; zod migrado a v4; el CI debe volver a verde).
      ChatGPT (registro dinámico, DCR) fallaba al crear el conector: los registros mostraron que pedía `/.well-known/oauth-protected-resource/mcp` (404) y llamaba a `/register` sin llegar a `/authorize`.
      Cambios: ese metadato con sufijo de ruta (RFC 9728), redirect URIs de ChatGPT `https://chatgpt.com/connector/oauth/<id>` y `https://platform.openai.com/apps-manage/oauth`,
      y log de los `redirect_uri` rechazados en `/register`. Hipótesis (no confirmada hasta probar): la URL de retorno nueva era rechazada.
      SES: ya no es pendiente; el MCP es solo para correos @mvevip.com (dominio verificado, el sandbox no afecta).
- [x] **Paso 10b – `cuadro_ventas` desplegado (30-oct):** PR #4 fusionado y deploy #8 exitoso.
- [x] **Paso 10a – Herramienta `cuadro_ventas` escrita (30-oct):** `src/mcp/tools/cuadroTool.ts`, parámetro opcional `fecha` (hoy en America/Guayaquil).
      Devuelve resumen (tarjetas), días laborables, equipos (= tabla `lideres`, sigla con iniciales), grupos (= `usuarios_agrupaciones`, por asesor), líderes por cierres y
      ventas del día por asesor. Reglas acordadas: estados 9 y 13 siempre excluidos (también en Grupos); ventas = `abono_pagado` (SUM `valor_voucher`), NO `pago_cuadro`;
      metas contra comisión; meta diaria = meta mensual / días laborables; laborables = lunes a viernes menos `cuadro_feriados` (una sola vez; el PHP `utiles.php` los restaba dos veces
      y restaba un día extra a los restantes); restantes = laborables posteriores a la fecha, mínimo 0. Octubre 2026: feriado 9-oct → 21 laborables.
      Duplicados de `usuarios.id_referencia`: todos son `id_referencia = 0` (personal no vendedor); la unión con asesores ignora el 0 y toma un registro por vendedor.
      Prueba con las cifras de la pantalla del 30-oct (ventas mes 214 430,14; comisión 180 995,13; falta hoy 13 235,71). No incluidas: islas, ranking, dados, parejas, cuadro-octubre, pantalla.
- [x] **Paso 9c – Ajuste de líderes desplegado (30-oct):** PR #3 fusionado y deploy #7 exitoso (el #6 se canceló por cola atascada de GitHub Actions).
- [x] **Paso 9b – Desplegado (30-oct):** PR #2 fusionado a `main` y workflow "Deploy to production" #5 exitoso.
- [x] **Paso 9a – Herramienta `reporte_ventas_mes` escrita (30-oct, sin desplegar):** `src/mcp/tools/salesReportTool.ts`.
      Reglas: fecha de venta, mes actual en America/Guayaquil, estados 9 y 13 excluidos (anulados, fijo en SQL), todos los líderes (sin filtrar estado ni visual, para comparar meses; ajuste 30-oct),
      abonos/comisión = suma de todos los pagos de la venta. Parámetros: mes, anio, agrupar_por (asesor, lider, lider_asistente, ciudad, contrato,
      tipo_contrato), ordenar_por (lista cerrada), direccion. Siempre devuelve totales del mes. Mejoras vs consulta original: rango de fechas
      semiabierto, pagos limitados al período, join de usuarios sin duplicados. GRANT por columna a `mcp_ro` sobre `mve` aplicado por el usuario.
      Confirmado con el usuario: `usuarios.id_referencia` tiene 72 valores repetidos reales (0 NULL; el join los deduplica con MIN(id_usuario_crm)),
      y `registros_pagos.estado` no se usa (un pago anulado se elimina).
- [x] **Paso 4 – Environment `production` configurado (30-oct, verificado con capturas):** 4 variables
      (`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `ACM_CERTIFICATE_ARN`, `DB_SSL`) y 8 secrets; despliegue restringido a la rama `main`.

## Verificación AWS (22-oct, cuenta 021891594659, usuario admin-cli)
- No hay nada del MCP desplegado (sin stacks, Lambdas ni CloudFront `mcp.mvevip.com`). SES sin identidades, en sandbox (200/día).
- **Paso 2 resuelto:** ya existe certificado `*.mvevip.com` ISSUED en us-east-1:
  `arn:aws:acm:us-east-1:021891594659:certificate/1dae9056-0687-434c-a4ca-c20c76a9462f` → variable `ACM_CERTIFICATE_ARN`.
- El proveedor OIDC de GitHub ya existe → desplegar el rol con `CreateOidcProvider=false`.
- RDS público (acordado por ahora; la seguridad se resolverá en otro proyecto). **No modificar el RDS**: solo SQL entregado al usuario.
- Plantillas/docs ya adaptados a us-west-2 (cfn-lint limpio, 53 pruebas OK).

## SIGUIENTE PASO
**Paso 13b – Desplegar y probar `requerimientos`** (PR + merge a `main` + "Deploy to production"; solo si el usuario lo pide). Probar en el chat:
"lista de requerimientos del mes", "¿ingresó un requerimiento hoy?", "ventas por asesor incluido requerimientos". Referencia (octubre 2026, al 30-oct):
8 requerimientos · valor total 4 134,00.
Pendiente de decidir con el usuario: si el `cuadro_ventas` (comisión del mes y avance contra meta) también debe descontar los requerimientos.
Luego: valores del cuadro que el usuario revisa y enviará como ajustes; nuevas herramientas; usuarios con `aws lambda invoke` (`create-user`), solo @mvevip.com.

## Pasos restantes (en orden)
3. (HECHO) Rol OIDC para GitHub: desplegar `infra/github-oidc-role.yaml` (us-west-2, `CreateOidcProvider=false`) y obtener `DeployRoleArn`.
4. (HECHO) GitHub → Settings → Environments → `production`: variables (`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION=us-west-2`,
   `ACM_CERTIFICATE_ARN`, `DB_SSL=rds`, VPC si aplica…) y secrets (`MCP_SIGNING_SECRET`, `ORIGIN_VERIFY_SECRET`,
   `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=vtgsa_ventas`, `AUTH_DB_USER`, `AUTH_DB_PASSWORD`). Ver tabla en `docs/DEPLOY.md`.
5. (HECHO) El código ya está en `main` (PR #1). Ejecutar el workflow "Deploy to production" (`ref=main`).
6. (HECHO) DNS tras el primer despliegue: CNAME `mcp` → CloudFront; 3 CNAME DKIM de SES; solicitar producción en SES.
7. (HECHO) Crear el primer usuario con `aws lambda invoke` (comando en `docs/DEPLOY.md`, paso 7).
8. (HECHO) Conectar `https://mcp.mvevip.com/mcp` en Claude y ChatGPT; probar `test_db_connection`.
9. Después: herramientas de negocio específicas (ventas por asesor/líder, etc.) con SQL probado — requiere que el usuario
   indique tablas y consultas de referencia de `vtgsa_ventas`.
