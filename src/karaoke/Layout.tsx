/**
 * The karaoke page's panes, arranged as columns of panes: each column has a width weight and
 * each pane a height weight. Drag a pane by its title bar onto another: onto its top or bottom
 * half to stack it above or below, onto its left or right edge to make a column of its own
 * there. Drag the gaps between columns and between panes to resize them. Every pane stays
 * mounted where it is in the page and is placed absolutely, so moving one doesn't restart it.
 */
import { useRef, useState, type ReactNode } from "react";

export type PaneId = "voices" | "band" | "visual" | "lyrics" | "roll";
export const PANE_IDS: PaneId[] = ["voices", "band", "visual", "lyrics", "roll"];

export interface Layout {
  cols: { w: number; panes: { id: PaneId; h: number }[] }[];
}

export const DEFAULT_LAYOUT: Layout = {
  cols: [
    { w: 2, panes: [{ id: "voices", h: 3 }, { id: "lyrics", h: 1.1 }, { id: "roll", h: 1 }] },
    { w: 1, panes: [{ id: "band", h: 1 }, { id: "visual", h: 1.3 }] },
  ],
};

/** a layout as stored or sent, made whole: each pane once, none unknown, no empty column */
export function normalLayout(l: unknown): Layout {
  const seen = new Set<PaneId>();
  const cols: Layout["cols"] = [];
  const src = (l as Layout | null)?.cols;
  if (Array.isArray(src))
    for (const c of src) {
      const panes = (Array.isArray(c?.panes) ? c.panes : [])
        .filter((p: { id: PaneId; h: number }) => PANE_IDS.includes(p?.id) && !seen.has(p.id) && seen.add(p.id))
        .map((p: { id: PaneId; h: number }) => ({ id: p.id, h: Number(p.h) > 0 ? Number(p.h) : 1 }));
      if (panes.length) cols.push({ w: Number(c.w) > 0 ? Number(c.w) : 1, panes });
    }
  if (!cols.length) return structuredClone(DEFAULT_LAYOUT);
  for (const id of PANE_IDS) if (!seen.has(id)) cols[cols.length - 1].panes.push({ id, h: 1 });
  return { cols };
}

const LAYOUT_KEY = "chimera-karaoke:layout";
export function loadLayout(): Layout {
  try {
    return normalLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
  } catch {
    return structuredClone(DEFAULT_LAYOUT);
  }
}
export const saveLayout = (l: Layout) => localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));

type Zone = "above" | "below" | "left" | "right";

