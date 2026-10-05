const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// Inicia en 2 (exactamente lo que tiene GoatCounter en tu captura)
let contadorVisitasReales = 2;

// FILTRO ESTRICTO: Solo suma si una persona real abre la página principal
// (Ignora las consultas automáticas de cada 10 segundos del panel)
app.use((req, res, next) => {
  const esPaginaPrincipal = (req.path === '/' || req.path === '/index.html');
  const esConsultaInterna = req.xhr || req.headers['accept']?.includes('application/json');

  if (esPaginaPrincipal && !esConsultaInterna) {
    contadorVisitasReales++;
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const URL_INTENDENTE = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=1&departamento=7&distrito=53";
const URL_CONCEJALES = "https://resultados.tsje.gov.py/publicacion/divulgacion.ajax.php?codeleccion=47&candidatura=2&departamento=7&distrito=53";

let estadoActual = {
  ok: true,
  visitasWeb: contadorVisitasReales,
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

app.get('/api/resultados', (req, res) => {
  // Entrega el valor real SIN sumar nada
  estadoActual.visitasWeb = contadorVisitasReales;
  res.json(estadoActual);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en ${PORT}`));