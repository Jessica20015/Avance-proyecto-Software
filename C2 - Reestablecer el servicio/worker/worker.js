// Worker de demostración para los service tasks externos del proceso EMSA.
// No llama a ningún sistema real: solo lee variables, simula el trabajo y completa la tarea.
const { Client, logger, Variables } = require('camunda-external-task-client-js');

const client = new Client({
  baseUrl: 'http://localhost:8080/engine-rest', // REST API de Camunda Run
  use: logger,
  asyncResponseTimeout: 10000, // long polling
  lockDuration: 30000,
});

// Service task "Solicitar equipos"
client.subscribe('solicitud_repuestos_topic', async ({ task, taskService }) => {
  try {
    const nivelDano = task.variables.get('nivelDano');
    const domicilio = task.variables.get('domicilio');
    console.log(`[solicitud_repuestos] Daño ${nivelDano} en ${domicilio}: solicitando equipos...`);

    const vars = new Variables();
    vars.set('equiposSolicitados', true);
    vars.set('numeroSolicitudEquipos', `SOL-${Date.now()}`);
    await taskService.complete(task, vars);
  } catch (e) {
    await taskService.handleFailure(task, {
      errorMessage: e.message,
      errorDetails: String(e.stack),
      retries: 0,
      retryTimeout: 1000,
    });
  }
});

// Service task "Documentar evento, causa y afectación"
client.subscribe('registro_afectacion_worker', async ({ task, taskService }) => {
  try {
    const causa = task.variables.get('causaFalla');
    const clientes = task.variables.get('clientesAfectados');
    console.log(`[registro_afectacion] Causa: ${causa} | Clientes afectados: ${clientes}`);

    const vars = new Variables();
    vars.set('eventoDocumentado', true);
    vars.set('numeroRegistroEvento', `EVT-${Date.now()}`);
    await taskService.complete(task, vars);
  } catch (e) {
    await taskService.handleFailure(task, {
      errorMessage: e.message,
      errorDetails: String(e.stack),
      retries: 0,
      retryTimeout: 1000,
    });
  }
});
