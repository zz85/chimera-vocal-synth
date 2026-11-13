/**
 * The karaoke page's panes. Docked panes fill the area as a tree of splits: a split lays its
 * children out in a row or a column, each with a weight. A pane can also float above the
 * others, at a place and size of its own.
 *
 * Drag a docked pane by its title bar:
 *   onto another pane's edge   to split that pane and dock beside it on that side,
 *   onto another pane's middle to swap the two,
 *   onto the area's own edge   to dock across the whole width or height there (the bottom edge
 *                              docks a pane under everything).
 * Drag a floating pane by its title bar to move it, by its corner to resize it. Each pane has
 * buttons to float or dock it and to show it full screen. Drag the gaps between docked panes to
 * resize them. Every pane stays mounted where it is in the page and is placed absolutely, so
 * moving one doesn't restart it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export type PaneId = "voices" | "band" | "visual" | "lyrics" | "roll";
export const PANE_IDS: PaneId[] = ["voices", "band", "visual", "lyrics", "roll"];

export type Node = { kind: "pane"; id: PaneId; w: number } | { kind: "split"; dir: "row" | "col"; w: number; children: Node[] };
export interface Float {
  id: PaneId;
  /** its place and size, as fractions of the area */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Layout {
  root: Node;
  floats: Float[];
}

const pane = (id: PaneId, w: number): Node => ({ kind: "pane", id, w });
const split = (dir: "row" | "col", w: number, children: Node[]): Node => ({ kind: "split", dir, w, children });

export const DEFAULT_LAYOUT: Layout = {
  root: split("row", 1, [split("col", 2, [pane("voices", 3), pane("lyrics", 1.1), pane("roll", 1)]), split("col", 1, [pane("band", 1), pane("visual", 1.3)])]),
  floats: [],
};

const clone = <T,>(x: T): T => structuredClone(x);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** a layout as stored or sent, made whole: each pane once, none unknown (an older layout of columns too) */
export function normalLayout(l: unknown): Layout {
  const seen = new Set<PaneId>();
  const take = (id: unknown): id is PaneId => PANE_IDS.includes(id as PaneId) && !seen.has(id as PaneId) && !!seen.add(id as PaneId);
  const w = (v: unknown) => (Number(v) > 0 ? Number(v) : 1);
  const node = (n: unknown): Node | null => {
    const x = n as Record<string, unknown> | null;
    if (!x || typeof x !== "object") return null;
    if (x.kind === "pane") return take(x.id) ? pane(x.id as PaneId, w(x.w)) : null;
    if (x.kind === "split" && Array.isArray(x.children)) {
      const kids = x.children.map(node).filter((k): k is Node => !!k);
      if (!kids.length) return null;
      if (kids.length === 1) return { ...kids[0], w: w(x.w) };
      return split(x.dir === "col" ? "col" : "row", w(x.w), kids);
    }
    return null;
  };
  const src = l as { root?: unknown; floats?: unknown; cols?: { w: number; panes: { id: PaneId; h: number }[] }[] } | null;
  let root: Node | null = null;
  if (src?.root) root = node(src.root);
  else if (Array.isArray(src?.cols))
    // the older layout: columns of panes
    root = node({ kind: "split", dir: "row", w: 1, children: src!.cols.map((c) => ({ kind: "split", dir: "col", w: c.w, children: (c.panes ?? []).map((p) => ({ kind: "pane", id: p.id, w: p.h })) })) });
  const floats: Float[] = [];
  if (Array.isArray(src?.floats))
    for (const f of src!.floats as Float[]) if (take(f?.id)) floats.push({ id: f.id, x: clamp(Number(f.x) || 0, 0, 0.9), y: clamp(Number(f.y) || 0, 0, 0.9), w: clamp(Number(f.w) || 0.3, 0.1, 1), h: clamp(Number(f.h) || 0.3, 0.1, 1) });
  if (!root) {
    if (!seen.size) return clone(DEFAULT_LAYOUT);
    root = pane(PANE_IDS.find((id) => !seen.has(id)) ?? "voices", 1);
    seen.add((root as { id: PaneId }).id);
  }
  // a pane the layout leaves out docks along the bottom
  for (const id of PANE_IDS) if (!seen.has(id)) root = dockEdge(root, pane(id, 1), "bottom");
  return { root, floats };
}

