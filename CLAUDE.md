# mvevip-mcp — instrucciones para Claude

- Al iniciar una sesión, lee `ESTADO_PROYECTO.md` (estado, pendientes y SIGUIENTE PASO) y, si vas a tocar una herramienta, la sección correspondiente de `MEMORIA.md`
  (reglas de negocio acordadas, permisos de BD, trucos de operación). Si el usuario escribe **"continuemos"**, resume en 2-3 líneas dónde
  quedó el proyecto y presenta el apartado **SIGUIENTE PASO** tal cual está allí, sin repetir pasos ya hechos.
- **Nunca ejecutes SQL ni cambios en bases de datos**: entrega el script (verificaciones de solo lectura y `GRANT` por columna) y el usuario lo ejecuta y te pega los resultados.
- Avanza de a un paso y espera la confirmación del usuario antes del siguiente.
- **No crees PR salvo que el usuario lo pida.** Si dice "crea el PR y despliega": PR → merge → workflow "Deploy to production" (`ref=main`) → verifica `/health` → actualiza `ESTADO_PROYECTO.md`.
  Tras un PR fusionado, reinicia la rama de trabajo desde `origin/main` (`git checkout -B <rama> origin/main`, push con `--force-with-lease`).
- Actualiza `ESTADO_PROYECTO.md` al completar cada paso (marcar hecho, mover SIGUIENTE PASO y pendientes) y haz commit/push a la rama de trabajo.
- Nunca escribas contraseñas ni secretos en el repo (las contraseñas generadas de usuarios se entregan una sola vez en el chat).
- Herramienta nueva = flujo de `MEMORIA.md` sección 5: revisar la consulta o el PHP de referencia → scripts de verificación y `GRANT` → herramienta + esquema Zod + despacho en `src/index.ts` + pruebas
  (con una que reproduzca cifras reales) → desplegar solo después de que el usuario aplique los `GRANT`.
- Comandos: `npm run typecheck`, `npm test`, `npm run build`, `npm run package`, `npm audit --omit=dev --audit-level=high`. Documentación: `MEMORIA.md`, `docs/DEPLOY.md`.
