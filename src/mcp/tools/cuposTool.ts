import { BaseDeps, defaultDeps, falla, generarCodigo, numero, texto, validarCodigo } from './baseTool';
import { likePattern } from './asistenciaTool';

/**
 * Herramientas asignar_base_usuario y encerar_cupo_usuario (tabla notas_registros_cupos).
 *
 * `cupo` es el acumulado que se le asigna al asesor para un banco + identificador y `total_asignado` lo que el CRM ya le
 * entregó; lo pendiente es cupo - total_asignado. mcp_base no puede leer `total_asignado` ni `id_cupo`: la vista previa
 * lee con mcp_ro y la escritura usa valores absolutos con comprobación del cupo anterior, dentro de una transacción.
 */
export const CUPO_MAXIMO_POR_ASESOR = 500;
export type ModoAsignacion = 'sumar' | 'fijar';

export interface AsignacionParam {
  usuario: string | number;
  cupo?: number;
}
export interface AsignarBaseUsuarioParams {
  identificador?: string;
  banco?: number;
  usuarios?: AsignacionParam[];
  cupo?: number;
  modo?: ModoAsignacion;
  codigo_confirmacion?: string;
}
export interface EncerarCupoUsuarioParams {
  usuarios?: Array<string | number>;
  identificador?: string;
  banco?: number;
  codigo_confirmacion?: string;
}

// ---------------------------------------------------------------------------
// SQL (valores siempre enlazados)
// ---------------------------------------------------------------------------
const marcas = (n: number) => Array(n).fill('?').join(',');
export const SQL_IDENTIFICADORES_RECIENTES =
  'SELECT id_banco, id_identificador, MAX(id_cupo) AS ultimo FROM notas_registros_cupos GROUP BY id_banco, id_identificador ORDER BY ultimo DESC LIMIT 10';
export const SQL_BANCOS_DEL_IDENTIFICADOR =
  'SELECT DISTINCT id_banco, id_identificador FROM notas_registros_cupos WHERE id_identificador = ?';
export const SQL_BANCOS_DEL_IDENTIFICADOR_EN_BANCO =
  'SELECT DISTINCT id_banco, id_identificador FROM notas_registros_cupos WHERE id_identificador = ? AND id_banco = ?';
export const sqlCuposDeUsuarios = (n: number) =>
  `SELECT id_cupo, id_usuario, cupo, total_asignado FROM notas_registros_cupos WHERE id_banco = ? AND id_identificador = ? AND id_usuario IN (${marcas(n)})`;
export const SQL_CONTACTOS_LIBRES = 'SELECT COUNT(*) AS n FROM notas_registros WHERE banco = ? AND identificador = ? AND asignado = 0 AND estado = 0';
export const SQL_CUPO_INSERT = 'INSERT INTO notas_registros_cupos (id_usuario, id_banco, id_identificador, cupo) VALUES (?, ?, ?, ?)';
export const SQL_CUPO_UPDATE = 'UPDATE notas_registros_cupos SET cupo = ? WHERE id_usuario = ? AND id_banco = ? AND id_identificador = ? AND cupo = ?';
export const SQL_CUPO_FILAS = 'SELECT COUNT(*) AS n FROM notas_registros_cupos WHERE id_usuario = ? AND id_banco = ? AND id_identificador = ?';
export const sqlUsuariosActivos = (n: number) => `SELECT COUNT(*) AS n FROM usuarios WHERE tipo = 6 AND estado = 0 AND id_usuario IN (${marcas(n)})`;

// ---------------------------------------------------------------------------
// Resolución de usuarios (por id o por nombre; los nombres pueden traer espacios al final)
// ---------------------------------------------------------------------------
export interface UsuarioResuelto {
  id: number;
  nombres: string;
  estado: number;
}

