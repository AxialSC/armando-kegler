const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const URL_INTENDENTE = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=1&departamento=7&distrito=53";
const URL_CONCEJALES = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=2&departamento=7&distrito=53";

// Caché para protegerse de los errores 503 del TSJE
let ultimaDataValida = null;

async function fetchConReintento(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
  };

  const res = await fetch(`${url}&_=${Date.now()}`, { headers });
  if (!res.ok) throw new Error(`TSJE respondió con código ${res.status}`);
  return await res.json();
}

app.get('/api/resultados', async (req, res) => {
  try {
    const [dataIntendente, dataConcejal] = await Promise.all([
      fetchConReintento(URL_INTENDENTE),
      fetchConReintento(URL_CONCEJALES)
    ]);

    // 1. Datos Intendente
    const lista1Intendente = dataIntendente.candidatos?.find(c => c.numLista === "1" || c.numLista == 1) || {};
    const lista9Intendente = dataIntendente.candidatos?.find(c => c.numLista === "9" || c.numLista == 9) || {};
    const totalVotosInt = dataIntendente.totales?.totalVotos || 1;

    // 2. Datos Concejal - Lista 9 y Armando Kegler
    const lista9Concejal = dataConcejal.candidatos?.find(c => c.numLista === "9" || c.numLista == 9) || {};
    const lista1Concejal = dataConcejal.candidatos?.find(c => c.numLista === "1" || c.numLista == 1) || {};

    // Buscar a Armando Kegler en candidatosPref
    let armandoKegler = null;
    if (Array.isArray(lista9Concejal.candidatosPref)) {
      armandoKegler = lista9Concejal.candidatosPref.find(p => 
        (p.nomCandidato && p.nomCandidato.toUpperCase().includes("KEGLER")) || p.orden === 4 || p.orden === "4"
      );
    }

    const resultado = {
      ok: true,
      servidorHora: dataIntendente.horaFormated || dataConcejal.horaFormated,
      mesas: {
        total: dataIntendente.totales?.totalMesas || 71,
        procesadas: dataIntendente.totales?.mesasPublicadas || 0,
        porcentaje: ((dataIntendente.totales?.mesasPublicadas / dataIntendente.totales?.totalMesas) * 100).toFixed(2) + "%",
        totalVotos: dataIntendente.totales?.totalVotos || 0
      },
      intendente: {
        lista9: {
          nombre: lista9Intendente.nomCandidato || "CONCEPCION MARTINEZ CRISTALDO",
          partido: lista9Intendente.desPartido || "PARTIDO ENCUENTRO NACIONAL",
          votos: lista9Intendente.votos || 0,
          porcentaje: ((lista9Intendente.votos / totalVotosInt) * 100).toFixed(2) + "%"
        },
        lista1: {
          nombre: lista1Intendente.nomCandidato || "HERNAN YSIDRO RIVAS ROMAN",
          partido: lista1Intendente.desPartido || "PARTIDO COLORADO",
          votos: lista1Intendente.votos || 0,
          porcentaje: ((lista1Intendente.votos / totalVotosInt) * 100).toFixed(2) + "%"
        }
      },
      concejal: {
        armandoKegler: {
          nombre: armandoKegler?.nomCandidato || "ARMANDO KEGLER SAUCEDO",
          orden: armandoKegler?.orden || 4,
          votosPreferenciales: armandoKegler?.votos || armandoKegler?.pref || 0,
          totalLista9Concejales: lista9Concejal.votos || 0
        },
        lista1Votos: lista1Concejal.votos || 0,
        lista9Votos: lista9Concejal.votos || 0
      }
    };

    ultimaDataValida = resultado;
    res.json(resultado);

  } catch (error) {
    console.error("Aviso TREP:", error.message);
    if (ultimaDataValida) {
      // Si el TREP da 503, devolvemos el último dato que teníamos
      return res.json({ ...ultimaDataValida, advertencia: "Usando último dato guardado (el TREP no respondió momentáneamente)" });
    }
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor en ejecución en: http://localhost:${PORT}`);
});