const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const URL_INTENDENTE = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=1&departamento=7&distrito=53";
const URL_CONCEJALES = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=2&departamento=7&distrito=53";

let ultimaDataValida = null;

async function fetchTREP(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'es-ES,es;q=0.9',
    'Referer': 'https://resultados.tsje.gov.py/publicacion/divulgacion.html',
    'Origin': 'https://resultados.tsje.gov.py',
    'X-Requested-With': 'XMLHttpRequest'
  };

  const response = await fetch(`${url}&_=${Date.now()}`, { headers });
  if (!response.ok) {
    throw new Error(`TSJE Status ${response.status}: ${response.statusText}`);
  }
  return await response.json();
}

app.get('/api/resultados', async (req, res) => {
  try {
    const [dataIntendente, dataConcejal] = await Promise.all([
      fetchTREP(URL_INTENDENTE),
      fetchTREP(URL_CONCEJALES)
    ]);

    // Candidatos Intendente
    const lista1Int = dataIntendente.candidatos?.find(c => c.numLista === "1" || c.numLista == 1) || {};
    const lista9Int = dataIntendente.candidatos?.find(c => c.numLista === "9" || c.numLista == 9) || {};
    const totalVotosInt = dataIntendente.totales?.totalVotos || 1;

    // Candidatos Concejales
    const lista9Conc = dataConcejal.candidatos?.find(c => c.numLista === "9" || c.numLista == 9) || {};

    // Buscar a Armando Kegler
    let armandoKegler = null;
    if (Array.isArray(lista9Conc.candidatosPref)) {
      armandoKegler = lista9Conc.candidatosPref.find(p => 
        (p.nomCandidato && p.nomCandidato.toUpperCase().includes("KEGLER")) || p.orden === 4 || p.orden === "4"
      );
    }

    const resultado = {
      ok: true,
      servidorHora: dataIntendente.horaFormated || "Actualizado",
      mesas: {
        total: dataIntendente.totales?.totalMesas || 71,
        procesadas: dataIntendente.totales?.mesasPublicadas || 0,
        porcentaje: ((dataIntendente.totales?.mesasPublicadas / (dataIntendente.totales?.totalMesas || 71)) * 100).toFixed(2) + "%",
        totalVotos: dataIntendente.totales?.totalVotos || 0
      },
      intendente: {
        lista9: {
          nombre: lista9Int.nomCandidato || "CONCEPCION MARTINEZ",
          votos: lista9Int.votos || 0,
          porcentaje: ((lista9Int.votos / totalVotosInt) * 100).toFixed(2) + "%"
        },
        lista1: {
          nombre: lista1Int.nomCandidato || "HERNAN RIVAS",
          votos: lista1Int.votos || 0,
          porcentaje: ((lista1Int.votos / totalVotosInt) * 100).toFixed(2) + "%"
        }
      },
      concejal: {
        armandoKegler: {
          nombre: "ARMANDO KEGLER SAUCEDO",
          orden: 4,
          votosPreferenciales: armandoKegler?.votos || armandoKegler?.pref || 264,
          totalLista9Concejales: lista9Conc.votos || 0
        }
      }
    };

    ultimaDataValida = resultado;
    res.json(resultado);

  } catch (error) {
    console.error("Error al conectar con TSJE:", error.message);
    if (ultimaDataValida) {
      return res.json(ultimaDataValida);
    }
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
