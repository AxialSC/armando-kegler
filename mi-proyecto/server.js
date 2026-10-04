const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const URL_INTENDENTE = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=1&departamento=7&distrito=53";
const URL_CONCEJALES = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=2&departamento=7&distrito=53";

// Datos base oficiales (para que nunca aparezca en 0 si el TREP satura)
let ultimaDataValida = {
  ok: true,
  servidorHora: "04-10-2026 18:40:02",
  mesas: {
    total: 71,
    procesadas: 69,
    porcentaje: "97.18%",
    totalVotos: 11512
  },
  intendente: {
    lista9: {
      nombre: "CONCEPCION MARTINEZ",
      votos: 6407,
      porcentaje: "58.56%"
    },
    lista1: {
      nombre: "HERNAN RIVAS",
      votos: 4152,
      porcentaje: "37.95%"
    }
  },
  concejal: {
    armandoKegler: {
      nombre: "ARMANDO KEGLER SAUCEDO",
      orden: 4,
      votosPreferenciales: 264,
      totalLista9Concejales: 3840
    }
  }
};

async function fetchTREP(url) {
  // Cabeceras idénticas a las del navegador para evitar el error 403
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'es-PY,es;q=0.9,en;q=0.8',
    'Referer': 'https://resultados.tsje.gov.py/publicacion/divulgacion.html',
    'Origin': 'https://resultados.tsje.gov.py',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  };

  const response = await fetch(`${url}&_=${Date.now()}`, { headers });
  if (!response.ok) {
    throw new Error(`TSJE Status ${response.status}`);
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
    const l1Int = dataIntendente.candidatos?.find(c => c.numLista === "1" || c.numLista == 1) || {};
    const l9Int = dataIntendente.candidatos?.find(c => c.numLista === "9" || c.numLista == 9) || {};
    const totalInt = dataIntendente.totales?.totalVotos || 1;

    // Concejales
    const l9Conc = dataConcejal.candidatos?.find(c => c.numLista === "9" || c.numLista == 9) || {};
    let kegler = null;
    if (Array.isArray(l9Conc.candidatosPref)) {
      kegler = l9Conc.candidatosPref.find(p => 
        (p.nomCandidato && p.nomCandidato.toUpperCase().includes("KEGLER")) || p.orden === 4 || p.orden === "4"
      );
    }

    ultimaDataValida = {
      ok: true,
      servidorHora: dataIntendente.horaFormated || ultimaDataValida.servidorHora,
      mesas: {
        total: dataIntendente.totales?.totalMesas || 71,
        procesadas: dataIntendente.totales?.mesasPublicadas || ultimaDataValida.mesas.procesadas,
        porcentaje: ((dataIntendente.totales?.mesasPublicadas / (dataIntendente.totales?.totalMesas || 71)) * 100).toFixed(2) + "%",
        totalVotos: dataIntendente.totales?.totalVotos || ultimaDataValida.mesas.totalVotos
      },
      intendente: {
        lista9: {
          nombre: l9Int.nomCandidato || "CONCEPCION MARTINEZ",
          votos: l9Int.votos || ultimaDataValida.intendente.lista9.votos,
          porcentaje: (( (l9Int.votos || ultimaDataValida.intendente.lista9.votos) / totalInt) * 100).toFixed(2) + "%"
        },
        lista1: {
          nombre: l1Int.nomCandidato || "HERNAN RIVAS",
          votos: l1Int.votos || ultimaDataValida.intendente.lista1.votos,
          porcentaje: (( (l1Int.votos || ultimaDataValida.intendente.lista1.votos) / totalInt) * 100).toFixed(2) + "%"
        }
      },
      concejal: {
        armandoKegler: {
          nombre: "ARMANDO KEGLER SAUCEDO",
          orden: 4,
          votosPreferenciales: kegler?.votos || kegler?.pref || ultimaDataValida.concejal.armandoKegler.votosPreferenciales,
          totalLista9Concejales: l9Conc.votos || ultimaDataValida.concejal.armandoKegler.totalLista9Concejales
        }
      }
    };

    res.json(ultimaDataValida);
  } catch (error) {
    console.warn("TSJE ocupado o bloqueado, entregando último dato:", error.message);
    res.json(ultimaDataValida);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});