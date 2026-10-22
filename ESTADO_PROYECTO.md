# ESTADO DEL PROYECTO — mvevip-mcp (actualizado 22-oct-2026)

Servidor MCP remoto (TypeScript/Express/MySQL) para que Claude y ChatGPT consulten la BD de MVEVIP.
Destino: `https://mcp.mvevip.com/mcp` · AWS **us-east-1** · Lambda + Function URL detrás de CloudFront · RDS MySQL existente.
Detalle técnico: `MEMORIA.md` · Guía de despliegue paso a paso: `docs/DEPLOY.md`.

## Reglas de trabajo acordadas con el usuario (cmino@mvevip.com)
- **Nunca ejecutar nada en la base de datos**: Claude entrega el SQL y el usuario lo ejecuta.
- No hay nada desplegado en producción todavía (verificado: todo vive solo en el repo).
- El usuario ejecuta los comandos AWS desde su propio entorno; avanzar **de a un paso** y esperar confirmación.
- No crear PR salvo que lo pida. Rama de trabajo: `claude/modest-heisenberg-3mvjqy`.
- Los secretos/contraseñas NO se guardan en el repo (están en el gestor de contraseñas del usuario).

## Hecho
- [x] Código: seguridad endurecida, OAuth 2.0 + PKCE, login usuario/contraseña + código de 6 dígitos por correo (SES),
      BD de autenticación, guard SQL de solo lectura, 53 pruebas (`npm test`), build y bundle Lambda OK.
- [x] CI (`.github/workflows/ci.yml`) y deploy manual (`deploy.yml`, OIDC → CloudFormation `infra/template.yaml`).
- [x] **Paso 1 – BD (ejecutado por el usuario en el RDS y verificado):**
      - Usuario `mcp_ro` con SOLO `SELECT` sobre la base de negocio **`vtgsa_ventas`** → secret `DB_NAME=vtgsa_ventas`, `DB_USER=mcp_ro`.
      - Base `mvevip_mcp_auth` + usuario `mcp_auth` (CREATE, INDEX, SELECT, INSERT, UPDATE, DELETE solo sobre esa base)
        → secrets `AUTH_DB_USER=mcp_auth`; `AUTH_DB_NAME` por defecto `mvevip_mcp_auth`.
      - Las contraseñas (`mcp_ro`, `mcp_auth`), `MCP_SIGNING_SECRET` y `ORIGIN_VERIFY_SECRET` fueron generadas en la sesión
        anterior; el usuario debe tenerlas en su gestor (si se perdieron: generar nuevas y re-ejecutar `ALTER USER` en la BD).

## Decisiones tomadas
- Región us-east-1. Dominio `mcp.mvevip.com`. DNS en proveedor externo (no Route 53) → CNAME manuales.
- Usuarios creados solo por un administrador (`aws lambda invoke` con payload `mvevipAdmin`), sin auto-registro.
- SES: dominio `mvevip.com` NO verificado aún / estado desconocido → el stack lo crea (`CREATE_SES_IDENTITY=true`) y
  entrega 3 CNAME DKIM; hay que pedir salida del sandbox de SES.
- ChatGPT y Claude permitidos como clientes OAuth (verificar redirect URIs al conectar).

## SIGUIENTE PASO (cuando el usuario diga "continuemos")
**Paso 2 – Certificado ACM para `mcp.mvevip.com` en us-east-1** (consola AWS o CLI):
1. ACM (región N. Virginia) → solicitar certificado público, dominio `mcp.mvevip.com`, validación DNS.
2. Crear en el DNS de mvevip.com el CNAME de validación (si es Cloudflare: solo DNS, sin proxy).
3. Esperar estado **Emitido** y entregar el **ARN** → será la variable de GitHub `ACM_CERTIFICATE_ARN`.
Pendiente de preguntar al usuario: **¿el RDS es público o privado (VPC)?** (define si la Lambda lleva VPC:
`VPC_SUBNET_IDS`, `VPC_SECURITY_GROUP_IDS`, y NAT/endpoint de SES para enviar correo).

## Pasos restantes (en orden)
3. Rol OIDC para GitHub: desplegar `infra/github-oidc-role.yaml` (us-east-1) y obtener `DeployRoleArn`.
4. GitHub → Settings → Environments → `production`: variables (`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION=us-east-1`,
   `ACM_CERTIFICATE_ARN`, `DB_SSL=rds`, VPC si aplica…) y secrets (`MCP_SIGNING_SECRET`, `ORIGIN_VERIFY_SECRET`,
   `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=vtgsa_ventas`, `AUTH_DB_USER`, `AUTH_DB_PASSWORD`). Ver tabla en `docs/DEPLOY.md`.
5. Llevar la rama a `main` (PR si el usuario lo pide) y ejecutar el workflow "Deploy to production" (`ref=main`).
6. DNS tras el primer despliegue: CNAME `mcp` → CloudFront; 3 CNAME DKIM de SES; solicitar producción en SES.
7. Crear el primer usuario con `aws lambda invoke` (comando en `docs/DEPLOY.md`, paso 7).
8. Conectar `https://mcp.mvevip.com/mcp` en Claude y ChatGPT; probar `test_db_connection`.
9. Después: herramientas de negocio específicas (ventas por asesor/líder, etc.) con SQL probado — requiere que el usuario
   indique tablas y consultas de referencia de `vtgsa_ventas`.
