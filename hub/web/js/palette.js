// Drawing colours for the analyser (canvas and SVG exports), mirroring the app's CSS tokens.
// Series colours are a validated categorical set (lightness band, chroma, CVD separation and
// contrast checked for each surface).

export const PALETTES = {
  dark: {
    name: 'dark',
    bg: '#041113',
    surface: '#0a1a1d',
    surface2: '#0f2428',
    text: '#eef6f4',
    text2: '#9cb9b6',
    text3: '#5e7d7a',
    grid: 'rgba(156, 205, 200, 0.12)',
    axis: 'rgba(156, 205, 200, 0.28)',
    halo: 'rgba(4, 17, 19, 0.78)',
    brand1: '#f2685a',
    brand2: '#ff8a6b',
    brand3: '#ffbb8f',
    onBrand: '#2a0f0b',
    vessel: '#eef6f4',
    trail: '#2dd4bf',
    mark: '#5eead4',
    selection: 'rgba(255, 138, 107, 0.14)',
    selectionEdge: 'rgba(255, 138, 107, 0.7)',
    series: ['#1aa898', '#e8664f', '#9a7df2'],
    // Sequential (speed): one hue, dim -> bright on the dark canvas.
    ramp: ['#134e4a', '#115e59', '#0f766e', '#0d9488', '#14b8a6', '#2dd4bf', '#5eead4', '#99f6e4'],
  },
  light: {
    name: 'light',
    bg: '#f1f7f6',
    surface: '#ffffff',
    surface2: '#e3f0ee',
    text: '#072226',
    text2: '#3f5e5d',
    text3: '#86a19f',
    grid: 'rgba(63, 94, 93, 0.13)',
    axis: 'rgba(63, 94, 93, 0.35)',
    halo: 'rgba(255, 255, 255, 0.85)',
    brand1: '#c2412f',
    brand2: '#e0573f',
    brand3: '#f08a6b',
    onBrand: '#ffffff',
    vessel: '#072226',
    trail: '#0f766e',
    mark: '#0e7490',
    selection: 'rgba(194, 65, 47, 0.10)',
    selectionEdge: 'rgba(194, 65, 47, 0.65)',
    series: ['#0b8f80', '#c2412f', '#7c3aed'],
    ramp: ['#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59', '#134e4a'],
  },
};

export function currentTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const FONT_BODY = "'Plus Jakarta Sans', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";
export const FONT_DISPLAY = "'Sora', 'Segoe UI', system-ui, -apple-system, sans-serif";
