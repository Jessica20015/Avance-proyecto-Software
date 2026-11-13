# Proyecto de Automatización de Procesos de Negocio (BPMN / DMN)
## Caso de Estudio: ENEL La Corocora (Electrificadora del Meta S.A. E.S.P. - EMSA)

---

### Nombre del proyecto:
**ENEL La Corocora — Sistema de Gestión y Automatización de Procesos de Distribución y Comercialización de Energía Eléctrica**

---

### Integrantes del grupo:
* **JESSICA MARCELA BAQUERO MEJÍA** — Responsable del proceso de negocio: `C2`
* **MIGUEL ANGEL TRASLAVIÑA RODRIGUEZ** — Responsable del proceso de negocio: `C4`
* **DUVAN FELIPE BAQUERO CERQUERA** — Responsable del proceso de negocio: `C7`

> **Nota:** La distribución de los 3 procesos core implementados en el repositorio se detalla a continuación.

---

### Lista que permite identificar el proyecto del que cada uno se hizo responsable:

---

#### 1. Proceso C2 — Reestablecer el servicio tras una falla

* **Estudiante:** `JESSICA MARCELA BAQUERO MEJÍA`
* **Proceso que asumió:** **C2 · Reestablecer el servicio tras una falla técnica** (Atención de avisos de interrupción, validación de alarmas en red, inspección técnica en terreno, cuadrillas de reparación y restitución del suministro eléctrico).
* **Nombre de la carpeta en el repositorio:** `C2 - Reestablecer el servicio`
* **Lista de procesos, forms y dmns que se deben desplegar en el motor:**
  * **Procesos BPMN (`.bpmn`):**
    * `RestablecerElServicioTrasUnaFalla.bpmn` *(Proceso principal; Process ID: `restablecerServicioTrasFalla`)*
    * `realizarVisitaTecnica.bpmn` *(Subproceso global ejecutado por Call Activity; Process ID: `realizarVisitaTecnica`)*
  * **Tablas de Decisión DMN (`.dmn`):**
    * `clasificarDano.dmn` *(Decisión: `clasificacionRepuestos` — Clasificación de repuestos)*
  * **Formularios Camunda Forms (`.form`):**
    * `registroFallaRecibido.form` *(Formulario de inicio asociado al evento inicial)*
    * `validarAlarmasForm.form` *(User Task: Validar alarmas)*
    * `despacharCuadrillaForm.form` *(User Task: Despachar cuadrilla)*
    * `inspeccionarFallaForm.form` *(User Task: Inspeccionar falla)*
    * `reporteReparacion.form` *(User Task: Reporte de reparación)*
    * `confirmarRestitucionForm.form` *(User Task: Confirmar restitución)*
    * `escalarDemoraForm.form` *(User Task: Escalar demora de restablecimiento)*
    * `agendarVisitaTecnica.form` *(User Task: Agendar visita técnica)*
    * `validarVisitaForm.form` *(User Task: Validar visita técnica)*
    * `realizarReporteVisitaTecnica.form` *(User Task: Reporte de visita técnica)*
* **Nombre visible dentro de la máquina para darle “start”:**
  * En **Camunda Tasklist**: **`Restablecer el servicio tras una falla`** (abre el formulario desplegado `registroFallaRecibido.form`).
  * Process Definition Key / ID: `restablecerServicioTrasFalla`.
  * En **Camunda Cockpit**: Aparece listado como **`Restablecer el servicio tras una falla`**.
* **Workers de External Tasks:**
  * Carpeta: `C2 - Reestablecer el servicio/worker`
  * Ejecución: `npm install` && `node worker.js`
  * Topics suscritos: `solicitud_repuestos_topic`, `registro_afectacion_worker`.

---

#### 2. Proceso C4 — Facturar el servicio de energía

