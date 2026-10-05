const express = require("express");
const cors = require("cors");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const VERSION = "2.10.2";
const POLL_MS = 60_000;

const URL_INTENDENTE =
  "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=1&departamento=7&distrito=53";
const URL_CONCEJALES =
  "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=2&departamento=7&distrito=53";

// Último dato confirmado conocido. Se usa solamente como respaldo y queda
// explícitamente marcado como "stale" si TREP no puede ser leído.
let estadoActual = {
  ok: false,
  version: VERSION,
  source: "TREP / TSJE Paraguay",
  status: "STARTING",
  stale: true,
  servidorHora: null,
  ultimaConsulta: null,
  ultimoCambio: null,
  error: null,
  mesas: {
    total: 71,
    procesadas: 71,
    porcentaje: "100.00%",
    totalVotos: 11871
  },
  intendente: {
    lista9: { nombre: "CONCEPCION MARTINEZ", votos: 6919, porcentaje: "58.28%" },
    lista1: { nombre: "HERNAN RIVAS", votos: 4535, porcentaje: "38.20%" }
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
let consultaEnCurso = false;

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

function numero(texto) {
  if (texto == null) return null;
  const limpio = String(texto).replace(/\./g, "").replace(/[^\d-]/g, "");
  if (!limpio || limpio === "-") return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

function porcentaje(texto) {
  const m = String(texto || "").match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
  return m ? m[1].replace(",", ".") + "%" : null;
}

function textoPlano(html) {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  return $.text().replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim();
}

function extraerNumeroCercano(texto, nombre, max = 180) {
  const upper = texto.toUpperCase();
  const pos = upper.indexOf(nombre.toUpperCase());
  if (pos < 0) return null;
  const zona = texto.slice(pos, pos + max);
  const nums = [...zona.matchAll(/\b\d{1,3}(?:\.\d{3})+\b|\b\d{2,6}\b/g)]
    .map(m => numero(m[0]))
    .filter(n => Number.isFinite(n));
  return nums.length ? nums[0] : null;
}

function extraerPorcentajeCercano(texto, nombre, max = 220) {
  const upper = texto.toUpperCase();
  const pos = upper.indexOf(nombre.toUpperCase());
  if (pos < 0) return null;
  return porcentaje(texto.slice(pos, pos + max));
}

function extraerMesas(texto) {
  const patrones = [
    /MESAS\s+(?:PROCESADAS|COMPUTADAS|TRANSMITIDAS)[^\d]{0,30}(\d+)\s*(?:\/|DE)\s*(\d+)/i,
    /(\d+)\s*(?:\/|DE)\s*(\d+)[^\n]{0,40}MESAS/i
  ];
  for (const re of patrones) {
    const m = texto.match(re);
    if (m) {
      const procesadas = Number(m[1]);
      const total = Number(m[2]);
      return {
        procesadas,
        total,
        porcentaje: total ? ((procesadas / total) * 100).toFixed(2) + "%" : null
      };
    }
  }
  return null;
}

async function descargar(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 TREP-Monitor-Axial/2.10.2",
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache"
      }
    });
    if (!res.ok) throw new Error(`TREP respondió HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parsearTREP(htmlIntendente, htmlConcejales) {
  const tInt = textoPlano(htmlIntendente);
  const tCon = textoPlano(htmlConcejales);

  // Verificación estricta: si no aparecen candidatos conocidos, NO declaramos
  // la consulta como válida. Así evitamos publicar números equivocados.
  const tieneMartinez = /CONCEPCION\s+MARTINEZ/i.test(tInt);
  const tieneRivas = /HERNAN\s+RIVAS/i.test(tInt);
  const tieneKegler = /ARMANDO\s+KEGLER/i.test(tCon);

  if (!tieneMartinez || !tieneRivas || !tieneKegler) {
    throw new Error("TREP respondió, pero el formato recibido no pudo validarse con seguridad");
  }

  const martinez = extraerNumeroCercano(tInt, "CONCEPCION MARTINEZ");
  const rivas = extraerNumeroCercano(tInt, "HERNAN RIVAS");
  const kegler = extraerNumeroCercano(tCon, "ARMANDO KEGLER");

  if (![martinez, rivas, kegler].every(Number.isFinite)) {
    throw new Error("Se encontró la elección, pero no fue posible extraer los votos con seguridad");
  }

  const mesas = extraerMesas(tInt) || extraerMesas(tCon);
  const totalLista9 =
    extraerNumeroCercano(tCon, "LISTA 9", 300) ??
    estadoActual.concejal.armandoKegler.totalLista9Concejales;

  return {
    mesas: mesas
      ? { ...estadoActual.mesas, ...mesas }
      : estadoActual.mesas,
    intendente: {
      lista9: {
        nombre: "CONCEPCION MARTINEZ",
        votos: martinez,
        porcentaje: extraerPorcentajeCercano(tInt, "CONCEPCION MARTINEZ") || estadoActual.intendente.lista9.porcentaje
      },
      lista1: {
        nombre: "HERNAN RIVAS",
        votos: rivas,
        porcentaje: extraerPorcentajeCercano(tInt, "HERNAN RIVAS") || estadoActual.intendente.lista1.porcentaje
      }
    },
    concejal: {
      armandoKegler: {
        nombre: "ARMANDO KEGLER SAUCEDO",
        orden: 4,
        votosPreferenciales: kegler,
        totalLista9Concejales: totalLista9
      }
    }
  };
}

async function consultarTREP() {
  if (consultaEnCurso) return;
  consultaEnCurso = true;
  const ahora = new Date();

  try {
    const [htmlInt, htmlCon] = await Promise.all([
      descargar(URL_INTENDENTE),
      descargar(URL_CONCEJALES)
    ]);

    const datos = parsearTREP(htmlInt, htmlCon);
    const firma = JSON.stringify(datos);

    if (firma !== firmaUltimosDatos) {
      estadoActual.ultimoCambio = horaParaguay(ahora);
      firmaUltimosDatos = firma;
    }

    estadoActual = {
      ...estadoActual,
      ...datos,
      ok: true,
      version: VERSION,
      source: "TREP / TSJE Paraguay",
      status: "LIVE",
      stale: false,
      servidorHora: horaParaguay(ahora),
      ultimaConsulta: horaParaguay(ahora),
      error: null
    };

    console.log(`[${VERSION}] TREP OK - ${estadoActual.ultimaConsulta}`);
  } catch (err) {
    estadoActual = {
      ...estadoActual,
      ok: false,
      version: VERSION,
      status: "STALE",
      stale: true,
      ultimaConsulta: horaParaguay(ahora),
      error: err?.message || "Error desconocido consultando TREP"
    };
    console.error(`[${VERSION}] TREP ERROR - ${estadoActual.ultimaConsulta}: ${estadoActual.error}`);
  } finally {
    consultaEnCurso = false;
  }
}

app.get("/api/resultados", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.json({
    ...estadoActual,
    proximaConsultaSegundos: Math.ceil(POLL_MS / 1000)
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    service: "TREP Monitor Armando Kegler",
    version: VERSION,
    status: estadoActual.status,
    ultimaConsulta: estadoActual.ultimaConsulta,
    ultimoCambio: estadoActual.ultimoCambio,
    stale: estadoActual.stale,
    error: estadoActual.error
  });
});

app.get("/api/forzar-actualizacion", async (req, res) => {
  await consultarTREP();
  res.json(estadoActual);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TREP Monitor v${VERSION} activo en puerto ${PORT}`);
  consultarTREP();
  setInterval(consultarTREP, POLL_MS);
});