const LAYOUT_KEY = "chimera-karaoke:layout";
export function loadLayout(): Layout {
  try {
    return normalLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
  } catch {
    return clone(DEFAULT_LAYOUT);
  }
}
export const saveLayout = (l: Layout) => localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));

type Side = "left" | "right" | "top" | "bottom";
const dirOf = (s: Side) => (s === "left" || s === "right" ? "row" : "col");
const first = (s: Side) => s === "left" || s === "top";

/** the tree without pane `id`; a split left with one child gives way to it */
function without(n: Node, id: PaneId): Node | null {
  if (n.kind === "pane") return n.id === id ? null : n;
  const kids = n.children.map((k) => without(k, id)).filter((k): k is Node => !!k);
  if (!kids.length) return null;
  if (kids.length === 1) return { ...kids[0], w: n.w };
  return { ...n, children: kids };
}

/** `p` docked along the whole of one side of `root` */
function dockEdge(root: Node, p: Node, side: Side): Node {
  const dir = dirOf(side);
  if (root.kind === "split" && root.dir === dir) {
    const total = root.children.reduce((a, k) => a + k.w, 0);
    const kid = { ...p, w: total / 3 };
    return { ...root, children: first(side) ? [kid, ...root.children] : [...root.children, kid] };
  }
  const r = { ...root, w: 3 };
  const kid = { ...p, w: 1 };
  return split(dir, 1, first(side) ? [kid, r] : [r, kid]);
}

/** `p` docked beside pane `target`, on `side`, splitting the target's place */
function dockBeside(n: Node, target: PaneId, p: Node, side: Side): Node {
  if (n.kind === "pane") {
    if (n.id !== target) return n;
    const a = { ...n, w: 1 }, b = { ...p, w: 1 };
    return split(dirOf(side), n.w, first(side) ? [b, a] : [a, b]);
  }
  const i = n.children.findIndex((k) => k.kind === "pane" && k.id === target);
  if (i >= 0 && n.dir === dirOf(side)) {
    // the target's own split runs that way: take half of its place
    const kids = n.children.slice();
    const t = kids[i];
    kids[i] = { ...t, w: t.w / 2 };
    kids.splice(first(side) ? i : i + 1, 0, { ...p, w: t.w / 2 });
    return { ...n, children: kids };
  }
  return { ...n, children: n.children.map((k) => dockBeside(k, target, p, side)) };
}

function swap(n: Node, a: PaneId, b: PaneId): Node {
  if (n.kind === "pane") return n.id === a ? { ...n, id: b } : n.id === b ? { ...n, id: a } : n;
  return { ...n, children: n.children.map((k) => swap(k, a, b)) };
}

function holds(n: Node, id: PaneId): boolean {
  return n.kind === "pane" ? n.id === id : n.children.some((k) => holds(k, id));
}

type Drop = { kind: "edge"; side: Side } | { kind: "beside"; target: PaneId; side: Side } | { kind: "swap"; target: PaneId };

/** pane `id` (docked or floating) docked where `d` says */
function dropTo(l: Layout, id: PaneId, d: Drop): Layout {
  if (d.kind !== "edge" && d.target === id) return l;
  const floats = l.floats.filter((f) => f.id !== id);
  if (d.kind === "swap" && holds(l.root, id)) return { root: swap(l.root, id, d.target), floats };
  const rest = holds(l.root, id) ? without(l.root, id) : l.root;
  const p = pane(id, 1);
  if (!rest) return { root: p, floats };
  if (d.kind === "edge") return { root: dockEdge(rest, p, d.side), floats };
  return { root: dockBeside(rest, d.target, p, d.kind === "swap" ? "right" : d.side), floats };
}

