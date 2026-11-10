# asterisk-gateway

Servicio pequeño, **solo lectura**, que corre en "Server Docker" (192.168.0.211) y resume las llamadas de Asterisk (`cdr`) para la herramienta `buscar_base` del MCP.
El MCP (AWS Lambda) lo llama por HTTPS; el servicio consulta Asterisk (192.168.0.40) por la red local. **No se abre el puerto 3306 a internet.**

- `POST /cdr/resumen` (requiere `Authorization: Bearer <GATEWAY_TOKEN>`): cuerpo `{"telefonos":["0969816358",...],"desde":"2026-01-01","hasta":"2026-12-31"}` (`hasta` inclusivo, teléfonos de 10 dígitos con 0 inicial, hasta 5000, rango máximo 1100 días).
  Respuesta: por teléfono con llamadas, `{dst, llamadas, duracion, billsec, ultima_llamada}` (suma de todas las llamadas del rango). Un teléfono que no aparece = sin registro.
- `GET /health`: `{"ok":true}` (no toca la base).
- Seguridad: token largo (comparación en tiempo constante), límite de 60 solicitudes/min y 10 fallos/min por IP, cuerpo máx. 300 KB, solo consultas con valores enlazados sobre `cdr`, usuario de BD con `SELECT` solo en `calldate, dst, duration, billsec`. Caddy emite y renueva el certificado (Let's Encrypt) para `GATEWAY_DOMAIN`.

## Instalación en Server Docker (la hace el usuario)
1. Reiniciar el servidor si tiene "System restart required". Verificar que 80 y 443 estén libres:
   `sudo ss -tlnp | grep -E ':(80|443) '` (si algo los usa, avisar antes de seguir).
2. Copiar esta carpeta (`asterisk-gateway/`) al servidor (por ejemplo `scp -r asterisk-gateway admin-docker@192.168.0.211:~/`).
3. `cd ~/asterisk-gateway && cp .env.example .env` y completar `.env`: `GATEWAY_TOKEN` (`openssl rand -hex 32`) y `DB_PASSWORD` del usuario `lectura`. `chmod 600 .env`. El token y la clave **no** se suben al repositorio.
4. `docker compose up -d --build` y `docker compose logs -f` (Caddy debe obtener el certificado; requiere el DNS `bases.mvevip.com` y los puertos 80/443 abiertos en Meraki).
5. Probar:
   - `curl https://bases.mvevip.com/health` → `{"ok":true}` (probar también desde fuera de la red de la oficina).
   - `curl -s https://bases.mvevip.com/cdr/resumen -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"telefonos":["0969816358","0987502584"],"desde":"2026-01-01","hasta":"2026-12-31"}'`

## Operación
- Actualizar: copiar los archivos nuevos y `docker compose up -d --build`.
- Cambiar el token: editar `.env`, `docker compose up -d`, y actualizar el secret del MCP.
- Si responde `asterisk_no_disponible` (502): revisar `docker compose logs gateway` (código de error de MySQL) y el `GRANT` de `lectura`.
