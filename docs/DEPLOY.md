# Despliegue a producción (GitHub Actions + AWS Lambda)

Flujo: **Actions > "Deploy to production" > Run workflow** (o decirle a Claude "despliega").
El workflow ejecuta typecheck y pruebas, empaqueta con esbuild, actualiza la infraestructura
(CloudFormation, `infra/template.yaml`), sube el código y verifica `/health` y que `/mcp` exija token.

## Configuración única

1. **Rol OIDC en AWS** (cuenta de producción, con un administrador):
   ```bash
   aws cloudformation deploy --region <REGION> --stack-name mvevip-mcp-github-oidc \
     --template-file infra/github-oidc-role.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubRepo=mvevip/mvevip-mcp
   # Si la cuenta ya tiene el proveedor OIDC de GitHub: CreateOidcProvider=false
   ```
   Copiar el output `DeployRoleArn`. Solo puede asumirlo el environment `production` de este repo.
2. **GitHub > Settings > Environments > `production`** (activar *Required reviewers* si se quiere aprobación manual):
   - Variables: `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION` (ej. `us-east-2`), opcionales `DB_PORT`, `DB_SSL` (`rds`|`true`),
     `VPC_SUBNET_IDS`, `VPC_SECURITY_GROUP_IDS` (comas; necesarias si la BD/RDS es privada).
   - Secrets: `MCP_ACCESS_KEY` (`openssl rand -base64 24`), `MCP_SIGNING_SECRET` (`openssl rand -hex 32`),
     `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
3. **Usuario MySQL de solo lectura** (`GRANT SELECT` únicamente). Es la defensa principal; el filtro SQL del servidor es secundaria.
4. El workflow de deploy solo aparece en Actions cuando está en la rama por defecto (`main`).

## Después del primer despliegue
El resumen del job muestra la URL del conector (`https://<id>.lambda-url.<region>.on.aws/mcp`).
Registrarla en Claude (Personalizar > Conectores) e ingresar `MCP_ACCESS_KEY` en la pantalla de MVEVIP.

## Operación
- **Revocar todos los tokens:** cambiar el secret `MCP_SIGNING_SECRET` y volver a desplegar.
- **Rotar la clave de acceso:** cambiar `MCP_ACCESS_KEY` y desplegar (los tokens existentes siguen vigentes hasta rotar la firma).
- **Logs:** CloudWatch `/aws/lambda/mvevip-mcp-server` (solo método, ruta y nombre de herramienta; sin consultas ni cabeceras).
- **Limitación conocida:** el límite de intentos de login es en memoria por instancia Lambda; la clave larga y aleatoria es la protección real.
- Los scripts `build_zip.ps1` / `deploy_aws.ps1` son del flujo anterior y quedan obsoletos.