export const resolverUsuario = async (ref: string | number, deps: BaseDeps, soloActivos: boolean): Promise<UsuarioResuelto> => {
  const textoRef = String(ref).trim().replace(/\s+/g, ' ');
  if (!textoRef) throw new Error('Hay un usuario vacío en la lista.');
  const estadoSql = soloActivos ? ' AND estado = 0' : '';
  const esId = /^\d+$/.test(textoRef);
  const palabras = textoRef.split(' ');
  const where = esId ? 'id_usuario = ?' : palabras.map(() => 'nombres LIKE ?').join(' AND ');
  const values: Array<string | number> = esId ? [Number(textoRef)] : palabras.map(likePattern);
  const r = await deps.consultar(`SELECT id_usuario, nombres, estado FROM usuarios WHERE tipo = 6${estadoSql} AND ${where} ORDER BY nombres LIMIT 11`, values, 11);
  const lista: UsuarioResuelto[] = r.rows.map((f) => ({ id: Number(f.id_usuario), nombres: String(f.nombres ?? '').trim(), estado: numero(f.estado) }));
  if (lista.length === 1) return lista[0];
  if (lista.length === 0) {
    throw new Error(
      `No encontré al usuario "${textoRef}" entre los asesores (tipo 6)${soloActivos ? ' activos' : ''}. Revise el nombre o use su id_usuario.`
    );
  }
  const exacto = lista.filter((u) => u.nombres.toLowerCase() === textoRef.toLowerCase());
  if (exacto.length === 1) return exacto[0];
  throw new Error(
    `"${textoRef}" coincide con varios asesores: ${lista.slice(0, 10).map((u) => `${u.nombres} (id ${u.id})`).join('; ')}. Indique el nombre completo o el id_usuario.`
  );
};

