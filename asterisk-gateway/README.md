# asterisk-gateway

Servicio pequeño, **solo lectura**, que corre en "Server Docker" (192.168.0.211) y resume las llamadas de Asterisk (`cdr`) para la herramienta `buscar_base` del MCP.
El MCP (AWS Lambda) lo llama por HTTPS; el servicio consulta Asterisk (192.168.0.40) por la red local. **No se abre el puerto 3306 a internet.**

- `POST /cdr/resumen` (requiere `Authorization: Bearer <GATEWAY_TOKEN>`): cuerpo `{"telefonos":["0969816358",...],"desde":"2026-01-01","hasta":"2026-12-31"}` (`hasta` inclusivo, teléfonos de 10 dígitos con 0 inicial, hasta 5000, rango máximo 1100 días).
  Respuesta: por teléfono con llamadas, `{dst, llamadas, duracion, billsec, ultima_llamada}` (suma de todas las llamadas del rango). Un teléfono que no aparece = sin registro.
- `GET /health`: `{"ok":true}` (no toca la base).
- Seguridad: token largo (comparación en tiempo constante), límite de 60 solicitudes/min y 10 fallos/min por IP, cuerpo máx. 300 KB, solo consultas con valores enlazados sobre `cdr`, usuario de BD con `SELECT` solo en `calldate, dst, duration, billsec`. El HTTPS lo publica el nginx que ya corre en el servidor (certificado Let's Encrypt con certbot para `bases.mvevip.com`); el servicio solo escucha en `127.0.0.1:18080`.

## Instalación en Server Docker (la hace el usuario)
1. Reiniciar el servidor si tiene "System restart required".
2. Obtener el código (rama de trabajo hasta que se fusione): `git clone --depth 1 -b claude/eager-bell-u1yr44 https://github.com/mvevip/mvevip-mcp.git ~/mvevip-mcp` (el repositorio es privado: usuario de GitHub y, como contraseña, un token fine-grained de solo lectura de "Contents" para este repositorio, con vencimiento corto). Alternativa: copiar la carpeta desde un PC con `scp -r asterisk-gateway admin-docker@192.168.0.211:~/`.
3. `cd ~/mvevip-mcp/asterisk-gateway && cp .env.example .env` (si los archivos vienen de Windows: `sed -i "s/\r$//" .env .env.example docker-compose.yml Dockerfile nginx-bases.conf`), completar `GATEWAY_TOKEN` (`openssl rand -hex 32`) y `DB_PASSWORD` del usuario `lectura`, y `chmod 600 .env`. El token y la clave **no** se suben al repositorio.
4. `docker compose up -d --build`, `docker compose logs gateway` y `curl -s http://127.0.0.1:18080/health` → `{"ok":true}`.
5. HTTPS con el nginx existente: copiar `nginx-bases.conf` a `/etc/nginx/sites-available/bases.mvevip.com`, enlazarlo en `sites-enabled` (o ponerlo en `conf.d` si así trabaja ese nginx), `sudo nginx -t`, `sudo systemctl reload nginx`, y `sudo certbot --nginx -d bases.mvevip.com` (elegir redirección a HTTPS; si falta: `sudo apt install certbot python3-certbot-nginx`). Requiere el DNS `bases.mvevip.com` y el puerto 80 abiertos en Meraki (443 también, para el acceso desde AWS).
6. Probar desde fuera de la oficina (por ejemplo el celular con datos móviles):
   - `curl https://bases.mvevip.com/health` → `{"ok":true}`
   - `curl -s https://bases.mvevip.com/cdr/resumen -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"telefonos":["0969816358","0987502584"],"desde":"2026-01-01","hasta":"2026-12-31"}'`

## Operación
- Actualizar: copiar los archivos nuevos y `docker compose up -d --build`.
- Cambiar el token: editar `.env`, `docker compose up -d`, y actualizar el secret del MCP.
- Si responde `asterisk_no_disponible` (502): revisar `docker compose logs gateway` (código de error de MySQL) y el `GRANT` de `lectura`.
