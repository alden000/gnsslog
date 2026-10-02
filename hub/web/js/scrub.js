// Timeline under the playback controls: speed overview of the whole session, the charts'
// zoom window, the selection (edges draggable) and the playback cursor (drag to scrub).

export class Scrub {
  constructor(canvas, { onSeek, onSelect } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    Object.assign(this, { onSeek, onSelect });
    this.data = null;
    this.cursor = null;
    this.sel = null;
    this.win = null;
    this.pal = null;
    this.dirty = true;
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._bind();
    const loop = () => {
      if (this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  set(patch) {
    Object.assign(this, patch);
    if ('data' in patch) this.profile = null;
    this.dirty = true;
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.profile = null;
    this.dirty = true;
  }

  get pad() {
    return 10;
  }

  tx(t) {
    const d = this.data;
    return this.pad + ((t - d.t0) / (d.t1 - d.t0 || 1)) * (this.w - 2 * this.pad);
  }

  timeAt(x) {
    const d = this.data;
    const f = Math.min(Math.max((x - this.pad) / (this.w - 2 * this.pad), 0), 1);
    return d.t0 + f * (d.t1 - d.t0);
  }

  _bind() {
    const c = this.canvas;
    let mode = null;
    c.addEventListener('pointerdown', (e) => {
      if (!this.data?.n) return;
      c.setPointerCapture(e.pointerId);
      mode = 'seek';
      if (this.sel) {
        const xa = this.tx(this.sel[0]), xb = this.tx(this.sel[1]);
        if (Math.abs(e.offsetX - xa) < 10) mode = 'a';
        else if (Math.abs(e.offsetX - xb) < 10) mode = 'b';
      }
      if (mode === 'seek') this.onSeek?.(this.timeAt(e.offsetX));
    });
    c.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const t = this.timeAt(e.offsetX);
      if (mode === 'seek') this.onSeek?.(t);
      else {
        const [a, b] = this.sel;
        const next = mode === 'a' ? [t, b] : [a, t];
        if (next[0] > next[1]) {
          next.reverse();
          mode = mode === 'a' ? 'b' : 'a';
        }
        this.onSelect?.(next);
      }
    });
    const up = () => (mode = null);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  draw() {
    this.dirty = false;
    const { ctx, pal, data } = this;
    if (!pal) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const y0 = 9, y1 = this.h - 5, H = y1 - y0;
    ctx.fillStyle = pal.surface2;
    ctx.beginPath();
    ctx.roundRect(this.pad - 4, y0, this.w - 2 * this.pad + 8, H, 8);
    ctx.fill();
    if (!data || !data.n) return;

    // Speed profile (max per pixel column).
    if (!this.profile) {
      const cols = Math.max(1, Math.round(this.w - 2 * this.pad));
      const prof = new Float32Array(cols).fill(NaN);
      const sog = data.cols.sog;
      let max = 0.5;
      if (sog) for (let i = 0; i < data.n; i++) {
        const v = sog[i];
        if (!Number.isFinite(v)) continue;
        const k = Math.min(cols - 1, Math.floor(this.tx(data.t[i]) - this.pad));
        if (!(prof[k] >= v)) prof[k] = v;
        if (v > max) max = v;
      }
      this.profile = { prof, max };
    }
    const { prof, max } = this.profile;
    ctx.fillStyle = pal.text3;
    ctx.globalAlpha = 0.45;
    for (let k = 0; k < prof.length; k++) {
      if (!Number.isFinite(prof[k])) continue;
      const hh = Math.max(1, (prof[k] / max) * (H - 8));
      ctx.fillRect(this.pad + k, y1 - 2 - hh, 1, hh);
    }
    ctx.globalAlpha = 1;

    // Charts zoom window.
    if (this.win && (this.win[0] > data.t0 + 1 || this.win[1] < data.t1 - 1)) {
      const a = this.tx(Math.max(this.win[0], data.t0)), b = this.tx(Math.min(this.win[1], data.t1));
      ctx.strokeStyle = pal.text2;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(a, y0 + 1, Math.max(b - a, 1), H - 2);
      ctx.setLineDash([]);
    }

    // Selection with handles.
    if (this.sel) {
      const a = this.tx(this.sel[0]), b = this.tx(this.sel[1]);
      ctx.fillStyle = pal.selection;
      ctx.fillRect(a, y0, b - a, H);
      ctx.fillStyle = pal.selectionEdge;
      for (const x of [a, b]) {
        ctx.fillRect(x - 1, y0, 2, H);
        ctx.beginPath();
        ctx.roundRect(x - 4, y0 + H / 2 - 9, 8, 18, 4);
        ctx.fill();
      }
    }

    // Marks.
    ctx.fillStyle = pal.mark;
    for (const m of data.marks) {
      const x = this.tx(m.t);
      ctx.beginPath();
      ctx.moveTo(x, y0 + 1);
      ctx.lineTo(x + 4, y0 + 6);
      ctx.lineTo(x - 4, y0 + 6);
      ctx.fill();
    }

    // Cursor.
    if (this.cursor !== null) {
      const x = this.tx(this.cursor);
      ctx.fillStyle = pal.brand2;
      ctx.fillRect(x - 1, y0 - 4, 2, H + 8);
      ctx.beginPath();
      ctx.arc(x, y0 - 2, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