const resolverUsuarios = async (refs: Array<string | number>, deps: BaseDeps, soloActivos: boolean): Promise<UsuarioResuelto[]> => {
  const out: UsuarioResuelto[] = [];
  for (const ref of refs) {
    const u = await resolverUsuario(ref, deps, soloActivos);
    if (out.some((x) => x.id === u.id)) throw new Error(`El asesor ${u.nombres} (id ${u.id}) está repetido en la lista.`);
    out.push(u);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Resolución de banco + identificador (no se asume nunca)
// ---------------------------------------------------------------------------
type Identificador = { banco: number; identificador: string };

const identificadoresRecientes = async (deps: BaseDeps) => {
  const r = await deps.consultar(SQL_IDENTIFICADORES_RECIENTES, [], 10);
  return r.rows.map((f) => ({ banco: Number(f.id_banco), identificador: String(f.id_identificador) }));
};

export const resolverIdentificador = async (
  identificador: string,
  banco: number | undefined,
  deps: BaseDeps
): Promise<Identificador> => {
  const nombre = identificador.trim();
  const r = banco !== undefined
    ? await deps.consultar(SQL_BANCOS_DEL_IDENTIFICADOR_EN_BANCO, [nombre, banco], 50)
    : await deps.consultar(SQL_BANCOS_DEL_IDENTIFICADOR, [nombre], 50);
  const filas = r.rows.map((f) => ({ banco: Number(f.id_banco), identificador: String(f.id_identificador) }));
  if (filas.length === 0) {
    const rec = await identificadoresRecientes(deps);
    throw new Error(
      `No existe el identificador "${nombre}"${banco !== undefined ? ` en el banco ${banco}` : ''} en notas_registros_cupos. ` +
        `Los más recientes son: ${rec.map((x) => `"${x.identificador}" (banco ${x.banco})`).join('; ')}.`
    );
  }
  if (filas.length > 1) {
    throw new Error(`El identificador "${nombre}" existe en varios bancos (${filas.map((f) => f.banco).join(', ')}). Indique el banco.`);
  }
  return filas[0];
};

const pedirIdentificador = async (deps: BaseDeps, titulo: string): Promise<ReturnType<typeof texto>> => {
  const rec = await identificadoresRecientes(deps);
  return texto(titulo, {
    falta: 'identificador',
    mensaje: 'No indicó el identificador (la base) y no lo asumo. Pregúntele al usuario cuál es.',
    identificadores_recientes: rec
  });
};

// ---------------------------------------------------------------------------
// asignar_base_usuario
// ---------------------------------------------------------------------------
export interface CambioCupo {
  id_usuario: number;
  asesor: string;
  existe_fila: boolean;
  cupo_actual: number;
  entregado: number;
  pendiente_actual: number;
  cupo_nuevo: number;
  pendiente_nuevo: number;
  solicitado: number;
}

/** sumar: base = el mayor entre el cupo actual y lo ya entregado (así tras encerar siguen llegando N datos nuevos). fijar: el cupo queda en N. */
export const calcularCupoNuevo = (modo: ModoAsignacion, cupoActual: number, entregado: number, n: number): number =>
  modo === 'fijar' ? n : Math.max(cupoActual, entregado) + n;

interface PlanAsignar {
  banco: number;
  identificador: string;
  modo: ModoAsignacion;
  cambios: CambioCupo[];
  libres: number | null;
  advertencias: string[];
  bloqueos: string[];
  firma: unknown;
}

const planAsignar = async (p: AsignarBaseUsuarioParams, userId: string, deps: BaseDeps): Promise<PlanAsignar> => {
  const ident = await resolverIdentificador(p.identificador!, p.banco, deps);
  const modo: ModoAsignacion = p.modo ?? 'sumar';
  const items = p.usuarios!.map((u) => ({ usuario: u.usuario, cupo: u.cupo ?? p.cupo }));
  const sinCupo = items.filter((i) => i.cupo === undefined);
  if (sinCupo.length) throw new Error(`Falta la cantidad (cupo) para: ${sinCupo.map((i) => String(i.usuario)).join(', ')}. Indique cuántos datos asignar.`);
  for (const i of items) {
    if (!Number.isInteger(i.cupo) || i.cupo! < 1 || i.cupo! > CUPO_MAXIMO_POR_ASESOR) {
      throw new Error(`El cupo de "${i.usuario}" debe ser un entero entre 1 y ${CUPO_MAXIMO_POR_ASESOR} por asesor y por operación.`);
    }
  }
  const usuarios = await resolverUsuarios(items.map((i) => i.usuario), deps, true);

  const [cuposR, libresR] = await Promise.all([
    deps.consultar(sqlCuposDeUsuarios(usuarios.length), [ident.banco, ident.identificador, ...usuarios.map((u) => u.id)], 500),
    deps.consultar(SQL_CONTACTOS_LIBRES, [ident.banco, ident.identificador], 1).catch(() => null)
  ]);

  const bloqueos: string[] = [];
  const advertencias: string[] = [];
  const cambios: CambioCupo[] = usuarios.map((u, idx) => {
    const filas = cuposR.rows.filter((f) => Number(f.id_usuario) === u.id);
    if (filas.length > 1) bloqueos.push(`${u.nombres} (id ${u.id}) tiene ${filas.length} filas de cupo duplicadas para este identificador; no se puede actualizar sin ambigüedad. Hay que corregirlo en la base.`);
    const f = filas[0];
    const cupoActual = f ? numero(f.cupo) : 0;
    const entregado = f ? numero(f.total_asignado) : 0;
    const n = items[idx].cupo!;
    const nuevo = calcularCupoNuevo(modo, cupoActual, entregado, n);
    if (modo === 'fijar' && nuevo < cupoActual) advertencias.push(`${u.nombres}: el cupo baja de ${cupoActual} a ${nuevo}.`);
    if (modo === 'fijar' && nuevo <= entregado) advertencias.push(`${u.nombres}: ya recibió ${entregado}; con cupo ${nuevo} no le llegará nada más.`);
    return {
      id_usuario: u.id,
      asesor: u.nombres,
      existe_fila: filas.length > 0,
      cupo_actual: cupoActual,
      entregado,
      pendiente_actual: Math.max(cupoActual - entregado, 0),
      cupo_nuevo: nuevo,
      pendiente_nuevo: Math.max(nuevo - entregado, 0),
      solicitado: n
    };
  });

  const libres = libresR ? numero(libresR.rows[0]?.n) : null;
  const totalPedido = cambios.reduce((s, c) => s + c.solicitado, 0);
  if (libres === null) advertencias.push('No se pudo contar los contactos libres de esa base; revise que alcancen.');
  else if (totalPedido > libres) advertencias.push(`Se piden ${totalPedido} datos en total y la base tiene ${libres} contactos libres (sin asignar y sin gestión).`);

  const firma = {
    u: userId, m: 'asignar_base_usuario', banco: ident.banco, i: ident.identificador, modo,
    c: cambios.map((c) => [c.id_usuario, c.existe_fila, c.cupo_actual, c.cupo_nuevo])
  };
  return { banco: ident.banco, identificador: ident.identificador, modo, cambios, libres, advertencias, bloqueos, firma };
};

const resumenAsignar = (plan: PlanAsignar) => ({
  banco: plan.banco,
  identificador: plan.identificador,
  modo: plan.modo,
  regla: plan.modo === 'sumar'
    ? 'sumar: el cupo nuevo = el mayor entre el cupo actual y lo ya entregado + la cantidad pedida'
    : 'fijar: el cupo queda exactamente en la cantidad pedida',
  asesores: plan.cambios,
  contactos_libres_en_la_base: plan.libres,
  advertencias: plan.advertencias,
  bloqueos: plan.bloqueos
});

export const handleAsignarBaseUsuario = async (params: AsignarBaseUsuarioParams, userId: string, deps: BaseDeps = defaultDeps) => {
  try {
    if (!params.identificador?.trim()) return await pedirIdentificador(deps, '❓ [MVEVIP MCP] Falta el identificador (NO se ha modificado nada):');
    if (!params.usuarios?.length) {
      return texto('❓ [MVEVIP MCP] Faltan los asesores (NO se ha modificado nada):', {
        falta: 'usuarios',
        mensaje: 'Indique a qué asesor(es) asignar y cuántos datos a cada uno (por nombre o id_usuario).'
      });
    }
    const plan = await planAsignar(params, userId, deps);
    const aplicable = plan.bloqueos.length === 0;

    if (!params.codigo_confirmacion) {
      const cod = aplicable ? generarCodigo(deps.secreto(), plan.firma, deps.ahora().getTime()) : undefined;
      return texto('🔎 [MVEVIP MCP] Vista previa de asignar cupos (NO se ha modificado nada):', {
        ...resumenAsignar(plan),
        puede_aplicarse: aplicable,
        codigo_confirmacion: cod?.codigo,
        codigo_vence: cod?.vence,
        siguiente_paso: aplicable
          ? 'Muestre esto al usuario (cupo actual, entregado y cupo nuevo de cada asesor, y las advertencias) y pida su confirmación EXPLÍCITA; solo entonces llame de nuevo a asignar_base_usuario con los mismos parámetros y el codigo_confirmacion.'
          : 'No se puede aplicar: resuelva los bloqueos.'
      });
    }

    if (!aplicable) return falla(`No se asignó nada. ${plan.bloqueos.join(' ')}`);
    const v = validarCodigo(deps.secreto(), plan.firma, params.codigo_confirmacion, deps.ahora().getTime());
    if (!v.ok) {
      return falla(`No se asignó nada. ${v.motivo} Vuelva a llamar a asignar_base_usuario sin código para ver la vista previa actual y confirmar de nuevo.`);
    }

    const resultado = await deps.transaccion(async (tx) => {
      const activos = await tx.consultar(sqlUsuariosActivos(plan.cambios.length), plan.cambios.map((c) => c.id_usuario));
      if (numero(activos[0]?.n) !== plan.cambios.length) throw new Error('Algún asesor ya no es un usuario tipo 6 activo.');
      let actualizados = 0;
      let creados = 0;
      for (const c of plan.cambios) {
        const filas = numero((await tx.consultar(SQL_CUPO_FILAS, [c.id_usuario, plan.banco, plan.identificador]))[0]?.n);
        if (filas !== (c.existe_fila ? 1 : 0)) throw new Error(`Los cupos de ${c.asesor} cambiaron mientras se aplicaba; no se asignó nada.`);
        if (!c.existe_fila) {
          await tx.ejecutar(SQL_CUPO_INSERT, [c.id_usuario, plan.banco, plan.identificador, c.cupo_nuevo]);
          creados++;
        } else if (c.cupo_nuevo !== c.cupo_actual) {
          const r = await tx.ejecutar(SQL_CUPO_UPDATE, [c.cupo_nuevo, c.id_usuario, plan.banco, plan.identificador, c.cupo_actual]);
          if (r.affectedRows !== 1) throw new Error(`El cupo de ${c.asesor} cambió mientras se aplicaba; no se asignó nada.`);
          actualizados++;
        }
      }
      return { actualizados, creados };
    });

    deps.log(
      `[AUDIT] ${JSON.stringify({
        accion: 'asignar_base_usuario', usuario: userId, banco: plan.banco, identificador: plan.identificador, modo: plan.modo,
        cambios: plan.cambios.map((c) => ({ id_usuario: c.id_usuario, de: c.cupo_actual, a: c.cupo_nuevo, creada: !c.existe_fila })), ...resultado
      })}`
    );
    return texto('✅ [MVEVIP MCP] Cupos asignados:', {
      aplicado: true,
      banco: plan.banco,
      identificador: plan.identificador,
      modo: plan.modo,
      filas_actualizadas: resultado.actualizados,
      filas_creadas: resultado.creados,
      asesores: plan.cambios.map((c) => ({ asesor: c.asesor, cupo_anterior: c.cupo_actual, cupo_nuevo: c.cupo_nuevo, pendiente_por_entregar: c.pendiente_nuevo }))
    });
  } catch (error: any) {
    return falla(`No se asignó nada: ${error?.message || String(error)}`);
  }
};

// ---------------------------------------------------------------------------
// encerar_cupo_usuario
// ---------------------------------------------------------------------------
export const sqlCuposConValor = (nUsuarios: number, conIdentificador: boolean) =>
  `SELECT id_usuario, id_banco, id_identificador, cupo, total_asignado FROM notas_registros_cupos WHERE cupo > 0 AND id_usuario IN (${marcas(nUsuarios)})` +
  `${conIdentificador ? ' AND id_banco = ? AND id_identificador = ?' : ''} ORDER BY id_usuario, id_banco, id_identificador LIMIT 2001`;
export const sqlEncerarUsuarios = (nUsuarios: number, conIdentificador: boolean) =>
  `UPDATE notas_registros_cupos SET cupo = 0 WHERE cupo > 0 AND id_usuario IN (${marcas(nUsuarios)})${conIdentificador ? ' AND id_banco = ? AND id_identificador = ?' : ''}`;

interface PlanEncerar {
  alcance: { banco?: number; identificador?: string };
  asesores: Array<{
    id_usuario: number;
    asesor: string;
    activo: boolean;
    filas_con_cupo: number;
    cupo_total: number;
    pendiente_por_entregar: number;
    detalle: Array<{ banco: number; identificador: string; cupo: number; entregado: number }>;
  }>;
  filasTotal: number;
  ids: number[];
  firma: unknown;
}

const planEncerar = async (p: EncerarCupoUsuarioParams, userId: string, deps: BaseDeps): Promise<PlanEncerar> => {
  const usuarios = await resolverUsuarios(p.usuarios!, deps, false);
  let ident: Identificador | undefined;
  if (p.identificador?.trim()) ident = await resolverIdentificador(p.identificador, p.banco, deps);
  else if (p.banco !== undefined) throw new Error('El banco solo se usa junto con un identificador. Si quiere encerar todos los cupos del asesor, no indique banco.');

  const ids = usuarios.map((u) => u.id);
  const values: Array<string | number> = [...ids, ...(ident ? [ident.banco, ident.identificador] : [])];
  const r = await deps.consultar(sqlCuposConValor(ids.length, !!ident), values, 2001);
  if (r.rows.length > 2000) throw new Error('Hay demasiados cupos para encerar de una vez (más de 2000 filas). Indique un identificador.');

  const asesores = usuarios.map((u) => {
    const filas = r.rows.filter((f) => Number(f.id_usuario) === u.id);
    return {
      id_usuario: u.id,
      asesor: u.nombres,
      activo: u.estado === 0,
      filas_con_cupo: filas.length,
      cupo_total: filas.reduce((s, f) => s + numero(f.cupo), 0),
      pendiente_por_entregar: filas.reduce((s, f) => s + Math.max(numero(f.cupo) - numero(f.total_asignado), 0), 0),
      detalle: filas.slice(0, 15).map((f) => ({ banco: Number(f.id_banco), identificador: String(f.id_identificador), cupo: numero(f.cupo), entregado: numero(f.total_asignado) }))
    };
  });
  const filasTotal = asesores.reduce((s, a) => s + a.filas_con_cupo, 0);
  const firma = {
    u: userId, m: 'encerar_cupo_usuario', b: ident?.banco ?? null, i: ident?.identificador ?? null,
    a: asesores.map((a) => [a.id_usuario, a.filas_con_cupo, a.cupo_total])
  };
  return { alcance: ident ? { banco: ident.banco, identificador: ident.identificador } : {}, asesores, filasTotal, ids, firma };
};

export const handleEncerarCupoUsuario = async (params: EncerarCupoUsuarioParams, userId: string, deps: BaseDeps = defaultDeps) => {
  try {
    if (!params.usuarios?.length) {
      return texto('❓ [MVEVIP MCP] Falta el asesor (NO se ha modificado nada):', {
        falta: 'usuarios',
        mensaje: 'Indique a qué asesor(es) encerar el cupo (por nombre o id_usuario). Para encerar a TODOS use encerar_cupos.'
      });
    }
    const plan = await planEncerar(params, userId, deps);

    if (plan.filasTotal === 0) {
      return texto('ℹ️ [MVEVIP MCP] No hay nada que encerar (NO se ha modificado nada):', {
        alcance: plan.alcance.identificador ? plan.alcance : 'todos los identificadores',
        asesores: plan.asesores.map((a) => ({ asesor: a.asesor, id_usuario: a.id_usuario, filas_con_cupo: 0 }))
      });
    }

    if (!params.codigo_confirmacion) {
      const cod = generarCodigo(deps.secreto(), plan.firma, deps.ahora().getTime());
      return texto('🔎 [MVEVIP MCP] Vista previa de encerar cupos por asesor (NO se ha modificado nada):', {
        efecto_al_confirmar: plan.alcance.identificador
          ? `Pone cupo = 0 SOLO a estos asesores y SOLO en el identificador "${plan.alcance.identificador}" (banco ${plan.alcance.banco}). Lo ya entregado (total_asignado) no cambia.`
          : 'Pone cupo = 0 SOLO a estos asesores, en todos sus identificadores con cupo. Lo ya entregado (total_asignado) no cambia. Los demás asesores no se tocan.',
        asesores: plan.asesores,
        filas_a_actualizar: plan.filasTotal,
        codigo_confirmacion: cod.codigo,
        codigo_vence: cod.vence,
        siguiente_paso: 'Muestre esto al usuario y pida su confirmación EXPLÍCITA; solo entonces llame de nuevo a encerar_cupo_usuario con los mismos parámetros y el codigo_confirmacion.'
      });
    }

    const v = validarCodigo(deps.secreto(), plan.firma, params.codigo_confirmacion, deps.ahora().getTime());
    if (!v.ok) return falla(`No se encerró nada. ${v.motivo} Vuelva a llamar a encerar_cupo_usuario sin código para ver la vista previa actual y confirmar de nuevo.`);

    const conIdent = plan.alcance.identificador !== undefined;
    const valores: Array<string | number> = [...plan.ids, ...(conIdent ? [plan.alcance.banco!, plan.alcance.identificador!] : [])];
    const afectadas = await deps.transaccion(async (tx) => {
      const r = await tx.ejecutar(sqlEncerarUsuarios(plan.ids.length, conIdent), valores);
      if (r.affectedRows !== plan.filasTotal) throw new Error(`Se esperaban ${plan.filasTotal} filas y se modificarían ${r.affectedRows}; se revirtió todo.`);
      return r.affectedRows;
    });
    deps.log(
      `[AUDIT] ${JSON.stringify({
        accion: 'encerar_cupo_usuario', usuario: userId, alcance: plan.alcance,
        asesores: plan.asesores.map((a) => ({ id_usuario: a.id_usuario, filas: a.filas_con_cupo, cupo_total_antes: a.cupo_total })), filas_actualizadas: afectadas
      })}`
    );
    return texto('✅ [MVEVIP MCP] Cupos encerados por asesor:', {
      aplicado: true,
      filas_actualizadas: afectadas,
      alcance: plan.alcance.identificador ? plan.alcance : 'todos los identificadores',
      asesores: plan.asesores.map((a) => ({ asesor: a.asesor, filas_encerradas: a.filas_con_cupo, cupo_total_antes: a.cupo_total }))
    });
  } catch (error: any) {
    return falla(`No se encerró nada: ${error?.message || String(error)}`);
  }
};