* **Estudiante:** `MIGUEL ANGEL TRASLAVIÑA RODRIGUEZ`
* **Proceso que asumió:** **C4 · Facturar el servicio de energía** (Consolidación de lecturas de consumo, clasificación DMN de anomalías/desviaciones significativas, determinación de subsidios y contribuciones por estrato, control de calidad previo a la emisión, call activity para entrega física/electrónica y generación de cuenta por cobrar hacia C5).
* **Nombre de la carpeta en el repositorio:** `C4 - Facturar el servicio`
* **Lista de procesos, forms y dmns que se deben desplegar en el motor:**
  * **Procesos BPMN (`.bpmn`):**
    * `C4_FacturarServicioEnergia.bpmn` *(Proceso principal; Process ID: `C4_FacturarServicioEnergia`)*
    * `C4_EntregarFactura.bpmn` *(Subproceso global C4.1 invocado por Call Activity; Process ID: `C4_EntregarFactura`)*
  * **Tablas de Decisión DMN (`.dmn`):**
    * `ClasificarConsumo.dmn` *(Decisión: `ClasificarConsumo` — Clasificar consumo para facturación; Hit Policy: FIRST)*
    * `DeterminarTarifaAplicable.dmn` *(Decisión: `DeterminarTarifaAplicable` — Determinar tarifa aplicable; Hit Policy: UNIQUE)*
  * **Formularios Camunda Forms (`.form`):**
    * `RevisarExcepcionConsumo.form` *(User Task: Revisión de excepción por el analista)*
    * `VerificarCalidadFactura.form` *(User Task: Verificación de calidad de la factura previa a emisión)*
    * `CorregirLiquidacion.form` *(User Task: Corrección de liquidación por liquidador tarifario)*
    * `GestionarEntregaFallida.form` *(User Task en C4.1: Gestión de entrega física/virtual fallida)*
* **Nombre visible dentro de la máquina para darle “start”:**
  * En **Camunda Cockpit**: **`C4 · Facturar el servicio de energía`** (Process Definition Key: `C4_FacturarServicioEnergia`).
  * **Mecanismo de inicio:** C4 inicia mediante eventos de mensaje (`MsgConsumoValidado` disparado por medición C3, o `MsgRefacturacionAutorizada` disparado por refacturación C6/C7). Por tanto, no requiere un formulario de inicio manual en Tasklist:
    * Se inicia automáticamente por API REST: `POST /engine-rest/message` con mensaje `MsgConsumoValidado`.
    * O mediante el simulador incluido ejecutando: `cd "C4 - Facturar el servicio/workers"` && `node simular-entradas.js normal` (admite escenarios como `normal`, `revision`, `desviacion`, `refacturacion`, entre otros).
* **Workers de External Tasks:**
  * Carpeta: `C4 - Facturar el servicio/workers`
  * Ejecución: `npm install` && `node c4-workers.js`
  * 11 Topics suscritos: `consolidar-insumos`, `liquidar-factura`, `emitir-factura`, `asignar-consumo-promedio`, `registrar-expediente`, `escalar-coordinador`, `devolver-excepcion-c3`, `notificar-c5`, `solicitar-regla-g3`, `enviar-factura`, `registrar-prueba-entrega`.

---

#### 3. Proceso C7 — Atender una PQR del usuario

