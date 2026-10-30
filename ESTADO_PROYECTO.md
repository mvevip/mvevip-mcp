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
      BD de autenticación, guard SQL de solo lectura, 59 pruebas (`npm test`), build y bundle Lambda OK.
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
**Paso 9d – Probar en el chat la comparación mes actual vs mes anterior** con `reporte_ventas_mes` (ya sin filtro de líderes por estado/visual).
Pendientes aparte: (1) SES: AWS **denegó** el acceso a producción (caso 179337882700292) → solo llegan códigos a direcciones @mvevip.com
(dominio verificado) o a correos externos verificados uno a uno; apelar el caso o verificar direcciones al crear usuarios externos.
(2) Dependencias con avisos de `npm audit` (body-parser y qs con `npm audit fix`; zod requiere migrar a v4): el job CI está en rojo por eso.

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
