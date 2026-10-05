const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

const VERSION = "2.11.0";
const LIVE_MS = 120_000; // LIVE mientras el último envío tenga menos de 2 minutos
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";

app.use(cors());
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

function horaParaguay(date = new Date()) {
  return new Intl.DateTimeFormat("es-PY", {
    timeZone: "America/Asuncion",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function normalizar(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function buscarCandidato(data, partes) {
  const candidatos = Array.isArray(data?.candidatos) ? data.candidatos : [];
  return candidatos.find(c =>
    partes.every(p => normalizar(c?.nomCandidato).includes(p))
  );
}

function porcentaje(votos, total) {
  if (!Number.isFinite(votos) || !Number.isFinite(total) || total <= 0) return null;
  return ((votos / total) * 100).toFixed(2) + "%";
}

function esEnteroNoNegativo(v) {
  return Number.isInteger(v) && v >= 0;
}

// Último dato conocido. Nunca se presenta como LIVE al iniciar.
let estadoActual = {
  ok: false,
  version: VERSION,
  source: "COLECTOR_TREP",
  status: "STARTING",
  stale: true,
  servidorHora: null,
  ultimaConsulta: null,
  ultimaRecepcion: null,
  ultimoCambio: null,
  edadSegundos: null,
  error: COLLECTOR_TOKEN
    ? "Esperando primera transmisión del colector"
    : "Falta configurar COLLECTOR_TOKEN en Render",
  mesas: {
    total: 71,
    procesadas: 71,
    porcentaje: "100.00%",
    totalVotos: 11871
  },
  intendente: {
    lista9: {
      nombre: "CONCEPCION MARTINEZ",
      votos: 6919,
      porcentaje: "58.28%"
    },
    lista1: {
      nombre: "HERNAN RIVAS",
      votos: 4535,
      porcentaje: "38.20%"
    }
  },
  concejal: {
    armandoKegler: {
      nombre: "ARMANDO KEGLER SAUCEDO",
      orden: 4,
      votosPreferenciales: 328,
      totalLista9Concejales: 3840
    }
  }
};

let firmaUltimosDatos = null;
let ultimaRecepcionMs = null;

function parsearCarga(body) {
  const intData = body?.intendente;
  const conData = body?.concejales;

  if (!intData || !conData) {
    throw new Error("La carga debe incluir 'intendente' y 'concejales'");
  }

  const martinez = buscarCandidato(intData, ["CONCEPCION", "MARTINEZ"]);
  const rivas = buscarCandidato(intData, ["HERNAN", "RIVAS"]);
  const kegler = buscarCandidato(conData, ["ARMANDO", "KEGLER"]);

  if (!martinez || !rivas || !kegler) {
    throw new Error("Faltan candidatos esperados en los datos recibidos");
  }

  const vm = Number(martinez.votos);
  const vr = Number(rivas.votos);
  const vk = Number(kegler.votos);

  const totales = intData.totales || {};
  const totalVotos = Number(totales.totalVotos);
  const totalMesas = Number(totales.totalMesas);
  const mesasPublicadas = Number(totales.mesasPublicadas);

  if (![vm, vr, vk].every(esEnteroNoNegativo)) {
    throw new Error("Los votos recibidos no son válidos");
  }
  if (!esEnteroNoNegativo(totalVotos) ||
      !esEnteroNoNegativo(totalMesas) ||
      !esEnteroNoNegativo(mesasPublicadas) ||
      mesasPublicadas > totalMesas) {
    throw new Error("Los totales/mesas recibidos no son válidos");
  }

  return {
    corteOficial:
      intData.horaFormateada ||
      conData.horaFormateada ||
      null,
    mesas: {
      total: totalMesas,
      procesadas: mesasPublicadas,
      porcentaje: totalMesas > 0
        ? ((mesasPublicadas / totalMesas) * 100).toFixed(2) + "%"
        : "0.00%",
      totalVotos
    },
    intendente: {
      lista9: {
        nombre: "CONCEPCION MARTINEZ",
        votos: vm,
        porcentaje: porcentaje(vm, totalVotos)
      },
      lista1: {
        nombre: "HERNAN RIVAS",
        votos: vr,
        porcentaje: porcentaje(vr, totalVotos)
      }
    },
    concejal: {
      armandoKegler: {
        nombre: "ARMANDO KEGLER SAUCEDO",
        orden: 4,
        votosPreferenciales: vk,
        // Se conserva hasta que definamos qué campo oficial representa
        // inequívocamente el total de la Lista 9 para concejales.
        totalLista9Concejales:
          estadoActual.concejal.armandoKegler.totalLista9Concejales
      }
    }
  };
}

function tokenValido(req) {
  const bearer = String(req.get("authorization") || "");
  const headerToken = String(req.get("x-collector-token") || "");
  const token = bearer.startsWith("Bearer ")
    ? bearer.slice(7).trim()
    : headerToken.trim();

  return Boolean(COLLECTOR_TOKEN) && token === COLLECTOR_TOKEN;
}

function actualizarEstadoTemporal() {
  if (!ultimaRecepcionMs) {
    estadoActual.status = "STALE";
    estadoActual.stale = true;
    estadoActual.edadSegundos = null;
    return;
  }

  const edad = Date.now() - ultimaRecepcionMs;
  estadoActual.edadSegundos = Math.floor(edad / 1000);

  if (edad <= LIVE_MS) {
    estadoActual.status = "LIVE";
    estadoActual.stale = false;
    estadoActual.ok = true;
  } else {
    estadoActual.status = "STALE";
    estadoActual.stale = true;
    estadoActual.ok = false;
    estadoActual.error =
      `Sin transmisión del colector desde hace ${estadoActual.edadSegundos} segundos`;
  }
}

app.post("/api/colector", (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!COLLECTOR_TOKEN) {
    return res.status(503).json({
      ok: false,
      version: VERSION,
      error: "COLLECTOR_TOKEN no está configurado en Render"
    });
  }

  if (!tokenValido(req)) {
    console.warn(`[${VERSION}] COLECTOR rechazado: token inválido`);
    return res.status(401).json({
      ok: false,
      error: "No autorizado"
    });
  }

  try {
    const datos = parsearCarga(req.body);
    const ahora = new Date();
    const firma = JSON.stringify({
      mesas: datos.mesas,
      intendente: datos.intendente,
      concejal: datos.concejal,
      corteOficial: datos.corteOficial
    });

    if (firma !== firmaUltimosDatos) {
      estadoActual.ultimoCambio = horaParaguay(ahora);
      firmaUltimosDatos = firma;
    }

    ultimaRecepcionMs = Date.now();

    estadoActual = {
      ...estadoActual,
      ...datos,
      ok: true,
      version: VERSION,
      source: "COLECTOR_TREP · TSJE Paraguay",
      status: "LIVE",
      stale: false,
      servidorHora: horaParaguay(ahora),
      ultimaConsulta: horaParaguay(ahora),
      ultimaRecepcion: horaParaguay(ahora),
      edadSegundos: 0,
      error: null
    };

    console.log(
      `[${VERSION}] COLECTOR OK | corte=${datos.corteOficial || "--"} ` +
      `| mesas=${datos.mesas.procesadas}/${datos.mesas.total} ` +
      `| Martinez=${datos.intendente.lista9.votos} ` +
      `| Rivas=${datos.intendente.lista1.votos} ` +
      `| Kegler=${datos.concejal.armandoKegler.votosPreferenciales}`
    );

    return res.json({
      ok: true,
      version: VERSION,
      status: "LIVE",
      recibido: estadoActual.ultimaRecepcion,
      corteOficial: datos.corteOficial
    });
  } catch (err) {
    console.error(`[${VERSION}] COLECTOR ERROR: ${err.message}`);
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error: err.message
    });
  }
});

app.get("/api/resultados", (req, res) => {
  actualizarEstadoTemporal();
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.json({
    ...estadoActual,
    proximaConsultaSegundos: 60
  });
});

app.get("/api/health", (req, res) => {
  actualizarEstadoTemporal();
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.json({
    service: "TREP Monitor Armando Kegler",
    version: VERSION,
    source: estadoActual.source,
    status: estadoActual.status,
    stale: estadoActual.stale,
    collectorConfigured: Boolean(COLLECTOR_TOKEN),
    ultimaRecepcion: estadoActual.ultimaRecepcion,
    edadSegundos: estadoActual.edadSegundos,
    ultimoCambio: estadoActual.ultimoCambio,
    corteOficial: estadoActual.corteOficial || null,
    error: estadoActual.error
  });
});

// Se conserva para que el botón existente del frontend no falle.
// En v2.11.0 ya no intenta consultar directamente al TSJE desde Render.
app.get("/api/forzar-actualizacion", (req, res) => {
  actualizarEstadoTemporal();
  res.set("Cache-Control", "no-store");
  res.json({
    ...estadoActual,
    mensaje: "La actualización llega desde el colector TREP"
  });
});

app.get("/api/colector/status", (req, res) => {
  actualizarEstadoTemporal();
  res.set("Cache-Control", "no-store");
  res.json({
    version: VERSION,
    configured: Boolean(COLLECTOR_TOKEN),
    status: estadoActual.status,
    ultimaRecepcion: estadoActual.ultimaRecepcion,
    edadSegundos: estadoActual.edadSegundos,
    corteOficial: estadoActual.corteOficial || null
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TREP Monitor v${VERSION} activo en puerto ${PORT}`);
  console.log(
    `[${VERSION}] MODO COLECTOR | token=${COLLECTOR_TOKEN ? "CONFIGURADO" : "FALTA CONFIGURAR"}`
  );
});
