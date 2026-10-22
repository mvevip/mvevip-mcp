# mvevip-mcp — instrucciones para Claude

- Al iniciar una sesión, lee `ESTADO_PROYECTO.md`. Si el usuario escribe **"continuemos"**, resume en 2-3 líneas dónde
  quedó el proyecto y presenta el apartado **SIGUIENTE PASO** tal cual está allí, sin repetir pasos ya hechos.
- **Nunca ejecutes SQL ni cambios en bases de datos**: entrega el script y el usuario lo ejecuta.
- Avanza de a un paso y espera la confirmación del usuario antes del siguiente.
- Actualiza `ESTADO_PROYECTO.md` al completar cada paso (marcar hecho, mover SIGUIENTE PASO) y haz commit/push a la rama de trabajo.
- Nunca escribas contraseñas ni secretos en el repo.
- Comandos: `npm run typecheck`, `npm test`, `npm run build`, `npm run package`. Documentación: `MEMORIA.md`, `docs/DEPLOY.md`.
