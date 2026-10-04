const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const URL_INTENDENTE = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=1&departamento=7&distrito=53";
const URL_CONCEJALES = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=2&departamento=7&distrito=53";

// Base actualizada con la última captura oficial
let estadoActual = {
  ok: true,
  servidorHora: "En Vivo",
  mesas: {
    total: 71,
    procesadas: 69,
    porcentaje: "97.18%",
    totalVotos: 11512
  },
  intendente: {
    lista9: { nombre: "CONCEPCION MARTINEZ", votos: 6407, porcentaje: "58.56%" },
    lista1: { nombre: "HERNAN RIVAS", votos: 4152, porcentaje: "37.95%" }
  },
  concejal: {
    armandoKegler: {
      nombre: "ARMANDO KEGLER SAUCEDO",
      orden: 4,
      votosPreferenciales: 328, // Último dato registrado
      totalLista9Concejales: 3840
    }
  }
};

// Función con reintentos para no caer en el 503 o 403 del TSJE
async function consultarTSJEConReintento(url, intentos = 3) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': 'https://resultados.tsje.gov.py/publicacion/divulgacion.html',
    'X-Requested-With': 'XMLHttpRequest'
  };

  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(`${url}&_=${Date.now()}`, { headers });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      // Si falla, espera medio segundo y reintenta
      await new Promise(r => setTimeout(r, 600));
    }
  }
  return null;
}

app.get('/api/resultados', async (req, res) => {
  // Consultas en paralelo pero independientes
  const [dataIntendente, dataConcejal] = await Promise.all([
    consultarTSJEConReintento(URL_INTENDENTE),
    consultarTSJEConReintento(URL_CONCEJALES)
  ]);

  // Si respondió Concejales, actualizamos Armando Kegler
  if (dataConcejal && dataConcejal.candidatos) {
    const l9Conc = dataConcejal.candidatos.find(c => c.numLista === "9" || c.numLista == 9);
    if (l9Conc && Array.isArray(l9Conc.candidatosPref)) {
      const kegler = l9Conc.candidatosPref.find(p => 
        (p.nomCandidato && p.nomCandidato.toUpperCase().includes("KEGLER")) || p.orden === 4 || p.orden === "4"
      );
      if (kegler && (kegler.votos || kegler.pref)) {
        estadoActual.concejal.armandoKegler.votosPreferenciales = Number(kegler.votos || kegler.pref);
      }
      if (l9Conc.votos) {
        estadoActual.concejal.armandoKegler.totalLista9Concejales = Number(l9Conc.votos);
      }
    }
    if (dataConcejal.horaFormated) {
      estadoActual.servidorHora = dataConcejal.horaFormated;
    }
  }

  // Si respondió Intendente, actualizamos
  if (dataIntendente && dataIntendente.candidatos) {
    const l1 = dataIntendente.candidatos.find(c => c.numLista === "1" || c.numLista == 1);
    const l9 = dataIntendente.candidatos.find(c => c.numLista === "9" || c.numLista == 9);
    const tot = dataIntendente.totales?.totalVotos || 1;

    if (l1 && l1.votos) {
      estadoActual.intendente.lista1.votos = Number(l1.votos);
      estadoActual.intendente.lista1.porcentaje = ((l1.votos / tot) * 100).toFixed(2) + "%";
    }
    if (l9 && l9.votos) {
      estadoActual.intendente.lista9.votos = Number(l9.votos);
      estadoActual.intendente.lista9.porcentaje = ((l9.votos / tot) * 100).toFixed(2) + "%";
    }
    if (dataIntendente.totales) {
      estadoActual.mesas.procesadas = dataIntendente.totales.mesasPublicadas || estadoActual.mesas.procesadas;
      estadoActual.mesas.total = dataIntendente.totales.totalMesas || estadoActual.mesas.total;
      estadoActual.mesas.porcentaje = ((estadoActual.mesas.procesadas / estadoActual.mesas.total) * 100).toFixed(2) + "%";
      estadoActual.mesas.totalVotos = dataIntendente.totales.totalVotos || estadoActual.mesas.totalVotos;
    }
    if (dataIntendente.horaFormated) {
      estadoActual.servidorHora = dataIntendente.horaFormated;
    }
  }

  res.json(estadoActual);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});