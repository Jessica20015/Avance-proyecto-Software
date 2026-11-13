// =============================================================================
//  C7 · Atender una PQR del usuario — ENEL La Corocora (Camunda 7)
//  Workers de las External Tasks (patrón "External Task" de Camunda 7).
//
//  Cada client.subscribe(topic) atiende una Service Task o un evento de mensaje
//  configurado en el modelo con  Implementation: External  y ese Topic.
//  Atiende los dos procesos: C7_AtenderPQR y el proceso global C7_NotificarDecision.
//
//  Ejecución:   npm install   →   node c7-workers.js
//  Variables de entorno opcionales:
//    CAMUNDA_URL           por defecto http://localhost:8080/engine-rest
//    C7_MODO               demo | produccion
//                          demo: los plazos en días hábiles se convierten en segundos
//                          produccion: días hábiles reales (calendario colombiano)
//    C7_SEGUNDOS_POR_DIA   en demo, cuántos segundos dura un día hábil (por defecto 30)
//
//  Los participantes externos (procesos C2–C6, operador de notificación y el
//  usuario que recurre) se SIMULAN aquí: unos segundos después, el worker
//  correlaciona por REST el mensaje que respondería ese participante.
// =============================================================================
import { Client, logger, Variables } from "camunda-external-task-client-js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.CAMUNDA_URL || "http://localhost:8080/engine-rest";
const MODO = (process.env.C7_MODO || "demo").toLowerCase();
const SEG_DIA = Number(process.env.C7_SEGUNDOS_POR_DIA || 30);
const AQUI = dirname(fileURLToPath(import.meta.url));
const CARPETA = join(AQUI, "expediente");
const EXPEDIENTE = join(CARPETA, "expediente-pqr.jsonl");
const CONSECUTIVO = join(CARPETA, "consecutivo.txt");

const client = new Client({ baseUrl: BASE_URL, use: logger, asyncResponseTimeout: 10000, lockDuration: 30000 });

// ----------------------------------------------------------------------------
//  Calendario de días hábiles (Colombia). Festivos de 2026 y 2027 (Ley 51 de
//  1983, festivos trasladados al lunes). Referencia académica: G3 debe validarla.
// ----------------------------------------------------------------------------
const FESTIVOS = new Set([
  // 2026
  "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-18",
  "2026-06-08", "2026-06-15", "2026-06-29", "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12",
  "2026-11-02", "2026-11-16", "2026-12-08", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-11", "2027-03-22", "2027-03-25", "2027-03-26", "2027-05-01", "2027-05-10",
  "2027-05-31", "2027-06-07", "2027-07-05", "2027-07-20", "2027-08-07", "2027-08-16", "2027-10-18",
  "2027-11-01", "2027-11-15", "2027-12-08", "2027-12-25",
]);
const OFFSET_CO = -5 * 3600 * 1000; // Colombia: UTC-5, sin horario de verano
const fechaCO = (d) => new Date(d.getTime() + OFFSET_CO).toISOString().slice(0, 10);
const esHabil = (yyyyMmDd) => {
  const dia = new Date(`${yyyyMmDd}T12:00:00Z`).getUTCDay();
  return dia !== 0 && dia !== 6 && !FESTIVOS.has(yyyyMmDd);
};

