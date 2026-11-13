// =============================================================================
//  C4 · Facturar el servicio de energía — ENEL La Corocora (Camunda 7)
//  Workers de las External Tasks (patrón "External Task" de Camunda 7).
//
//  Cada client.subscribe(topic) atiende las Service Tasks / eventos de mensaje
//  configurados en el modelo con  Implementation: External  y ese Topic.
//
//  Ejecución:   npm install   →   node c4-workers.js
//  Variables de entorno opcionales:
//    CAMUNDA_URL  (por defecto http://localhost:8080/engine-rest)
//    C4_MODO      demo | produccion   (plazos cortos para demostrar o plazos reales)
//
//  Los sistemas externos (C3, C5, G3, operador de entrega) se SIMULAN aquí: el
//  worker que representa al canal de entrega o a C3 responde, unos segundos
//  después, correlacionando el mensaje correspondiente vía REST.
// =============================================================================
import { Client, logger, Variables } from "camunda-external-task-client-js";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.CAMUNDA_URL || "http://localhost:8080/engine-rest";
const MODO = (process.env.C4_MODO || "demo").toLowerCase();
const AQUI = dirname(fileURLToPath(import.meta.url));
const EXPEDIENTE = join(AQUI, "expediente", "expediente-facturacion.jsonl");

const client = new Client({ baseUrl: BASE_URL, use: logger, asyncResponseTimeout: 10000, lockDuration: 30000 });

// -----------------------------------------------------------------------------
// "Repositorio de reglas tarifarias versionadas" (data store de G3), simulado.
// CU = costo unitario de prestación del servicio (COP/kWh) por período.
// -----------------------------------------------------------------------------
const REGLAS_TARIFARIAS = {
  "2026-09": { versionRegla: "CU-2026-09 v1 (aprobada por G3)", cuKwh: 1008.42 },
  "2026-10": { versionRegla: "CU-2026-10 v1 (aprobada por G3)", cuKwh: 1012.37 },
  "2026-11": { versionRegla: "CU-2026-11 v2 (aprobada por G3)", cuKwh: 1019.85 },
  "2026-12": { versionRegla: "CU-2026-12 v1 (aprobada por G3)", cuKwh: 1024.1 },
};

// Plazos de los temporizadores (ISO-8601). En demo son cortos para ver los caminos.
const PLAZOS = MODO === "produccion"
  ? { plazoEsperaC3: "P2D", plazoSlaCalidad: "PT8H", plazoEntrega: "P3D" }
  : { plazoEsperaC3: "PT1M", plazoSlaCalidad: "PT2M", plazoEntrega: "PT1M" };

// ----------------------------- utilidades -----------------------------------
const ahora = () => new Date().toISOString();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const v = (task, nombre, porDefecto = null) => {
  const valor = task.variables.get(nombre);
  return valor === undefined || valor === null ? porDefecto : valor;
};
const dbl = (vars, nombre, valor) => vars.setTyped(nombre, { value: Number(valor), type: "Double" });
const int = (vars, nombre, valor) => vars.setTyped(nombre, { value: Math.trunc(Number(valor)), type: "Integer" });
const str = (vars, nombre, valor) => vars.setTyped(nombre, { value: valor === null ? null : String(valor), type: "String" });
const bool = (vars, nombre, valor) => vars.setTyped(nombre, { value: Boolean(valor), type: "Boolean" });
const log = (topic, task, msg) =>
  console.log(`[${new Date().toLocaleTimeString()}] [${topic}] ${task.businessKey || task.processInstanceId} → ${msg}`);

