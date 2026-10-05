const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

const VERSION = "2.12.10";
const LIVE_MS = 120_000; // LIVE mientras el último envío tenga menos de 2 minutos
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const GOATCOUNTER_ACCESS_TOKEN = process.env.GOATCOUNTER_ACCESS_TOKEN || "";

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

function extraerCorte(...fuentes) {
  for (const data of fuentes) {
    if (!data || typeof data !== "object") continue;
    for (const clave of ["horaFormateada", "hora_formateada", "fechaHora", "fecha_hora"]) {
      const valor = data[clave];
      if (typeof valor === "string" && valor.trim()) return valor.trim();
    }
    if (data.hora && typeof data.hora === "object") {
      const vals = Object.values(data.hora).filter(v => typeof v === "string" || typeof v === "number");
      const texto = vals.join(" ").trim();
      if (/\d{2}:\d{2}/.test(texto)) return texto;
    }
  }
  return null;
}

function calcularBancasDHondt(listas, cantidadBancas = 12) {
  const cocientes = [];
  for (const lista of listas) {
    const votos = Number(lista?.votos);
    if (!Number.isFinite(votos) || votos < 0) continue;
    for (let divisor = 1; divisor <= cantidadBancas; divisor++) {
      cocientes.push({
        numLista: String(lista.numLista),
        desPartido: lista.desPartido || "",
        votosLista: votos,
        divisor,
        cociente: votos / divisor
      });
    }
  }
  cocientes.sort((a, b) =>
    b.cociente - a.cociente ||
    b.votosLista - a.votosLista ||
    Number(a.numLista) - Number(b.numLista)
  );
  const ganadores = cocientes.slice(0, cantidadBancas);
  const bancas = {};
  for (const g of ganadores) bancas[g.numLista] = (bancas[g.numLista] || 0) + 1;
  return { bancas, cocientesGanadores: ganadores };
}

function construirElectos(listas, bancas) {
  const electos = [];
  for (const lista of listas) {
    const numLista = String(lista?.numLista ?? "");
    const cantidad = Number(bancas[numLista] || 0);
    const pref = Array.isArray(lista?.candidatosPref) ? [...lista.candidatosPref] : [];
    pref.sort((a, b) =>
      Number(b?.votos || 0) - Number(a?.votos || 0) ||
      Number(a?.ordCandidato || 9999) - Number(b?.ordCandidato || 9999)
    );
    pref.slice(0, cantidad).forEach(c => {
      electos.push({
        numLista,
        lista: `Lista ${numLista}`,
        partido: lista.desPartido || c.desPartido || "",
        nombre: String(c.nomCandidato || "").trim(),
        votosPreferenciales: Number(c.votos || 0),
        opcion: Number(c.ordCandidato || 0)
      });
    });
  }
  electos.sort((a, b) =>
    b.votosPreferenciales - a.votosPreferenciales ||
    Number(a.numLista) - Number(b.numLista) ||
    a.opcion - b.opcion
  );
  return electos.map((c, i) => ({ puesto: i + 1, ...c }));
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
      totalLista9Concejales: 2896
    }
  },
  concejales: {
    metodo: "D'Hondt + voto preferencial",
    bancasTotales: 12,
    bancas: {},
    electos: []
  }
};

let firmaUltimosDatos = null;
let ultimaRecepcionMs = null;

// Contador local de respaldo para el panel. GoatCounter sigue siendo la fuente principal.
// Este contador se reinicia si Render reinicia el proceso.
let visitasLocales = 0;

function parsearCarga(body) {
  const intData = body?.intendente;
  const conData = body?.concejales;

  if (!intData || !conData) {
    throw new Error("La carga debe incluir 'intendente' y 'concejales'");
  }

  const martinez = buscarCandidato(intData, ["CONCEPCION", "MARTINEZ"]);
  const rivas = buscarCandidato(intData, ["HERNAN", "RIVAS"]);

  const listasConcejales = Array.isArray(conData?.candidatos) ? conData.candidatos : [];
  const lista9 = listasConcejales.find(x => String(x?.numLista) === "9");
  const preferenciasLista9 = Array.isArray(lista9?.candidatosPref) ? lista9.candidatosPref : [];
  const kegler = preferenciasLista9.find(c =>
    normalizar(c?.nomCandidato).includes("ARMANDO") &&
    normalizar(c?.nomCandidato).includes("KEGLER")
  );

  if (!martinez || !rivas || !lista9 || !kegler) {
    throw new Error("Faltan datos esperados de intendente o preferencias de Lista 9");
  }

  const vm = Number(martinez.votos);
  const vr = Number(rivas.votos);
  const vk = Number(kegler.votos);
  const totalLista9 = Number(lista9.votos);

  const { bancas } = calcularBancasDHondt(listasConcejales, 12);
  const electos = construirElectos(listasConcejales, bancas);

  const totales = intData.totales || {};
  const totalVotos = Number(totales.totalVotos);
  const totalMesas = Number(totales.totalMesas);
  const mesasPublicadas = Number(totales.mesasPublicadas);

  if (![vm, vr, vk, totalLista9].every(esEnteroNoNegativo)) {
    throw new Error("Los votos recibidos no son válidos");
  }
  if (!esEnteroNoNegativo(totalVotos) ||
      !esEnteroNoNegativo(totalMesas) ||
      !esEnteroNoNegativo(mesasPublicadas) ||
      mesasPublicadas > totalMesas) {
    throw new Error("Los totales/mesas recibidos no son válidos");
  }

  return {
    corteOficial: extraerCorte(intData, conData),
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
        totalLista9Concejales: totalLista9
      }
    },
    concejales: {
      metodo: "D'Hondt + voto preferencial",
      bancasTotales: 12,
      bancas,
      electos
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
      concejales: datos.concejales,
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


app.post("/api/visita", (req, res) => {
  visitasLocales += 1;
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, visitasLocales });
});