/** Fecha límite tras n días hábiles contados desde el día siguiente (fin del día, hora de Colombia). */
function venceEnDiasHabiles(desde, n) {
  if (MODO !== "produccion") return new Date(desde.getTime() + n * SEG_DIA * 1000).toISOString();
  let dia = fechaCO(desde);
  let cuenta = 0;
  while (cuenta < n) {
    const d = new Date(`${dia}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    dia = d.toISOString().slice(0, 10);
    if (esHabil(dia)) cuenta++;
  }
  return `${dia}T23:59:59-05:00`;
}

/** Días hábiles transcurridos entre dos fechas (en demo, en "días" de SEG_DIA segundos). */
function diasHabilesEntre(desde, hasta) {
  if (MODO !== "produccion") return Math.round(((hasta - desde) / 1000 / SEG_DIA) * 10) / 10;
  let dia = fechaCO(desde);
  const fin = fechaCO(hasta);
  let cuenta = 0;
  while (dia < fin) {
    const d = new Date(`${dia}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    dia = d.toISOString().slice(0, 10);
    if (esHabil(dia)) cuenta++;
  }
  return cuenta;
}

// ----------------------------- utilidades -----------------------------------
const ahora = () => new Date();
/** Fecha legible para los formularios (hora de Colombia), p. ej. «4 de diciembre de 2026, 11:59 p. m.». */
const legible = (iso) => new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "long", timeStyle: "short" });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const v = (task, nombre, porDefecto = null) => {
  const valor = task.variables.get(nombre);
  return valor === undefined || valor === null ? porDefecto : valor;
};
const tiene = (task, nombre) => {
  const valor = task.variables.get(nombre);
  return valor !== undefined && valor !== null;
};
const int = (vars, nombre, valor) => vars.setTyped(nombre, { value: Math.trunc(Number(valor)), type: "Integer" });
const dbl = (vars, nombre, valor) => vars.setTyped(nombre, { value: Number(valor), type: "Double" });
const str = (vars, nombre, valor) => vars.setTyped(nombre, { value: valor === null ? null : String(valor), type: "String" });
const bool = (vars, nombre, valor) => vars.setTyped(nombre, { value: Boolean(valor), type: "Boolean" });
const log = (topic, task, msg) =>
  console.log(`[${new Date().toLocaleTimeString()}] [${topic}] ${task.businessKey || task.processInstanceId} → ${msg}`);

/** Expediente único: un registro por evento (regla de trazabilidad §8.4). */
async function registrar(task, evento, actividad, responsable, datos = {}) {
  await mkdir(CARPETA, { recursive: true });
  const registro = {
    fechaHora: ahora().toISOString(),
    expedienteId: v(task, "expedienteId", task.businessKey),
    radicado: v(task, "radicado"),
    instancia: v(task, "instancia"),
    evento,
    actividad,
    responsable,
    estado: datos.estado ?? null,
    version: v(task, "versionRegla", "Reglas PQR G3 v1.0"),
    causa: datos.causa ?? null,
    datos,
  };
  await appendFile(EXPEDIENTE, JSON.stringify(registro) + "\n", "utf8");
}