/** Correlaciona un mensaje con reintentos (la instancia puede no haber llegado aún al evento). */
async function correlacionar(messageName, processInstanceId, variables = {}) {
  const processVariables = {};
  for (const [k, val] of Object.entries(variables)) {
    if (val !== null && typeof val === "object") { processVariables[k] = val; continue; } // ya tipada
    let type = "String";
    if (typeof val === "number") type = Number.isInteger(val) ? "Integer" : "Double";
    if (typeof val === "boolean") type = "Boolean";
    processVariables[k] = { value: val, type };
  }
  for (let intento = 1; intento <= 8; intento++) {
    const res = await fetch(`${BASE_URL}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageName, processInstanceId, processVariables }),
    });
    if (res.ok) {
      console.log(`    ↳ mensaje ${messageName} correlacionado con ${processInstanceId}`);
      return true;
    }
    await esperar(1500);
  }
  console.warn(`    ↳ no se pudo correlacionar ${messageName} con ${processInstanceId}`);
  return false;
}

// =============================================================================
// 1. Consolidar insumos de facturación  (Service Task · topic consolidar-insumos)
// =============================================================================
client.subscribe("consolidar-insumos", async ({ task, taskService }) => {
  const periodo = v(task, "periodo");
  const regla = REGLAS_TARIFARIAS[periodo];
  if (!regla) {
    log("consolidar-insumos", task, `sin regla tarifaria vigente para ${periodo} → error BPMN`);
    const vars = new Variables();
    str(vars, "periodoSinRegla", periodo);
    await taskService.handleBpmnError(task, "ERR_REGLA_NO_VIGENTE",
      `No existe una versión de la regla tarifaria aprobada por G3 para el período ${periodo}`, vars);
    return;
  }
  const consumo = Number(v(task, "consumoKwh", 0));
  const promedio = Number(v(task, "consumoPromedioKwh", 150)); // histórico de C3 (simulado si no llega)
  const desviacion = promedio > 0 ? Math.abs(consumo - promedio) / promedio * 100 : (consumo > 0 ? 999 : 0);

  const vars = new Variables();
  str(vars, "versionRegla", regla.versionRegla);
  dbl(vars, "cuKwh", regla.cuKwh);
  dbl(vars, "consumoPromedioKwh", promedio);
  dbl(vars, "desviacionAbsPct", Math.round(desviacion * 100) / 100);
  dbl(vars, "consumoFacturableKwh", consumo);
  bool(vars, "facturaProvisional", false);
  // Inicialización de contadores y datos que el modelo necesita (solo si no existen)
  const porDefecto = { tipoLectura: "REAL", canalPreferido: "DIGITAL", usoServicio: "RESIDENCIAL" };
  for (const [k, val] of Object.entries(porDefecto)) if (v(task, k) === null) str(vars, k, val);
  for (const k of ["estimacionesConsecutivas", "devolucionesC3", "correccionesPreEmision", "intentosEntrega"])
    if (v(task, k) === null) int(vars, k, 0);
  if (v(task, "maxIntentosEntrega") === null) int(vars, "maxIntentosEntrega", 2);
  if (v(task, "estrato") === null) dbl(vars, "estrato", 4);
  if (v(task, "fechaLiberacionC3") === null) str(vars, "fechaLiberacionC3", ahora()); // t0 del indicador
  for (const [k, val] of Object.entries(PLAZOS)) if (v(task, k) === null) str(vars, k, val);

  log("consolidar-insumos", task, `consumo ${consumo} kWh, promedio ${promedio} kWh, desviación ${desviacion.toFixed(2)} %, regla ${regla.versionRegla}`);
  await taskService.complete(task, vars);
});

// =============================================================================
// 2. Excepción devuelta a C3  (Intermediate Message Throw · topic devolver-excepcion-c3)
//    Simula a C3: si simularRespuestaC3 = CORREGIDO, C3 responde con el consumo corregido.
// =============================================================================
client.subscribe("devolver-excepcion-c3", async ({ task, taskService }) => {
  const devoluciones = Number(v(task, "devolucionesC3", 0)) + 1;
  const vars = new Variables();
  int(vars, "devolucionesC3", devoluciones);
  str(vars, "fechaDevolucionC3", ahora());
  log("devolver-excepcion-c3", task, `excepción enviada a C3 (devolución #${devoluciones}): ${v(task, "motivoExcepcion", "")}`);
  await taskService.complete(task, vars);

  const respuesta = String(v(task, "simularRespuestaC3", "CORREGIDO")).toUpperCase();
  if (respuesta === "CORREGIDO") {
    await esperar(4000);
    const corregido = Number(v(task, "consumoCorregidoKwh", Number(v(task, "consumoPromedioKwh", 150)) * 1.08));
    await correlacionar("MsgConsumoCorregido", task.processInstanceId, {
      consumoKwh: { value: Math.round(corregido * 100) / 100, type: "Double" },
      tipoLectura: "REAL",
      estimacionesConsecutivas: 0,
      fechaCorreccionC3: ahora(),
    });
  } else {
    console.log("    ↳ C3 no responde (simulación): vencerá el temporizador del event-based gateway");
  }
});

// =============================================================================
// 3. Asignar consumo promedio (art. 149 Ley 142)  (Service Task · topic asignar-consumo-promedio)
// =============================================================================
client.subscribe("asignar-consumo-promedio", async ({ task, taskService }) => {
  const promedio = Number(v(task, "consumoPromedioKwh", 0));
  const vars = new Variables();
  dbl(vars, "consumoFacturableKwh", promedio);
  bool(vars, "facturaProvisional", true);
  str(vars, "motivoProvisional", "C3 no respondió dentro del plazo: se factura por promedio mientras se establece la causa (art. 149, Ley 142 de 1994)");
  log("asignar-consumo-promedio", task, `factura provisional con ${promedio} kWh`);
  await taskService.complete(task, vars);
});

// =============================================================================
// 4. Liquidar factura — motor de liquidación  (Service Task · topic liquidar-factura)
// =============================================================================
client.subscribe("liquidar-factura", async ({ task, taskService }) => {
  const cu = Number(v(task, "cuKwh", 0));
  const consumo = Number(v(task, "consumoFacturableKwh", 0));
  const factor = Number(v(task, "factorSubsidioContribucion", 0));
  const subsistencia = Number(v(task, "consumoSubsistenciaKwh", 0));

  const valorEnergia = Math.round(cu * consumo);
  let ajuste = 0;
  if (factor < 0) ajuste = Math.round(factor * cu * Math.min(consumo, subsistencia)); // subsidio: solo subsistencia
  else if (factor > 0) ajuste = Math.round(factor * cu * consumo);                    // contribución: todo el consumo
  const total = valorEnergia + ajuste;

  const vars = new Variables();
  dbl(vars, "valorEnergia", valorEnergia);
  dbl(vars, "valorAjusteTarifario", ajuste);
  dbl(vars, "valorTotal", total);
  str(vars, "fechaLiquidacion", ahora());
  log("liquidar-factura", task, `${consumo} kWh × ${cu} = ${valorEnergia}; ajuste ${ajuste}; total ${total} COP`);
  await taskService.complete(task, vars);
});

// =============================================================================
// 5. Escalar verificación al coordinador  (timer no interrumpible · topic escalar-coordinador)
// =============================================================================
client.subscribe("escalar-coordinador", async ({ task, taskService }) => {
  const vars = new Variables();
  str(vars, "fechaEscalamientoCalidad", ahora());
  log("escalar-coordinador", task, "SLA de verificación vencido: aviso enviado al coordinador de facturación");
  await taskService.complete(task, vars);
});

// =============================================================================
// 6. Emitir factura  (Service Task · topic emitir-factura)
// =============================================================================
client.subscribe("emitir-factura", async ({ task, taskService }) => {
  const codigo = v(task, "codigoSuministro", "SIN-CODIGO");
  const periodo = v(task, "periodo", "0000-00");
  const esRefacturacion = Boolean(v(task, "esRefacturacion", false));
  const version = esRefacturacion ? Number(v(task, "versionFacturaAnterior", 1)) + 1 : 1;
  const emision = new Date();
  const limite = new Date(emision.getTime() + 15 * 24 * 3600 * 1000);

  const vars = new Variables();
  int(vars, "versionFactura", version);
  str(vars, "numeroFactura", `FE-${periodo.replace("-", "")}-${codigo}-v${version}`);
  str(vars, "cuentaPorCobrarId", `CXC-${codigo}-${periodo}`); // una sola cuenta por suministro-período
  str(vars, "fechaEmision", emision.toISOString());
  str(vars, "fechaLimitePago", limite.toISOString().substring(0, 10));
  log("emitir-factura", task, `factura FE-${periodo.replace("-", "")}-${codigo}-v${version} emitida`);
  await taskService.complete(task, vars);
});

// =============================================================================
// 7. Cuenta por cobrar enviada a C5  (Intermediate Message Throw · topic notificar-c5)
// =============================================================================
client.subscribe("notificar-c5", async ({ task, taskService }) => {
  const vars = new Variables();
  str(vars, "fechaNotificacionC5", ahora());
  const tipo = v(task, "esRefacturacion", false) ? "NUEVA VERSIÓN de la cuenta existente" : "cuenta nueva";
  log("notificar-c5", task, `C5 ← ${v(task, "cuentaPorCobrarId")} (${tipo}) por ${v(task, "valorTotal")} COP, vence ${v(task, "fechaLimitePago")}`);
  await taskService.complete(task, vars);
});

// =============================================================================
// 8. Registrar expediente de trazabilidad  (Service Task · topic registrar-expediente)
//    Data store "Expediente de facturación": un archivo JSONL (evidencia para C7).
// =============================================================================
client.subscribe("registrar-expediente", async ({ task, taskService }) => {
  const campos = ["codigoSuministro", "periodo", "esRefacturacion", "origenRefacturacion", "tipoLectura",
    "consumoKwh", "consumoPromedioKwh", "desviacionAbsPct", "decisionConsumo", "motivoExcepcion",
    "decisionAnalista", "evidenciaAnalista", "devolucionesC3", "facturaProvisional", "consumoFacturableKwh",
    "usoServicio", "estrato", "versionRegla", "cuKwh", "factorSubsidioContribucion", "valorEnergia",
    "valorAjusteTarifario", "valorTotal", "correccionesPreEmision", "motivoCorreccion", "descripcionCorreccion",
    "numeroFactura", "versionFactura", "cuentaPorCobrarId", "fechaLiberacionC3", "fechaEmision"];
  const registro = { registradoEn: ahora(), processInstanceId: task.processInstanceId, businessKey: task.businessKey };
  for (const c of campos) registro[c] = v(task, c);
  await mkdir(dirname(EXPEDIENTE), { recursive: true });
  await appendFile(EXPEDIENTE, JSON.stringify(registro) + "\n", "utf8");

  const vars = new Variables();
  str(vars, "expedienteRegistrado", EXPEDIENTE);
  log("registrar-expediente", task, `expediente guardado en ${EXPEDIENTE}`);
  await taskService.complete(task, vars);
});

// =============================================================================
// 9. Solicitud de regla tarifaria enviada a G3  (Message End Event · topic solicitar-regla-g3)
// =============================================================================
client.subscribe("solicitar-regla-g3", async ({ task, taskService }) => {
  log("solicitar-regla-g3", task, `G3 ← solicitud de regla tarifaria para ${v(task, "periodoSinRegla", v(task, "periodo"))}: ${v(task, "mensajeError", "")}`);
  await taskService.complete(task);
});

// =============================================================================
// 10. Enviar factura por el canal asignado  (C4.1 · topic enviar-factura)
//     Simula al operador de entrega según simularResultadoEntrega:
//     CONFIRMADA | DEVUELTA_LUEGO_CONFIRMADA | DEVUELTA | SIN_RESPUESTA
// =============================================================================
client.subscribe("enviar-factura", async ({ task, taskService }) => {
  const intento = Number(v(task, "intentosEntrega", 0)) + 1;
  const canal = intento === 1 ? String(v(task, "canalPreferido", "DIGITAL")) : "FISICO";
  const vars = new Variables();
  int(vars, "intentosEntrega", intento);
  str(vars, "canalEntrega", canal);
  str(vars, "fechaEnvio", ahora());
  str(vars, "ultimoResultadoEntrega", "SIN_RESPUESTA_DEL_OPERADOR");
  log("enviar-factura", task, `intento ${intento} por canal ${canal} (${v(task, "numeroFactura")})`);
  await taskService.complete(task, vars);

  const escenario = String(v(task, "simularResultadoEntrega", "CONFIRMADA")).toUpperCase();
  let resultado = "NINGUNO";
  if (escenario === "CONFIRMADA") resultado = "CONFIRMADA";
  else if (escenario === "DEVUELTA") resultado = "DEVUELTA";
  else if (escenario === "DEVUELTA_LUEGO_CONFIRMADA") resultado = intento === 1 ? "DEVUELTA" : "CONFIRMADA";

  await esperar(3000);
  if (resultado === "CONFIRMADA") {
    await correlacionar("MsgConfirmacionEntrega", task.processInstanceId, {
      ultimoResultadoEntrega: "CONFIRMADA",
      soporteEntrega: canal === "DIGITAL" ? `ACUSE-${Date.now()}` : `GUIA-${Date.now()}`,
    });
  } else if (resultado === "DEVUELTA") {
    await correlacionar("MsgDevolucionFactura", task.processInstanceId, {
      ultimoResultadoEntrega: canal === "DIGITAL" ? "DEVUELTA: buzón inexistente" : "DEVUELTA: dirección no encontrada",
    });
  } else {
    console.log("    ↳ el operador no responde (simulación): vencerá el plazo de entrega");
  }
});

// =============================================================================
// 11. Registrar prueba de entrega  (C4.1 · topic registrar-prueba-entrega)
// =============================================================================
client.subscribe("registrar-prueba-entrega", async ({ task, taskService }) => {
  const entrega = new Date();
  const t0 = v(task, "fechaLiberacionC3");
  const horas = t0 ? Math.round((entrega - new Date(t0)) / 36e3) / 100 : null;
  const alterno = v(task, "accionEntregaFallida");
  const vars = new Variables();
  str(vars, "fechaEntrega", entrega.toISOString());
  str(vars, "estadoEntrega", alterno ? `ENTREGADA_MEDIO_ALTERNO (${alterno})` : "ENTREGADA");
  if (horas !== null) dbl(vars, "cicloFacturacionHoras", horas);
  log("registrar-prueba-entrega", task, `prueba registrada (${v(task, "soporteEntrega")}); ciclo de facturación ${horas} h`);
  await taskService.complete(task, vars);
});

console.log(`Workers C4 escuchando en ${BASE_URL} (modo ${MODO}). Ctrl+C para detener.`);
