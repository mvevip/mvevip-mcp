# Despliegue a producción: `https://mcp.mvevip.com/mcp` (us-west-2)

Arquitectura: **Claude/ChatGPT → CloudFront (mcp.mvevip.com, certificado ACM) → Lambda Function URL → RDS**.
Login: usuario + contraseña → código de 6 dígitos por correo (Amazon SES) → vinculación (OAuth 2.0 + PKCE).
Despliegue: **Actions > "Deploy to production" > Run workflow** (o decirle a Claude "despliega").

Región: **us-west-2** (junto al RDS `database-mvevip`). Solo el certificado ACM de CloudFront vive en us-east-1.

## A. Configuración única (en este orden)

### 1. Base de datos (en el RDS existente)
```sql
-- Usuario de solo lectura para la base de negocio
CREATE USER 'mcp_ro'@'%' IDENTIFIED BY '<password-1>';
GRANT SELECT ON <base_negocio>.* TO 'mcp_ro'@'%';

-- Base y usuario de autenticación (las tablas se crean solas)
CREATE DATABASE mvevip_mcp_auth CHARACTER SET utf8mb4;
CREATE USER 'mcp_auth'@'%' IDENTIFIED BY '<password-2>';
GRANT ALL ON mvevip_mcp_auth.* TO 'mcp_auth'@'%';
```
El RDS `database-mvevip` es público, así que la Lambda va **sin VPC**. Si fuera privado, la Lambda debe ir en su VPC: anota subnets privadas y un security group con acceso al puerto 3306
(variables `VPC_SUBNET_IDS` / `VPC_SECURITY_GROUP_IDS`). Para que la Lambda salga a SES desde una VPC privada
necesita un NAT Gateway o un VPC endpoint de SES (`email-smtp` no; el de API es `com.amazonaws.us-west-2.email`).

### 2. Certificado para mcp.mvevip.com (ACM, us-east-1)
Ya existe un certificado `*.mvevip.com` emitido en us-east-1 que cubre `mcp.mvevip.com`; no hay que crear otro:
`arn:aws:acm:us-east-1:021891594659:certificate/1dae9056-0687-434c-a4ca-c20c76a9462f`

### 3. Rol OIDC para GitHub
```bash
aws cloudformation deploy --region us-west-2 --stack-name mvevip-mcp-github-oidc \
  --template-file infra/github-oidc-role.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubRepo=mvevip/mvevip-mcp CreateOidcProvider=false
# (la cuenta ya tiene el proveedor de GitHub; con 'true' el stack fallaría)
aws cloudformation describe-stacks --region us-west-2 --stack-name mvevip-mcp-github-oidc \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
```

### 4. GitHub > Settings > Environments > `production`
Variables:
| Variable | Valor |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | ARN del paso 3 |
| `AWS_REGION` | `us-west-2` |
| `ACM_CERTIFICATE_ARN` | ARN del paso 2 |
| `DOMAIN_NAME` | `mcp.mvevip.com` (por defecto) |
| `MAIL_FROM` | `MVEVIP <no-reply@mvevip.com>` (por defecto) |
| `CREATE_SES_IDENTITY` | `true` (por defecto); `false` si `mvevip.com` ya está verificado en SES us-west-2 |
| `DB_SSL` | `rds` (recomendado) |
| `VPC_SUBNET_IDS`, `VPC_SECURITY_GROUP_IDS` | solo si el RDS es privado |

Secrets: `MCP_SIGNING_SECRET` (`openssl rand -hex 32`), `ORIGIN_VERIFY_SECRET` (`openssl rand -hex 32`),
`DB_HOST`, `DB_USER` (`mcp_ro`), `DB_PASSWORD`, `DB_NAME`, `AUTH_DB_USER` (`mcp_auth`), `AUTH_DB_PASSWORD`.
Opcional: *Required reviewers* para aprobar cada despliegue.

### 5. Llevar los cambios a `main` y desplegar
El workflow manual solo aparece en Actions desde la rama por defecto. Luego: Run workflow (`ref=main`).