async function leerExpediente() {
  if (!existsSync(EXPEDIENTE)) return [];
  const txt = await readFile(EXPEDIENTE, "utf8");
  return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Los handlers corren en paralelo: el consecutivo se asigna en serie para no repetir radicados.
let colaConsecutivo = Promise.resolve();
function siguienteRadicado() {
  const turno = colaConsecutivo.then(async () => {
    await mkdir(CARPETA, { recursive: true });
    const n = (existsSync(CONSECUTIVO) ? Number(await readFile(CONSECUTIVO, "utf8")) || 0 : 0) + 1;
    await writeFile(CONSECUTIVO, String(n), "utf8");
    return `PQR-${new Date().getFullYear()}-${String(n).padStart(6, "0")}`;
  });
  colaConsecutivo = turno.catch(() => {});
  return turno;
}

/** Correlaciona un mensaje con reintentos (la instancia puede no haber llegado aún al evento). */
async function correlacionar(messageName, destino, variables = {}) {
  const processVariables = {};
  for (const [k, val] of Object.entries(variables)) {
    let type = "String";
    if (typeof val === "number") type = Number.isInteger(val) ? "Integer" : "Double";
    if (typeof val === "boolean") type = "Boolean";
    processVariables[k] = { value: val, type };
  }
  for (let intento = 1; intento <= 10; intento++) {
    const res = await fetch(`${BASE_URL}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageName, ...destino, processVariables }),
    });
    if (res.ok) {
      console.log(`    ↳ mensaje ${messageName} correlacionado (${JSON.stringify(destino)})`);
      return true;
    }
    await esperar(1500);
  }
  console.log(`    ↳ ¡no se pudo correlacionar ${messageName}! (${JSON.stringify(destino)})`);
  return false;
}

/**
 * Envuelve un handler. Si el engine rechaza la finalización por un conflicto de concurrencia
 * (OptimisticLockingException: otra rama paralela actualizó la misma ejecución), la reintenta.
 * Si el handler falla, devuelve la tarea con reintentos: el incidente aparece solo al agotarlos.
 */
function suscribir(topic, handler) {
  client.subscribe(topic, async ({ task, taskService }) => {
    try {
      const vars = new Variables();
      await handler(task, vars);
      for (let intento = 1; ; intento++) {
        try {
          await taskService.complete(task, vars);
          break;
        } catch (e) {
          if (intento >= 5 || !/OptimisticLocking/.test(String(e.message || e))) throw e;
          console.log(`[${topic}] conflicto de concurrencia; reintento ${intento} de la finalización`);
          await esperar(400 * intento);
        }
      }
    } catch (e) {
      const restantes = (task.retries ?? 3) - 1;
      console.error(`[${topic}] error (reintentos restantes: ${Math.max(restantes, 0)}):`, e.message || e);
      await taskService.handleFailure(task, { errorMessage: String(e.message || e).slice(0, 600), errorDetails: String(e.stack || e), retries: Math.max(restantes, 0), retryTimeout: 5000 });
    }
  });
}

// Evidencia ficticia por proceso fuente (sin datos personales reales).
const EVIDENCIA = {
  C2: (t) => `C2 · Evento de interrupción en el circuito que alimenta ${v(t, "codigoSuministro")}: 7,5 h acumuladas en el período (DIU), causa validada «falla en transformador». Afectación documentada.`,
  C3: (t) => `C3 · Histórico de lecturas de ${v(t, "codigoSuministro")}: 6 lecturas reales consecutivas; la del período reclamado fue estimada por imposibilidad de acceso. Secuencialidad verificada.`,
  C4: (t) => `C4 · Trazabilidad de la factura ${v(t, "numeroFactura", "del período")}: lectura de C3, regla tarifaria CU-2026-10 v1 aprobada por G3 y liquidación sin corrección previa. Expediente de facturación disponible.`,
  C5: (t) => `C5 · Cuenta por cobrar de ${v(t, "codigoSuministro")}: suspensión ejecutada por mora de 2 facturas; pago registrado antes de la suspensión, no aplicado a tiempo.`,
  C6: (t) => `C6 · Actuación de recuperación sobre ${v(t, "codigoSuministro")}: acta de revisión con anomalía, período de recuperación de 6 meses, sin secuencialidad de lecturas en 2 de ellos.`,
};

// =============================================================================
//  C7_AtenderPQR
// =============================================================================

suscribir("radicar-pqr", async (task, vars) => {
  const tipo = v(task, "tipoPQR");
  const instancia = tipo === "RECURSO_REPOSICION" ? "REPOSICION" : "PRIMERA";
  const radicado = await siguienteRadicado();
  const expedienteId = v(task, "expedienteId", radicado);
  const fecha = ahora();

  // meses desde la expedición de la factura reclamada (art. 154, Ley 142: cinco meses)
  let meses = 0;
  const fFactura = v(task, "fechaExpedicionFactura");
  if (fFactura) {
    const f = new Date(`${String(fFactura).slice(0, 10)}T12:00:00Z`);
    meses = (fecha.getUTCFullYear() - f.getUTCFullYear()) * 12 + (fecha.getUTCMonth() - f.getUTCMonth()) - (fecha.getUTCDate() < f.getUTCDate() ? 1 : 0);
  }

  // reapertura por la misma causa: mismo suministro y asunto, cerrado hace 30 días o menos (§8.3)
  let esReapertura = false;
  let radicadoAnterior = "";
  if (instancia === "PRIMERA") {
    const ventanaMs = MODO === "produccion" ? 30 * 24 * 3600 * 1000 : 30 * SEG_DIA * 1000;
    const cerrados = (await leerExpediente()).filter(
      (r) => r.evento === "EXPEDIENTE_CERRADO" && r.datos.codigoSuministro === v(task, "codigoSuministro") && r.datos.asunto === v(task, "asunto")
    );
    const ultimo = cerrados.at(-1);
    if (ultimo && fecha - new Date(ultimo.fechaHora) <= ventanaMs) {
      esReapertura = true;
      radicadoAnterior = ultimo.expedienteId;
    }
  }

  str(vars, "radicado", radicado);
  str(vars, "expedienteId", expedienteId);
  str(vars, "instancia", instancia);
  str(vars, "fechaRadicacion", fecha.toISOString());
  str(vars, "radicacionLegible", legible(fecha));
  int(vars, "mesesDesdeFactura", meses);
  bool(vars, "esReapertura", esReapertura);
  str(vars, "radicadoAnterior", radicadoAnterior);
  if (!tiene(task, "canalRadicacion")) str(vars, "canalRadicacion", "VIRTUAL");
  // valores por defecto de variables opcionales (formularios con campos ocultos)
  for (const [k, val] of [["apelacionSubsidiaria", false], ["autorizaNotificacionElectronica", false], ["requiereAccesibilidad", false], ["procedenRecursos", false]])
    if (!tiene(task, k)) bool(vars, k, val);
  for (const k of ["documentosAportados", "numeroFactura", "radicadoRecurrido", "nombrePeticionario", "direccionNotificacion", "correoNotificacion"])
    if (!tiene(task, k)) str(vars, k, "");
  // cada instrucción (primera instancia o recurso) empieza sin decisión previa
  bool(vars, "ordenaAjusteC4", false);
  bool(vars, "solicitaRevisionC6", false);
  dbl(vars, "valorAjuste", 0);
  bool(vars, "silencioPositivo", false);
  bool(vars, "evidenciaOportuna", true);
  str(vars, "evidenciaRecibida", "");
  str(vars, "resultadoRevision", "");
  str(vars, "observacionesRevision", "");

  await registrar(task, instancia === "PRIMERA" ? "PQR_RADICADA" : "RECURSO_RADICADO", "Radicar la PQR y asignar radicado", v(task, "orientadorRadicador", "sistema"), {
    estado: "RADICADA", radicado, tipoPQR: tipo, asunto: v(task, "asunto"), canal: v(task, "canalRadicacion", "VIRTUAL"),
    codigoSuministro: v(task, "codigoSuministro"), esReapertura, radicadoAnterior, mesesDesdeFactura: meses,
    radicadoRecurrido: v(task, "radicadoRecurrido", ""), apelacionSubsidiaria: v(task, "apelacionSubsidiaria", false),
  });
  log("radicar-pqr", task, `${radicado} (${instancia}, ${tipo}/${v(task, "asunto")}) ${esReapertura ? "· REAPERTURA de " + radicadoAnterior : ""}`);
});

suscribir("abrir-expediente", async (task, vars) => {
  const desde = new Date(v(task, "fechaRadicacion"));
  const termino = v(task, "terminoDiasHabiles", 15);
  const vence = venceEnDiasHabiles(desde, termino);
  const alerta = MODO === "produccion" ? venceEnDiasHabiles(desde, Math.ceil(termino * 0.7)) : new Date(desde.getTime() + termino * 0.7 * SEG_DIA * 1000).toISOString();
  str(vars, "fechaVencimiento", vence);
  str(vars, "vencimientoLegible", legible(vence));
  str(vars, "fechaAlerta", alerta);
  await registrar(task, v(task, "instancia") === "PRIMERA" ? "EXPEDIENTE_ABIERTO" : "RECURSO_ACUMULADO", "Abrir expediente y calcular vencimiento", "sistema", {
    estado: "EN_TRAMITE", terminoDiasHabiles: termino, fechaVencimiento: vence, fechaAlerta: alerta,
    procesoEvidencia: v(task, "procesoEvidencia"), prioridad: v(task, "prioridad"), alertaProcedencia: v(task, "alertaProcedencia", ""),
  });
  log("abrir-expediente", task, `término ${termino} días hábiles → vence ${vence} (alerta ${alerta})`);
});

suscribir("enviar-constancia-radicado", async (task, vars) => {
  str(vars, "fechaConstancia", ahora().toISOString());
  await registrar(task, "CONSTANCIA_ENVIADA", "Constancia de radicado enviada al usuario", "sistema", {
    canal: v(task, "autorizaNotificacionElectronica") ? `correo ${v(task, "correoNotificacion", "")}` : "constancia impresa o SMS",
    fechaVencimiento: v(task, "fechaVencimiento"),
  });
  log("enviar-constancia-radicado", task, `constancia ${v(task, "radicado")} · vence ${v(task, "fechaVencimiento")}`);
});

suscribir("solicitar-evidencia", async (task, vars) => {
  const proceso = v(task, "procesoEvidencia");
  const limite = venceEnDiasHabiles(ahora(), v(task, "plazoEvidenciaDiasHabiles", 2));
  str(vars, "fechaLimiteEvidencia", limite);
  await registrar(task, "EVIDENCIA_SOLICITADA", "Evidencia solicitada al proceso fuente", "sistema", { procesoEvidencia: proceso, fechaLimiteEvidencia: limite });
  log("solicitar-evidencia", task, `solicitud a ${proceso}, plazo interno ${limite}`);
  // simulación del proceso fuente
  if (v(task, "simularEvidencia", "RESPONDE") === "RESPONDE") {
    const texto = (EVIDENCIA[proceso] || (() => `${proceso}: evidencia del asunto.`))(task);
    setTimeout(() => correlacionar("MsgEvidenciaPQR", { processInstanceId: task.processInstanceId }, { evidenciaRecibida: texto, fechaEvidencia: ahora().toISOString() }), 3000);
  } else {
    log("solicitar-evidencia", task, `(simulación: ${proceso} no responde; vencerá el plazo interno)`);
  }
});

suscribir("escalar-evidencia", async (task, vars) => {
  const texto = `Sin respuesta de ${v(task, "procesoEvidencia")} dentro del plazo interno. Se escaló al dueño del proceso el ${ahora().toISOString()}. El analista decide con la evidencia disponible.`;
  bool(vars, "evidenciaOportuna", false);
  str(vars, "evidenciaRecibida", texto);
  await registrar(task, "EVIDENCIA_ESCALADA", "Escalar al dueño del proceso fuente", "sistema", { procesoEvidencia: v(task, "procesoEvidencia") });
  log("escalar-evidencia", task, texto);
});

suscribir("alertar-coordinador", async (task, vars) => {
  bool(vars, "alertaTerminoEmitida", true);
  await registrar(task, "ALERTA_TERMINO", "Alertar al coordinador de PQR", "sistema", { fechaVencimiento: v(task, "fechaVencimiento") });
  log("alertar-coordinador", task, `⚠ 70 % del término consumido; vence ${v(task, "fechaVencimiento")}`);
});

suscribir("enviar-ajuste-c4", async (task, vars) => {
  bool(vars, "ajusteEnviadoC4", true);
  await registrar(task, "AJUSTE_AUTORIZADO_C4", "Ajuste autorizado enviado a C4", v(task, "silencioPositivo") ? "silencio administrativo positivo" : "analista de PQR", {
    valorAjuste: v(task, "valorAjuste", 0), codigoSuministro: v(task, "codigoSuministro"), numeroFactura: v(task, "numeroFactura", ""),
  });
  log("enviar-ajuste-c4", task, `MsgRefacturacionAutorizada → C4 por ${v(task, "valorAjuste", 0)} COP`);
});

suscribir("solicitar-revision-c6", async (task, vars) => {
  bool(vars, "revisionSolicitadaC6", true);
  await registrar(task, "REVISION_SOLICITADA_C6", "Revisión de la actuación solicitada a C6", "analista de PQR", { causa: v(task, "causaRaiz") });
  log("solicitar-revision-c6", task, "MsgRevisionActuacionC6 → C6");
});

suscribir("remitir-apelacion-sspd", async (task, vars) => {
  str(vars, "fechaRemisionSSPD", ahora().toISOString());
  await registrar(task, "REMITIDO_SSPD", "Expediente remitido a la SSPD para la apelación", "Oficina de PQR", { estado: "REMITIDO_SSPD", copiaS4: true });
  log("remitir-apelacion-sspd", task, "expediente completo → SSPD (apelación) · copia → S4 (defensa)");
});

suscribir("cerrar-expediente", async (task, vars) => {
  const remitido = tiene(task, "fechaRemisionSSPD");
  const estado = remitido ? "REMITIDO_SSPD" : "CERRADO";
  const radicacion = new Date(v(task, "fechaRadicacion"));
  const notificacion = tiene(task, "fechaNotificacion") ? new Date(v(task, "fechaNotificacion")) : ahora();
  const dias = diasHabilesEntre(radicacion, notificacion);
  str(vars, "estadoExpediente", estado);
  str(vars, "fechaCierre", ahora().toISOString());
  dbl(vars, "diasHabilesRespuesta", dias);
  await registrar(task, "EXPEDIENTE_CERRADO", "Cerrar o remitir el expediente", "sistema", {
    estado, causa: v(task, "causaRaiz"), codigoSuministro: v(task, "codigoSuministro"), asunto: v(task, "asunto"), tipoPQR: v(task, "tipoPQR"),
    sentidoDecision: v(task, "sentidoDecision"), notificadaEnTermino: v(task, "notificadaEnTermino"), diasHabilesRespuesta: dias,
    silencioPositivo: v(task, "silencioPositivo", false), esReapertura: v(task, "esReapertura", false), radicadoAnterior: v(task, "radicadoAnterior", ""),
    medioNotificacion: v(task, "medioNotificacionEfectivo"), alertaTerminoEmitida: v(task, "alertaTerminoEmitida", false),
  });
  log("cerrar-expediente", task, `${estado} · notificada en término: ${v(task, "notificadaEnTermino")} · ${dias} días hábiles`);
});

suscribir("reportar-causa-raiz", async (task, vars) => {
  await registrar(task, "CAUSA_REPORTADA", "PQR atendida y causa raíz reportada", "sistema", { causa: v(task, "causaRaiz"), asunto: v(task, "asunto"), destino: ["G1", "G3"] });
  log("reportar-causa-raiz", task, `causa ${v(task, "causaRaiz")} → G1 (causas agregadas) y G3 (causas recurrentes)`);
});

// =============================================================================
//  C7_NotificarDecision (C7.1, proceso global)
// =============================================================================

suscribir("generar-acto-respuesta", async (task, vars) => {
  const sufijo = v(task, "instancia") === "REPOSICION" ? "R" : "P";
  const numeroActo = `ACT-${v(task, "radicado")}-${sufijo}`;
  str(vars, "numeroActo", numeroActo);
  str(vars, "fechaActo", ahora().toISOString());
  await registrar(task, "ACTO_GENERADO", "Generar el acto de respuesta motivado", "sistema", {
    numeroActo, sentidoDecision: v(task, "sentidoDecision"), silencioPositivo: v(task, "silencioPositivo", false),
    motivacion: v(task, "motivacion"), textoRecursos: v(task, "textoRecursos"),
  });
  log("generar-acto-respuesta", task, `${numeroActo} · ${v(task, "sentidoDecision")} · recursos: ${v(task, "procedenRecursos")}`);
});

suscribir("enviar-comunicacion", async (task, vars) => {
  const electronica = v(task, "autorizaNotificacionElectronica", false) === true;
  const limite = venceEnDiasHabiles(ahora(), 5);
  str(vars, "medioComunicacion", electronica ? "ELECTRONICA" : "CITACION");
  str(vars, "fechaLimiteNotificacion", limite);
  await registrar(task, "COMUNICACION_ENVIADA", "Notificación electrónica o citación enviada", "operador de notificación", {
    medio: electronica ? "ELECTRONICA" : "CITACION", destino: electronica ? v(task, "correoNotificacion") : v(task, "direccionNotificacion"), fechaLimiteNotificacion: limite,
  });
  log("enviar-comunicacion", task, `${electronica ? "notificación electrónica" : "citación para notificación personal"} · plazo ${limite}`);
  // simulación del usuario y del operador
  const reposicion = v(task, "instancia") === "REPOSICION";
  const sim = (reposicion ? v(task, "simularNotificacionReposicion") : null) ?? v(task, "simularNotificacion", electronica ? "ACCESO_ELECTRONICO" : "COMPARECE");
  const destino = { processInstanceId: task.processInstanceId };
  if (sim === "ACCESO_ELECTRONICO") setTimeout(() => correlacionar("MsgAccesoElectronico", destino, { fechaAccesoElectronico: ahora().toISOString() }), 3000);
  else if (sim === "COMPARECE") setTimeout(() => correlacionar("MsgComparecenciaNotificacion", destino, { fechaComparecencia: ahora().toISOString() }), 3000);
  else log("enviar-comunicacion", task, "(simulación: el usuario no se notifica; vencerá el plazo y se notificará por aviso)");
});

suscribir("notificar-por-aviso", async (task, vars) => {
  const reposicion = v(task, "instancia") === "REPOSICION";
  const estado = (reposicion ? v(task, "simularAvisoReposicion") : null) ?? v(task, "simularAviso", "ENTREGADO");
  str(vars, "estadoAviso", estado);
  if (estado === "ENTREGADO") {
    str(vars, "medioNotificacionEfectivo", "AVISO");
    str(vars, "fechaEntregaAviso", ahora().toISOString());
  }
  await registrar(task, "AVISO_ENVIADO", "Notificar por aviso con copia del acto", "operador de notificación", { estadoAviso: estado, direccion: v(task, "direccionNotificacion") });
  log("notificar-por-aviso", task, `aviso ${estado}`);
});

suscribir("publicar-aviso", async (task, vars) => {
  const fin = venceEnDiasHabiles(ahora(), 5);
  str(vars, "fechaFinPublicacion", fin);
  str(vars, "medioNotificacionEfectivo", "AVISO_PUBLICADO");
  await registrar(task, "AVISO_PUBLICADO", "Publicar el aviso (web y cartelera)", "sistema", { fechaFinPublicacion: fin });
  log("publicar-aviso", task, `aviso publicado hasta ${fin}`);
});

suscribir("registrar-prueba-notificacion", async (task, vars) => {
  const medio = v(task, "medioNotificacionEfectivo", "PERSONAL");
  let fechaNotificacion = ahora();
  // por aviso, la notificación se entiende surtida al finalizar el día siguiente a la entrega (art. 69 CPACA)
  if (medio === "AVISO" && MODO === "produccion") fechaNotificacion = new Date(venceEnDiasHabiles(ahora(), 1));
  // si operó el silencio administrativo positivo, por definición la respuesta no se dio dentro del término
  const enTermino = v(task, "silencioPositivo", false) !== true && fechaNotificacion <= new Date(v(task, "fechaVencimiento"));
  const procede = v(task, "procedenRecursos", false) === true;
  const limiteRecursos = procede ? venceEnDiasHabiles(fechaNotificacion, v(task, "plazoRecursosDiasHabiles", 5)) : "";
  str(vars, "fechaNotificacion", fechaNotificacion.toISOString());
  bool(vars, "notificadaEnTermino", enTermino);
  str(vars, "fechaLimiteRecursos", limiteRecursos);
  await registrar(task, "NOTIFICADA", "Registrar la prueba de notificación", "sistema", {
    estado: "NOTIFICADA", numeroActo: v(task, "numeroActo"), medio, fechaNotificacion: fechaNotificacion.toISOString(), notificadaEnTermino: enTermino,
    fechaLimiteRecursos: limiteRecursos,
  });
  log("registrar-prueba-notificacion", task, `notificada por ${medio} · en término: ${enTermino}${procede ? " · recursos hasta " + limiteRecursos : ""}`);

  // simulación del usuario que recurre (solo contra la decisión de primera instancia)
  const recurso = v(task, "simularRecurso", "NINGUNO");
  if (v(task, "instancia") === "PRIMERA" && procede && recurso !== "NINGUNO") {
    const expedienteId = v(task, "expedienteId");
    setTimeout(
      () =>
        correlacionar("MsgRecursoReposicion", { businessKey: expedienteId, processDefinitionKey: undefined }, {
          apelacionSubsidiaria: recurso === "REPOSICION_Y_APELACION",
          argumentosRecurso: "El usuario no está de acuerdo con la decisión y aporta nuevos argumentos.",
        }),
      6000
    );
    log("registrar-prueba-notificacion", task, `(simulación: el usuario presentará ${recurso === "REPOSICION_Y_APELACION" ? "reposición y apelación en subsidio" : "reposición"})`);
  }
});

console.log(`Workers de C7 escuchando en ${BASE_URL} · modo ${MODO}${MODO === "produccion" ? "" : ` (1 día hábil = ${SEG_DIA} s)`}`);
