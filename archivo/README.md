# Archivo histórico

Material que ya no se usa en el servidor vigente, conservado como memoria del proyecto (también está en el historial de git).
El estado actual está en `../ESTADO_PROYECTO.md`, la memoria técnica en `../MEMORIA.md` y el despliegue en `../docs/DEPLOY.md`.

| Archivo | Qué es | Por qué quedó fuera de uso |
|---|---|---|
| `MEMORIA_SESION.md` | Memoria de la primera sesión (7-oct-2026): servidor Docker local con clave corporativa y herramientas genéricas de BD | Esa versión ya no existe |
| `Dockerfile`, `docker-compose.yml` | Ejecución local con Docker (puerto 6420) | Se despliega en AWS Lambda con CloudFormation |
| `build_zip.ps1` | Empaquetado PowerShell de `function.zip` | Lo reemplaza `npm run package` (`scripts/package-lambda.mjs`) |
| `deploy_aws.ps1` | Despliegue manual a Lambda con el perfil local `marketingvip` y Function URL | Lo reemplaza el workflow "Deploy to production" (OIDC + CloudFormation) |
| `referencia/guia.md`, `referencia/deploy.md` | Guías de otro proyecto (`mcp-lead-sales-automation`, Lambda en us-east-2) | No pertenecen a este servidor |

Nota: los enlaces internos de estos archivos apuntan a rutas de la raíz antigua y ya no funcionan.