/** pane `id` floating at `rect`, out of the tree */
export function floatPane(l: Layout, id: PaneId, rect: Omit<Float, "id">): Layout {
  const rest = holds(l.root, id) ? without(l.root, id) : l.root;
  // the last docked pane stays docked
  if (!rest) return l;
  return { root: rest, floats: [...l.floats.filter((f) => f.id !== id), { id, ...rect }] };
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Splitter {
  path: number[];
  dir: "row" | "col";
  ia: number;
  ib: number;
  /** where the gap is, and the span the two children share, along the split's direction */
  at: number;
  s0: number;
  s1: number;
  /** the gap's extent across it */
  c0: number;
  c1: number;
}

/** the pane buttons' icons, drawn: the page's font has no glyphs for them */
const svg = (d: string) => (
  <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICON = {
  // a window lifted off another
  float: svg("M1.5 4.5h6v6h-6zM4.5 1.5h6v6"),
  // a window set into a frame
  dock: svg("M1.5 1.5h9v9h-9zM1.5 7h9"),
  // four corners pointing out
  full: svg("M1.5 4.5v-3h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3"),
};

const GAP = 8;
/** a fraction of the area as CSS, less half the gap on each inner side */
const pos = (a: number, b: number) => ({
  start: `calc(${a * 100}% + ${a > 0.0001 ? GAP / 2 : 0}px)`,
  size: `calc(${(b - a) * 100}% - ${(a > 0.0001 ? GAP / 2 : 0) + (b < 0.9999 ? GAP / 2 : 0)}px)`,
});
const place = (r: Rect): React.CSSProperties => {
  const h = pos(r.x0, r.x1), v = pos(r.y0, r.y1);
  return { left: h.start, width: h.size, top: v.start, height: v.size };
};

function shownIn(n: Node, shown: Set<PaneId>): boolean {
  return n.kind === "pane" ? shown.has(n.id) : n.children.some((k) => shownIn(k, shown));
}

/** each shown docked pane's place, and the gaps to drag */
function geometry(root: Node, shown: Set<PaneId>) {
  const rects = new Map<PaneId, Rect>();
  const splitters: Splitter[] = [];
  const walk = (n: Node, r: Rect, path: number[]) => {
    if (n.kind === "pane") {
      rects.set(n.id, r);
      return;
    }
    const kids = n.children.map((k, i) => ({ k, i })).filter(({ k }) => shownIn(k, shown));
    const total = kids.reduce((a, { k }) => a + k.w, 0);
    const row = n.dir === "row";
    const a0 = row ? r.x0 : r.y0, a1 = row ? r.x1 : r.y1;
    let at = a0;
    let prev: { i: number; s0: number } | null = null;
    for (const { k, i } of kids) {
      const s0 = at, s1 = at + ((a1 - a0) * k.w) / total;
      at = s1;
      if (prev) splitters.push({ path, dir: n.dir, ia: prev.i, ib: i, at: s0, s0: prev.s0, s1, c0: row ? r.y0 : r.x0, c1: row ? r.y1 : r.x1 });
      prev = { i, s0 };
      walk(k, row ? { ...r, x0: s0, x1: s1 } : { ...r, y0: s0, y1: s1 }, [...path, i]);
    }
  };
  if (shownIn(root, shown)) walk(root, { x0: 0, x1: 1, y0: 0, y1: 1 }, []);
  return { rects, splitters };
}

function at(n: Node, path: number[]): Node {
  return path.reduce((x, i) => (x as Extract<Node, { kind: "split" }>).children[i], n);
}

export function PaneLayout(props: { layout: Layout; onChange: (l: Layout) => void; panes: { id: PaneId; title: string; node: ReactNode; shown: boolean }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const paneEls = useRef(new Map<PaneId, HTMLDivElement>());
  const [drag, setDrag] = useState<{ id: PaneId; drop: Drop | null } | null>(null);
  const [maxed, setMaxed] = useState<PaneId | null>(null);
  const L = props.layout;
  const shown = new Set(props.panes.filter((p) => p.shown).map((p) => p.id));
  const { rects, splitters } = geometry(L.root, shown);
  const floats = L.floats.filter((f) => shown.has(f.id));
  const box = () => ref.current!.getBoundingClientRect();

  // the gaps: drag to share the space between the two sides
  const startResize = (e: React.PointerEvent, s: Splitter) => {
    e.preventDefault();
    const b0 = box();
    const l0 = props.layout;
    const move = (ev: PointerEvent) => {
      const l = clone(l0);
      const node = at(l.root, s.path) as Extract<Node, { kind: "split" }>;
      const A = node.children[s.ia], B = node.children[s.ib];
      const sum = A.w + B.w;
      const f = s.dir === "row" ? (ev.clientX - b0.left) / b0.width : (ev.clientY - b0.top) / b0.height;
      const u = clamp((f - s.s0) / (s.s1 - s.s0), 0.1, 0.9);
      A.w = sum * u;
      B.w = sum * (1 - u);
      props.onChange(l);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** where a dragged pane would dock, for a point in the area */
  const dropAt = (fx: number, fy: number, id: PaneId): Drop | null => {
    const b0 = box();
    const ex = 28 / b0.width, ey = 28 / b0.height;
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
      if (fy > 1 - ey) return { kind: "edge", side: "bottom" };
      if (fy < ey) return { kind: "edge", side: "top" };
      if (fx < ex) return { kind: "edge", side: "left" };
      if (fx > 1 - ex) return { kind: "edge", side: "right" };
    }
    for (const [pid, r] of rects) {
      if (fx < r.x0 || fx > r.x1 || fy < r.y0 || fy > r.y1) continue;
      if (pid === id) return null;
      const rx = (fx - r.x0) / (r.x1 - r.x0), ry = (fy - r.y0) / (r.y1 - r.y0);
      const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
      const side = (Object.keys(d) as Side[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
      return d[side] < 0.28 ? { kind: "beside", target: pid, side } : { kind: "swap", target: pid };
    }
    return null;
  };

  // a pane's title bar: drag a docked pane onto a dock, a floating one to move it
  const startDrag = (e: React.PointerEvent, id: PaneId) => {
    const el = e.target as HTMLElement;
    if (!el.closest(".screen-head") || el.closest("select, button, input, label, a, .k-pane-tools")) return;
    if (maxed) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const fl = props.layout.floats.find((f) => f.id === id);
    if (fl) {
      // floating: it moves with the pointer, and comes to the front
      const b0 = box();
      const l0 = { ...props.layout, floats: [...props.layout.floats.filter((f) => f.id !== id), fl] };
      props.onChange(l0);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - sx) / b0.width, dy = (ev.clientY - sy) / b0.height;
        props.onChange({ ...l0, floats: l0.floats.map((f) => (f.id === id ? { ...f, x: clamp(fl.x + dx, -fl.w + 0.05, 0.95), y: clamp(fl.y + dy, 0, 0.95) } : f)) });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    let active = false;
    let cur: Drop | null = null;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      active = true;
      const b0 = box();
      cur = dropAt((ev.clientX - b0.left) / b0.width, (ev.clientY - b0.top) / b0.height, id);
      setDrag({ id, drop: cur });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (active && cur) props.onChange(dropTo(props.layout, id, cur));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // a floating pane's corner: drag to resize
  const startFloatResize = (e: React.PointerEvent, id: PaneId) => {
    e.preventDefault();
    e.stopPropagation();
    const b0 = box();
    const sx = e.clientX, sy = e.clientY;
    const fl = props.layout.floats.find((f) => f.id === id)!;
    const l0 = props.layout;
    const move = (ev: PointerEvent) => {
      const w = clamp(fl.w + (ev.clientX - sx) / b0.width, 160 / b0.width, 1 - fl.x);
      const h = clamp(fl.h + (ev.clientY - sy) / b0.height, 110 / b0.height, 1 - fl.y);
      props.onChange({ ...l0, floats: l0.floats.map((f) => (f.id === id ? { ...f, w, h } : f)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleFloat = (id: PaneId) => {
    const l = props.layout;
    if (l.floats.some((f) => f.id === id)) {
      // dock it again along the right
      props.onChange(dropTo(l, id, { kind: "edge", side: "right" }));
      return;
    }
    const r = rects.get(id);
    // floats over where it was, a little smaller, so it reads as lifted
    const w = r ? Math.max(0.25, (r.x1 - r.x0) * 0.8) : 0.4, h = r ? Math.max(0.25, (r.y1 - r.y0) * 0.8) : 0.4;
    const x = r ? clamp(r.x0 + (r.x1 - r.x0 - w) / 2 + 0.02, 0, 1 - w) : 0.3, y = r ? clamp(r.y0 + (r.y1 - r.y0 - h) / 2 + 0.03, 0, 1 - h) : 0.3;
    props.onChange(floatPane(l, id, { x, y, w, h }));
  };

  // Esc leaves the page's own full screen (the browser's leaves by itself)
  useEffect(() => {
    if (!maxed) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && setMaxed(null);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [maxed]);

  const fullScreen = (id: PaneId) => {
    const el = paneEls.current.get(id);
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else if (maxed === id) setMaxed(null);
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => setMaxed(id));
    else setMaxed(id);
  };

  // where a drop would dock the pane, drawn over the place it would take
  let hint: Rect | null = null;
  const d = drag?.drop;
  if (d?.kind === "edge") hint = d.side === "bottom" ? { x0: 0, x1: 1, y0: 0.75, y1: 1 } : d.side === "top" ? { x0: 0, x1: 1, y0: 0, y1: 0.25 } : d.side === "left" ? { x0: 0, x1: 0.25, y0: 0, y1: 1 } : { x0: 0.75, x1: 1, y0: 0, y1: 1 };
  else if (d) {
    const r = rects.get(d.target)!;
    if (d.kind === "swap") hint = r;
    else {
      const mx = r.x0 + (r.x1 - r.x0) / 2, my = r.y0 + (r.y1 - r.y0) / 2;
      hint = d.side === "left" ? { ...r, x1: mx } : d.side === "right" ? { ...r, x0: mx } : d.side === "top" ? { ...r, y1: my } : { ...r, y0: my };
    }
  }

  return (
    <div ref={ref} className={`k-layout${drag ? " dragging" : ""}`}>
      {props.panes.map((p) => {
        const r = rects.get(p.id);
        const fi = floats.findIndex((f) => f.id === p.id);
        const fl = fi >= 0 ? floats[fi] : null;
        const style: React.CSSProperties = fl ? { left: `${fl.x * 100}%`, top: `${fl.y * 100}%`, width: `${fl.w * 100}%`, height: `${fl.h * 100}%`, zIndex: 10 + fi } : r ? place(r) : { display: "none" };
        if (!p.shown) style.display = "none";
        return (
          <div
            key={p.id}
            ref={(el) => void (el ? paneEls.current.set(p.id, el) : paneEls.current.delete(p.id))}
            className={`k-pane k-pane-${p.id}${fl ? " floating" : ""}${drag?.id === p.id ? " moving" : ""}${maxed === p.id ? " maxed" : ""}`}
            style={style}
            data-pane={p.id}
            onPointerDown={(e) => startDrag(e, p.id)}
          >
            {p.node}
            <div className="k-pane-tools">
              <button title={fl ? "Dock this pane again" : "Float this pane above the others"} aria-label={fl ? `Dock ${p.title}` : `Float ${p.title}`} onClick={() => toggleFloat(p.id)}>
                {fl ? ICON.dock : ICON.float}
              </button>
              <button title="Full screen (Esc to leave)" aria-label={`${p.title} full screen`} onClick={() => fullScreen(p.id)}>
                {ICON.full}
              </button>
            </div>
            {fl && <div className="k-float-corner" title="Drag to resize" onPointerDown={(e) => startFloatResize(e, p.id)} />}
          </div>
        );
      })}
      {splitters.map((s) =>
        s.dir === "row" ? (
          <div key={`${s.path.join(".")}:${s.ia}`} className="k-split v" style={{ left: `calc(${s.at * 100}% - ${GAP / 2}px)`, top: pos(s.c0, s.c1).start, height: pos(s.c0, s.c1).size }} onPointerDown={(e) => startResize(e, s)} />
        ) : (
          <div key={`${s.path.join(".")}:${s.ia}`} className="k-split h" style={{ top: `calc(${s.at * 100}% - ${GAP / 2}px)`, left: pos(s.c0, s.c1).start, width: pos(s.c0, s.c1).size }} onPointerDown={(e) => startResize(e, s)} />
        ),
      )}
      {hint && <div className={`k-drop${d?.kind === "swap" ? " swap" : ""}`} style={place(hint)} />}
      {maxed && (
        <button className="k-unmax" onClick={() => setMaxed(null)}>
          Leave full screen
        </button>
      )}
    </div>
  );
}
