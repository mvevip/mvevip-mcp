import http from 'node:http';
import { ErrorHttp, construirConsulta, crearLimitador, lotes, tokenValido, validarSolicitud } from './logic.mjs';

const MAX_CUERPO = 300 * 1024;

function responder(res, status, objeto) {
  const cuerpo = JSON.stringify(objeto);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(cuerpo);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let tamano = 0;
    const partes = [];
    req.on('data', (c) => {
      tamano += c.length;
      if (tamano > MAX_CUERPO) {
        reject(new ErrorHttp(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || 'null'));
      } catch {
        reject(new ErrorHttp(400, 'json_invalido', 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{config:{token:string,cdrDb:string}, consultar:(sql:string, params:any[])=>Promise<any[]>, log?:(l:string)=>void}} deps
 */
export function crearApp({ config, consultar, log = () => {} }) {
  const permitirGeneral = crearLimitador(60, 60_000);
  const permitirFallos = crearLimitador(10, 60_000);

  return http.createServer(async (req, res) => {
    const inicio = Date.now();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    let status = 500;
    let info = '';
    try {
      const ruta = (req.url || '').split('?')[0];
      if (req.method === 'GET' && ruta === '/health') {
        status = 200;
        return responder(res, 200, { ok: true });
      }
      if (req.method !== 'POST' || ruta !== '/cdr/resumen') {
        status = 404;
        return responder(res, 404, { error: 'no_encontrado' });
      }
      if (!permitirGeneral(ip)) {
        status = 429;
        return responder(res, 429, { error: 'demasiadas_solicitudes' });
      }
      if (!tokenValido(req.headers.authorization, config.token)) {
        status = permitirFallos(ip) ? 401 : 429;
        return responder(res, status, { error: status === 401 ? 'no_autorizado' : 'demasiadas_solicitudes' });
      }
      const s = validarSolicitud(await leerCuerpo(req));
      info = ` telefonos=${s.telefonos.length}`;
      const registros = [];
      try {
        for (const lote of lotes(s.telefonos)) {
          const { sql, params } = construirConsulta(config.cdrDb, lote, s.desde, s.hastaExcl);
          for (const f of await consultar(sql, params)) {
            registros.push({
              dst: String(f.dst),
              llamadas: Number(f.llamadas),
              duracion: Number(f.duracion),
              billsec: Number(f.billsec),
              ultima_llamada: f.ultima_llamada
            });
          }
        }
      } catch (e) {
        log(`[ERROR] consulta a Asterisk: ${e && e.code ? e.code : 'desconocido'}`);
        status = 502;
        return responder(res, 502, { error: 'asterisk_no_disponible' });
      }
      status = 200;
      return responder(res, 200, { desde: s.desde, hasta: s.hasta, telefonos_consultados: s.telefonos.length, registros });
    } catch (e) {
      if (e instanceof ErrorHttp) {
        status = e.status;
        return responder(res, e.status, { error: e.codigo, mensaje: e.message });
      }
      log(`[ERROR] ${e && e.message ? e.message : 'error'}`);
      status = 500;
      return responder(res, 500, { error: 'error_interno' });
    } finally {
      log(`${req.method} ${(req.url || '').split('?')[0]} ${status} ${Date.now() - inicio}ms${info}`);
    }
  });
}