* **Estudiante:** `DUVAN FELIPE BAQUERO CERQUERA`
* **Proceso que asumió:** **C7 · Atender una PQR del usuario** (Radicación integral multicanal de peticiones, quejas, reclamos y recursos bajo Ley 142 de 1994, tipificación y cálculo de términos hábiles mediante DMN, solicitud de evidencias a procesos fuente, control estricto de términos con alerta no interrumpible al 70%, silencio administrativo positivo, revisión jurídica del debido proceso, call activity de notificación verificable C7.1, trámite de reposición y remisión de apelación ante la SSPD).
* **Nombre de la carpeta en el repositorio:** `C7 - Atender una PQR`
* **Lista de procesos, forms y dmns que se deben desplegar en el motor:**
  * **Procesos BPMN (`.bpmn`):**
    * `C7_AtenderPQR.bpmn` *(Proceso principal; Process ID: `C7_AtenderPQR`)*
    * `C7_NotificarDecision.bpmn` *(Subproceso global C7.1 invocado por Call Activity; Process ID: `C7_NotificarDecision`, no instanciable directamente: `isStartableInTasklist="false"`)*
  * **Tablas de Decisión DMN (`.dmn`):**
    * `TipificarPQR.dmn` *(Decisión: `TipificarPQR` — Tipificar la PQR y fijar el término aplicable; Hit Policy: FIRST)*
    * `DeterminarRecursosProcedentes.dmn` *(Decisión: `DeterminarRecursosProcedentes` — Determinar los recursos procedentes; Hit Policy: UNIQUE)*
  * **Formularios Camunda Forms (`.form`):**
    * `RadicarPQR.form` *(Formulario de inicio para ventanilla presencial y canal telefónico)*
    * `TipificarEnrutarPQR.form` *(User Task: Orientador y enrutador de usuarios)*
    * `ProyectarRespuestaPQR.form` *(User Task: Analista de PQR)*
    * `RevisarProyectoRespuesta.form` *(User Task: Apoyo jurídico para debido proceso)*
    * `ReconocerSilencioPositivo.form` *(User Task: Analista al vencer término legal)*
    * `NotificarPersonalmente.form` *(User Task en C7.1: Notificación presencial al usuario)*
* **Nombre visible dentro de la máquina para darle “start”:**
  * En **Camunda Tasklist**: **`C7 · Atender una PQR del usuario`** (al pulsar "Start process" despliega el formulario `RadicarPQR`).
  * Process Definition Key / ID: `C7_AtenderPQR`.
  * En **Camunda Cockpit**: Aparece listado como **`C7 · Atender una PQR del usuario`**.
  * **Mecanismo alterno de inicio:** También puede ser instanciado vía canal portal web mediante mensaje `MsgPQRRecibidaPortal` ejecutando: `cd "C7 - Atender una PQR/workers"` && `node simular-entradas.js reclamo-portal`.
* **Workers de External Tasks:**
  * Carpeta: `C7 - Atender una PQR/workers`
  * Ejecución: `npm install` && `node c7-workers.js`
  * 16 Topics suscritos: `radicar-pqr`, `abrir-expediente`, `enviar-constancia-radicado`, `solicitar-evidencia`, `escalar-evidencia`, `alertar-coordinador`, `enviar-ajuste-c4`, `solicitar-revision-c6`, `remitir-apelacion-sspd`, `cerrar-expediente`, `reportar-causa-raiz`, `generar-acto-respuesta`, `enviar-comunicacion`, `notificar-por-aviso`, `publicar-aviso`, `registrar-prueba-notificacion`.

---

## Instrucciones Generales de Despliegue y Ejecución en el Motor

### 1. Plataforma Requerida
* **Motor:** Camunda Platform **7.23 / 7.24** (Camunda BPM Run).
* **Modelador:** Camunda Modeler **5.x**.
* **Entorno de ejecución de Workers:** Node.js (v18 o superior).

### 2. Regla Crítica de Despliegue
Para cada carpeta de proceso (`C2`, `C4`, `C7`), **todos los artefactos de la carpeta (`.bpmn`, `.dmn` y `.form`) deben desplegarse conjuntamente en un único despliegue (*deployment*)**. 
* Esto garantiza que las referencias `camunda:formRef` con *binding* `deployment` y los *Call Activities* resuelvan correctamente las definiciones vinculadas.

### 3. Ejecución de los Workers
Cada proceso cuenta con componentes de servicio externo implementados en JavaScript utilizando `@camunda/external-task-client-js`. Para ejecutarlos:
1. Abra una terminal en la subcarpeta `worker` o `workers` del proceso respectivo.
2. Ejecute `npm install` para instalar las dependencias.
3. Inicie el worker con `node worker.js` (en C2) o `node c4-workers.js` / `node c7-workers.js` (en C4 y C7).

> **NOTA DE EVALUACIÓN:** Todos los formularios y variables de entrada cuentan con valores por defecto o preconfigurados para facilitar la ejecución y verificación inmediata del flujo completo de principio a fin.
