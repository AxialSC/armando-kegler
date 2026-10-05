const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const URL_INTENDENTE = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=1&departamento=7&distrito=53";
const URL_CONCEJALES = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=2&departamento=7&distrito=53";

// Corte oficial de las 21:48:02
let estadoActual = {
  ok: true,
  servidorHora: "04-10-2026 21:48:02",
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

async function consultarTSJE(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': 'https://resultados.tsje.gov.py/publicacion/divulgacion.html',
    'X-Requested-With': 'XMLHttpRequest'
  };
  try {
    const res = await fetch(`${url}&_=${Date.now()}`, { headers });
    if (res.ok) return await res.json();
  } catch (e) {}
  return null;
}

app.get('/api/resultados', async (req, res) => {
  const [dataInt, dataConc] = await Promise.all([
    consultarTSJE(URL_INTENDENTE),
    consultarTSJE(URL_CONCEJALES)
  ]);

  if (dataInt && dataInt.candidatos) {
    const l1 = dataInt.candidatos.find(c => c.numLista == 1);
    const l9 = dataInt.candidatos.find(c => c.numLista == 9);
    const tot = dataInt.totales?.totalVotos || 11871;
    if (l1?.votos) {
      estadoActual.intendente.lista1.votos = Number(l1.votos);
      estadoActual.intendente.lista1.porcentaje = ((l1.votos / tot) * 100).toFixed(2) + "%";
    }
    if (l9?.votos) {
      estadoActual.intendente.lista9.votos = Number(l9.votos);
      estadoActual.intendente.lista9.porcentaje = ((l9.votos / tot) * 100).toFixed(2) + "%";
    }
    if (dataInt.horaFormated) estadoActual.servidorHora = dataInt.horaFormated;
  }

  if (dataConc && dataConc.candidatos) {
    const l9c = dataConc.candidatos.find(c => c.numLista == 9);
    if (l9c?.candidatosPref) {
      const keg = l9c.candidatosPref.find(p => (p.nomCandidato && p.nomCandidato.includes("KEGLER")) || p.orden == 4);
      if (keg?.votos || keg?.pref) {
        estadoActual.concejal.armandoKegler.votosPreferenciales = Number(keg.votos || keg.pref);
      }
    }
    if (dataConc.horaFormated) estadoActual.servidorHora = dataConc.horaFormated;
  }

  res.json(estadoActual);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en ${PORT}`));