/** move pane `id` next to `target`, on its `zone` side */
function moveTo(l: Layout, id: PaneId, target: PaneId, zone: Zone): Layout {
  if (id === target) return l;
  const cols = l.cols.map((c) => ({ w: c.w, panes: c.panes.map((p) => ({ ...p })) }));
  let moved: { id: PaneId; h: number } | null = null;
  for (const c of cols) {
    const i = c.panes.findIndex((p) => p.id === id);
    if (i >= 0) moved = c.panes.splice(i, 1)[0];
  }
  if (!moved) return l;
  const kept = cols.filter((c) => c.panes.length);
  const ci = kept.findIndex((c) => c.panes.some((p) => p.id === target));
  if (ci < 0) return l;
  const col = kept[ci];
  if (zone === "left" || zone === "right") {
    // a column of its own beside the target's, taking half of that column's width
    col.w /= 2;
    kept.splice(zone === "left" ? ci : ci + 1, 0, { w: col.w, panes: [{ id: moved.id, h: 1 }] });
  } else {
    const ti = col.panes.findIndex((p) => p.id === target);
    const h = col.panes.reduce((a, p) => a + p.h, 0) / col.panes.length;
    col.panes.splice(zone === "above" ? ti : ti + 1, 0, { id: moved.id, h });
  }
  return { cols: kept };
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const GAP = 8;
/** a fraction of the container as CSS, less half the gap on each inner side */
const pos = (a: number, b: number) => ({
  start: `calc(${a * 100}% + ${a > 0 ? GAP / 2 : 0}px)`,
  size: `calc(${(b - a) * 100}% - ${(a > 0 ? GAP / 2 : 0) + (b < 1 ? GAP / 2 : 0)}px)`,
});

export function PaneLayout(props: { layout: Layout; onChange: (l: Layout) => void; panes: { id: PaneId; node: ReactNode; shown: boolean }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: PaneId; target: PaneId | null; zone: Zone | null } | null>(null);
  const shown = new Set(props.panes.filter((p) => p.shown).map((p) => p.id));
  // the columns and panes on screen, with their places as fractions of the container
  const cols = props.layout.cols.map((c, ci) => ({ ...c, ci, panes: c.panes.filter((p) => shown.has(p.id)) })).filter((c) => c.panes.length);
  const W = cols.reduce((a, c) => a + c.w, 0);
  const rects = new Map<PaneId, Rect>();
  const vSplits: { x: number; left: number; right: number }[] = [];
  const hSplits: { x0: number; x1: number; y: number; col: number; above: PaneId; below: PaneId }[] = [];
  let x = 0;
  cols.forEach((c, k) => {
    const x0 = x / W, x1 = (x + c.w) / W;
    x += c.w;
    const H = c.panes.reduce((a, p) => a + p.h, 0);
    let y = 0;
    c.panes.forEach((p, j) => {
      const y0 = y / H, y1 = (y + p.h) / H;
      y += p.h;
      rects.set(p.id, { x0, x1, y0, y1 });
      if (j > 0) hSplits.push({ x0, x1, y: y0, col: c.ci, above: c.panes[j - 1].id, below: p.id });
    });
    if (k > 0) vSplits.push({ x: x0, left: cols[k - 1].ci, right: c.ci });
  });

  const box = () => ref.current!.getBoundingClientRect();

  // the gaps: drag to share the space between the two sides
  const startResize = (e: React.PointerEvent, kind: "v" | "h", a: number | PaneId, b: number | PaneId, col?: number) => {
    e.preventDefault();
    const b0 = box();
    const l0 = props.layout;
    const move = (ev: PointerEvent) => {
      const l = structuredClone(l0);
      if (kind === "v") {
        const L = l.cols[a as number], R = l.cols[b as number];
        const sum = L.w + R.w;
        // the two columns' share of the width, in pixels, from their left edge
        const left = cols.filter((c) => c.ci < (a as number)).reduce((s, c) => s + c.w, 0);
        const px0 = (left / W) * b0.width, px1 = ((left + sum) / W) * b0.width;
        const u = Math.min(0.85, Math.max(0.15, (ev.clientX - b0.left - px0) / (px1 - px0)));
        L.w = sum * u;
        R.w = sum * (1 - u);
      } else {
        const c = l.cols[col!];
        const vis = c.panes.filter((p) => shown.has(p.id));
        const ia = vis.findIndex((p) => p.id === a), ib = vis.findIndex((p) => p.id === b);
        const H = vis.reduce((s, p) => s + p.h, 0);
        const top = vis.slice(0, ia).reduce((s, p) => s + p.h, 0);
        const sum = vis[ia].h + vis[ib].h;
        const py0 = (top / H) * b0.height, py1 = ((top + sum) / H) * b0.height;
        const u = Math.min(0.88, Math.max(0.12, (ev.clientY - b0.top - py0) / (py1 - py0)));
        vis[ia].h = sum * u;
        vis[ib].h = sum * (1 - u);
      }
      props.onChange(l);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // a pane's title bar: drag it onto another pane
  const startDrag = (e: React.PointerEvent, id: PaneId) => {
    const el = e.target as HTMLElement;
    if (!el.closest(".screen-head") || el.closest("select, button, input, label, a")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let active = false;
    let cur: { target: PaneId | null; zone: Zone | null } = { target: null, zone: null };
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      active = true;
      const b0 = box();
      const fx = (ev.clientX - b0.left) / b0.width, fy = (ev.clientY - b0.top) / b0.height;
      cur = { target: null, zone: null };
      for (const [pid, r] of rects) {
        if (fx < r.x0 || fx > r.x1 || fy < r.y0 || fy > r.y1) continue;
        if (pid === id) break;
        const rx = (fx - r.x0) / (r.x1 - r.x0), ry = (fy - r.y0) / (r.y1 - r.y0);
        cur = { target: pid, zone: rx < 0.22 ? "left" : rx > 0.78 ? "right" : ry < 0.5 ? "above" : "below" };
        break;
      }
      setDrag({ id, ...cur });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (active && cur.target && cur.zone) props.onChange(moveTo(props.layout, id, cur.target, cur.zone));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // where a drop would put the pane, drawn over the target
  let hint: Rect | null = null;
  if (drag?.target && drag.zone) {
    const r = rects.get(drag.target)!;
    const my = (r.y0 + r.y1) / 2;
    hint =
      drag.zone === "left" ? { ...r, x1: r.x0 + (r.x1 - r.x0) * 0.33 } : drag.zone === "right" ? { ...r, x0: r.x1 - (r.x1 - r.x0) * 0.33 } : drag.zone === "above" ? { ...r, y1: my } : { ...r, y0: my };
  }
  const place = (r: Rect): React.CSSProperties => {
    const h = pos(r.x0, r.x1), v = pos(r.y0, r.y1);
    return { left: h.start, width: h.size, top: v.start, height: v.size };
  };

  return (
    <div ref={ref} className={`k-layout${drag ? " dragging" : ""}`}>
      {props.panes.map((p) => {
        const r = rects.get(p.id);
        return (
          <div key={p.id} className={`k-pane k-pane-${p.id}${drag?.id === p.id ? " moving" : ""}`} style={r ? place(r) : { display: "none" }} data-pane={p.id} onPointerDown={(e) => startDrag(e, p.id)}>
            {p.node}
          </div>
        );
      })}
      {vSplits.map((s) => (
        <div key={`v${s.left}`} className="k-split v" style={{ left: `calc(${s.x * 100}% - ${GAP / 2}px)` }} onPointerDown={(e) => startResize(e, "v", s.left, s.right)} />
      ))}
      {hSplits.map((s) => {
        const h = pos(s.x0, s.x1);
        return <div key={`h${s.above}`} className="k-split h" style={{ left: h.start, width: h.size, top: `calc(${s.y * 100}% - ${GAP / 2}px)` }} onPointerDown={(e) => startResize(e, "h", s.above, s.below, s.col)} />;
      })}
      {hint && <div className="k-drop" style={place(hint)} />}
    </div>
  );
}