app.get("/api/visitas", async (req, res) => {
  res.set("Cache-Control", "no-store");

  // 1) Preferido: dashboard privado de GoatCounter usando el secret access token.
  // GoatCounter puede entregar una cookie de sesión y redirigir; Node fetch no
  // conserva cookies automáticamente entre requests, por eso hacemos 2 pasos.
  if (GOATCOUNTER_ACCESS_TOKEN) {
    try {
      const accessUrl =
        "https://armando-kegler.goatcounter.com/?access-token=" +
        encodeURIComponent(GOATCOUNTER_ACCESS_TOKEN);

      const c1 = new AbortController();
      const t1 = setTimeout(() => c1.abort(), 6000);

      const first = await fetch(accessUrl, {
        signal: c1.signal,
        redirect: "manual",
        cache: "no-store",
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 AXIAL-TREP/2.12.10"
        }
      });
      clearTimeout(t1);

      let setCookies = [];
      if (typeof first.headers.getSetCookie === "function") {
        setCookies = first.headers.getSetCookie();
      } else {
        const sc = first.headers.get("set-cookie");
        if (sc) setCookies = [sc];
      }

      const cookieHeader = setCookies
        .map(v => String(v).split(";")[0])
        .filter(Boolean)
        .join("; ");

      let dashboardResponse = first;

      // Si GoatCounter redirige o entrega cookie, hacemos el segundo request ya autenticado.
      if (first.status >= 300 && first.status < 400 || cookieHeader) {
        const location = first.headers.get("location");
        const target = location
          ? new URL(location, "https://armando-kegler.goatcounter.com/").toString()
          : "https://armando-kegler.goatcounter.com/";

        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 6000);

        dashboardResponse = await fetch(target, {
          signal: c2.signal,
          redirect: "follow",
          cache: "no-store",
          headers: {
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "Mozilla/5.0 AXIAL-TREP/2.12.10",
            ...(cookieHeader ? { "Cookie": cookieHeader } : {})
          }
        });
        clearTimeout(t2);
      }

      if (dashboardResponse.ok) {
        const html = await dashboardResponse.text();

        const plain = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/\s+/g, " ")
          .trim();

        const candidatos = [];

        for (const m of plain.matchAll(/([\d][\d.,]*)\s+out\s+of\s+([\d][\d.,]*)\s+visits\s+shown/gi)) {
          candidatos.push(Number(String(m[2]).replace(/[.,]/g, "")));
        }

        for (const m of plain.matchAll(/Totals?.{0,100}?([\d][\d.,]*)\s+visits\b/gi)) {
          candidatos.push(Number(String(m[1]).replace(/[.,]/g, "")));
        }

        for (const m of plain.matchAll(/([\d][\d.,]*)\s+visits\b/gi)) {
          candidatos.push(Number(String(m[1]).replace(/[.,]/g, "")));
        }

        const valores = candidatos.filter(v => Number.isFinite(v) && v >= 0);

        if (valores.length) {
          const count = Math.max(...valores);
          console.log(`[${VERSION}] GOATCOUNTER privado total=${count}`);
          return res.json({
            ok: true,
            count,
            source: "GOATCOUNTER_PRIVATE",
            localFallback: visitasLocales
          });
        }

        console.warn(`[${VERSION}] GOATCOUNTER privado: dashboard accesible pero no se encontró total`);
      }
    } catch (err) {
      console.warn(`[${VERSION}] GOATCOUNTER privado no disponible: ${err.message}`);
    }
  }

  // 2) Respaldo: contador público de GoatCounter.
  const urls = [
    "https://armando-kegler.goatcounter.com/counter/%2F.json",
    "https://armando-kegler.goatcounter.com/counter//.json",
    "https://armando-kegler.goatcounter.com/counter/TOTAL.json"
  ];

  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      const r = await fetch(url + "?t=" + Date.now(), {
        signal: controller.signal,
        cache: "no-store",
        headers: { "Accept": "application/json,text/plain,*/*" }
      });

      if (r.ok) {
        const j = await r.json();
        const count = Number(j?.count);

        if (Number.isFinite(count)) {
          return res.json({
            ok: true,
            count,
            source: "GOATCOUNTER_PUBLIC",
            localFallback: visitasLocales
          });
        }
      }
    } catch (_) {
    } finally {
      clearTimeout(timeout);
    }
  }

  // 3) Último respaldo: contador local de Render.
  res.json({
    ok: true,
    count: visitasLocales,
    source: "LOCAL_RENDER",
    note: "Respaldo local: se reinicia si Render reinicia el proceso"
  });
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
    goatcounterConfigured: Boolean(GOATCOUNTER_ACCESS_TOKEN),
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