### 6. DNS (en tu proveedor, tras el primer despliegue)
El resumen del job y los outputs del stack (`aws cloudformation describe-stacks --stack-name mvevip-mcp`) muestran:
1. **CNAME `mcp` → `dxxxx.cloudfront.net`** (`DnsCnameForDomain`).
2. **3 CNAME de DKIM de SES** (`SesDkimName1..3` → `SesDkimValue1..3`) para verificar el dominio de correo.
   Mientras SES no esté verificado no se enviarán correos.
3. **Salir del sandbox de SES**: consola SES (us-west-2) > *Account dashboard* > *Request production access*.
   Mientras tanto SES solo envía a direcciones verificadas (puedes verificar las de tus usuarios de prueba).

### 7. Crear usuarios (sin registro público; solo un administrador con credenciales IAM)
```bash
aws lambda invoke --region us-west-2 --function-name mvevip-mcp-server \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mvevipAdmin":{"command":"create-user","username":"cmino","email":"cmino@mvevip.com"}}' out.json && cat out.json
```
Sin `password`, se genera una y se devuelve **una sola vez** (`generatedPassword`). Otros comandos:
`init`, `set-password`, `disable-user`, `enable-user`, `list-users` (mismo formato). Un usuario deshabilitado pierde
el acceso en máximo 60 s. En desarrollo local: `npx tsx scripts/auth-admin.ts create-user <usuario> <correo>`.

### 8. Conectar
- **Claude:** Personalizar > Conectores > Agregar conector personalizado > `https://mcp.mvevip.com/mcp`.
- **ChatGPT:** Ajustes > Conectores (modo desarrollador) > Crear > URL `https://mcp.mvevip.com/mcp`, autenticación OAuth.
- Se abre el login de MVEVIP: usuario y contraseña → llega el código por correo → ingrésalo → conectado.
- Prueba pidiendo "¿cómo vamos hoy?" (herramienta `cuadro_ventas`).

## Operación
- **Revocar todos los tokens:** cambiar el secret `MCP_SIGNING_SECRET` y desplegar.
- **Bloqueo de cuenta:** 5 contraseñas erróneas = 15 min bloqueada (guardado en BD, vale entre instancias).
  Código por correo: 10 min de vigencia, 5 intentos, un solo uso, máximo 3 envíos por usuario cada 10 min.
- **Logs:** CloudWatch `/aws/lambda/mvevip-mcp-server` (método, ruta, id de usuario y herramienta; sin SQL ni cabeceras).
- La Function URL directa queda protegida: solo responde si la petición trae el secreto de CloudFront.
- Los redirect URI permitidos incluyen Claude y ChatGPT; agrega más con `MCP_ALLOWED_REDIRECT_URIS` si hiciera falta.
- Los scripts `build_zip.ps1` / `deploy_aws.ps1` son del flujo anterior y están obsoletos.
- **Rutina para publicar un cambio:** PR a `main` → fusionar → Actions > "Deploy to production" (`ref=main`) o pedirle a Claude "crea el PR y despliega". El job repite typecheck y pruebas, actualiza el stack, sube el código y comprueba `/health` y que `/mcp` exija login. Tarda menos de un minuto cuando GitHub asigna runner (a veces queda en cola 10–25 min: esperar, no relanzar).
- **Herramienta que lee tablas o columnas nuevas:** el usuario debe aplicar antes el `GRANT SELECT` por columna a `mcp_ro`; si se despliega antes, la herramienta falla por permisos (ver `MEMORIA.md`, sección 3).
- **Un cliente nuevo no logra conectar** (p. ej. ChatGPT): buscar en CloudWatch la línea `[REGISTER] redirect_uri rechazado` y agregar esa URL a la lista de `src/config.ts` (o a `MCP_ALLOWED_REDIRECT_URIS`).
- **Correos de otro dominio:** SES está en sandbox (AWS denegó producción); solo llegan códigos a `@mvevip.com` o a direcciones verificadas en SES.
- Tras desplegar una herramienta nueva, el usuario debe quitar y volver a agregar el conector en Claude y ChatGPT para que aparezca.
