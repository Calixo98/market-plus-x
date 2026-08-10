// Recupera las fotos del catalogo RC Crawlers de la rama feature/racing (nunca
// publicada) y las convierte a WebP para el catalogo nuevo (SKUs distintos,
// mismos productos fisicos en la mayoria de los casos).
//
// No hay npm deps (regla del repo): usa solo Node builtins + ffmpeg como
// proceso externo (ya viene instalado en esta maquina via winget).
//
// Uso: node scripts/rc-imagenes.js
// Fuente: <repo>/../rc-old-photos-export (extraido a mano de feature/racing con
//   `git show feature/racing:assets/racing/<SKU>/<archivo> > destino`)
// Destino: assets/rc/{SKU_NUEVO}/{card,01-hero,02..06}.webp

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FFMPEG = 'C:\\Users\\ivanp\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe';
const SRC_DIR = 'C:\\Users\\ivanp\\AppData\\Local\\Temp\\claude\\C--Users-ivanp-OneDrive-Documentos-MArkeplus\\906f2632-2863-493c-bf74-7fa9d96cae17\\scratchpad\\rc-old-photos';
const OUT_DIR = path.join(__dirname, '..', 'assets', 'rc');

// SKU nuevo -> carpeta vieja de origen (mismas piezas fisicas, distinto SKU).
// El valor null en carpetaVieja significa "sin fotos recuperables" — se
// reporta al final, nunca se inventa ni se reusa una foto de otro color.
const MAPA = [
  { skuNuevo: 'MPX-RC-P12-ROJ',  carpetaVieja: 'MPX-RC-P12-82R' },
  { skuNuevo: 'MPX-RC-P12-AMA',  carpetaVieja: 'MPX-RC-P12-82SF' },
  { skuNuevo: 'MPX-RC-M10-CAB',  carpetaVieja: 'MPX-RC-W10-BEA' },
  { skuNuevo: 'MPX-RC-C12-128',  carpetaVieja: 'MPX-RC-P12-128' },
  { skuNuevo: 'MPX-RC-M10-LON',  carpetaVieja: 'MPX-RC-W10-TOY' },
  { skuNuevo: 'MPX-RC-T12-99S',  carpetaVieja: 'MPX-RC-P12-99S' },
  { skuNuevo: 'MPX-RC-P12-PRO',  carpetaVieja: 'MPX-RC-P12-82PRO' },
  { skuNuevo: 'MPX-RC-M10-BEI',  carpetaVieja: 'MPX-RC-W10-KOD' },
  { skuNuevo: 'MPX-RC-M10-GRI',  carpetaVieja: null }, // variante "gris" del D888 — sin fotos guardadas localmente
  { skuNuevo: 'MPX-RC-P12-82S',  carpetaVieja: 'MPX-RC-P12-82S' }, // vendido — se publica igual
  { skuNuevo: 'MPX-RC-M10-VER',  carpetaVieja: 'MPX-RC-W10-YIK' }, // mostrador
  // La grua (P12-GRU) es un caso especial: la carpeta vieja 82T tenia la
  // variante ROJA del listado del proveedor (referencia MN82T), pero el
  // catalogo nuevo pide la AMARILLA del MISMO listado. Se reusan las fotos
  // de contexto (dimensiones,
  // control, etc.) de 82T, pero el hero/card se reemplaza por la foto amarilla
  // real extraida del mismo HTML de Amazon guardado (ver AMARILLO-GRUA/).
  { skuNuevo: 'MPX-RC-P12-GRU',  carpetaVieja: 'MPX-RC-P12-82T', heroOverride: 'AMARILLO-GRUA/hero.jpg' },
];

const TAMANOS = { card: 600, '01-hero': 1200 };
const TAMANO_GALERIA = 800;

function convertir(origen, destino, ancho) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-i', origen, '-vf', `scale=${ancho}:-1`, '-q:v', '82', destino], { stdio: 'pipe' });
}

function procesarSku({ skuNuevo, carpetaVieja, heroOverride }) {
  if (!carpetaVieja) {
    console.log(`SIN FOTOS: ${skuNuevo} — no hay fuente local, se omite (no se inventa ni se reusa otro color).`);
    return { sku: skuNuevo, imagenes: null };
  }

  const dirOrigen = path.join(SRC_DIR, carpetaVieja);
  const dirDestino = path.join(OUT_DIR, skuNuevo);
  const galeria = [];

  // card.jpg y 01-hero.jpg (o el reemplazo de color si aplica)
  for (const nombre of ['card', '01-hero']) {
    const usaOverride = heroOverride && nombre === '01-hero';
    const origen = usaOverride ? path.join(SRC_DIR, heroOverride) : path.join(dirOrigen, `${nombre}.jpg`);
    const destino = path.join(dirDestino, `${nombre}.webp`);
    convertir(origen, destino, TAMANOS[nombre]);
    if (nombre === 'card' && heroOverride) {
      // El card tambien debe ser amarillo: se regenera desde el mismo override, a 600px.
      convertir(path.join(SRC_DIR, heroOverride), destino, TAMANOS.card);
    }
  }

  // Galeria 02..06 — fotos de contexto (control, dimensiones, accesorios), no
  // cambian de color entre variantes del mismo listado salvo la principal.
  for (let i = 2; i <= 6; i++) {
    const n = String(i).padStart(2, '0');
    const origen = path.join(dirOrigen, `${n}.jpg`);
    if (!fs.existsSync(origen)) continue;
    const destino = path.join(dirDestino, `${n}.webp`);
    convertir(origen, destino, TAMANO_GALERIA);
    galeria.push(`assets/rc/${skuNuevo}/${n}.webp`);
  }

  console.log(`OK: ${skuNuevo}  <-  ${carpetaVieja}${heroOverride ? '  (hero/card reemplazados: ' + heroOverride + ')' : ''}`);
  return {
    sku: skuNuevo,
    imagenes: {
      card: `assets/rc/${skuNuevo}/card.webp`,
      hero: `assets/rc/${skuNuevo}/01-hero.webp`,
      galeria,
    },
  };
}

const resultados = MAPA.map(procesarSku);
fs.writeFileSync(
  path.join(__dirname, 'rc-imagenes-resultado.json'),
  JSON.stringify(resultados, null, 2) + '\n'
);
console.log('\nResultado escrito en scripts/rc-imagenes-resultado.json');
