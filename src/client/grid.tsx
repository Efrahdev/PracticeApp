// One data grid for every big table in the app (Library, Papers, paper builder, a
// saved paper): click a header to sort (again to reverse), columns fit the width
// automatically or are chosen by you, text wraps inside cells, the first columns stay
// put when the table scrolls sideways, and on a phone each row becomes a card.
import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, readLocal, usePopover, writeLocal } from "./builder/controls";

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir }

export interface GridCol<T> {
  id: string;
  label: string;
  /** narrowest width before the table scrolls sideways instead of squeezing */
  min: number;
  fr: number;
  px?: number; // fixed width
  /** always shown (not offered in the column chooser) */
  fixed?: boolean;
  /** Auto mode adds optional columns by priority (lower first) while they fit; no prio = only when chosen */
  prio?: number;
  sortValue?: (r: T) => string | number | null | undefined;
  firstDir?: SortDir;
  render: (r: T, i: number) => ComponentChildren;
  header?: ComponentChildren; // custom header content (e.g. select-all)
  sticky?: boolean; // stays at the left when scrolling sideways (needs px, or to be the last sticky column)
  card?: "lead" | "end" | "main" | "full"; // phone layout
  align?: "end";
}

type ColPref = "auto" | string[];

const cmp = (a: string | number | null | undefined, b: string | number | null | undefined) => {
  const an = a === null || a === undefined || a === "", bn = b === null || b === undefined || b === "";
  if (an || bn) return an && bn ? 0 : an ? 1 : -1; // empty always last
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

export function sortRows<T>(rows: T[], col: GridCol<T> | undefined, dir: SortDir): T[] {
  if (!col?.sortValue) return rows;
  const f = col.sortValue;
  const keyed = rows.map((r, i) => ({ r, i, v: f(r) }));
  keyed.sort((x, y) => {
    const empty = (v: unknown) => v === null || v === undefined || v === "";
    if (empty(x.v) !== empty(y.v)) return empty(x.v) ? 1 : -1;
    const c = cmp(x.v, y.v);
    return (dir === "asc" ? c : -c) || x.i - y.i;
  });
  return keyed.map((k) => k.r);
}

export function DataGrid<T>(props: {
  cols: GridCol<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  storageKey: string;
  label: string;
  title?: ComponentChildren;
  toolbar?: ComponentChildren;
  empty?: ComponentChildren;
  defaultSort?: SortState | null;
  /** "external": a header click hands the sorted rows to onSort (e.g. to reorder a paper) instead of sorting the view */
  sortMode?: "view" | "external";
  onSort?: (sorted: T[]) => void;
  rowClass?: (r: T) => string;
  expanded?: (r: T) => ComponentChildren | null;
  pageSize?: number;
  bare?: boolean; // no card frame (caller supplies one)
}) {
  const { cols } = props;
  const [pref, setPrefState] = useState<ColPref>(() => {
    const saved = readLocal<unknown>(props.storageKey, "auto");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string" && cols.some((c) => c.id === id && !c.fixed)) : "auto";
  });
  const setPref = (p: ColPref) => { setPrefState(p); writeLocal(props.storageKey, p); };
  const [sort, setSort] = useState<SortState | null>(props.defaultSort ?? null);
  const [shownCount, setShownCount] = useState(props.pageSize ?? Infinity);
  const [scrolled, setScrolled] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (!("ResizeObserver" in window)) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const optional = cols.filter((c) => !c.fixed);
  const fixedCols = cols.filter((c) => c.fixed);
  const w = (c: GridCol<T>) => c.px ?? c.min;
  let shown: string[];
  if (pref !== "auto") shown = pref;
  else {
    const order = optional.filter((c) => c.prio !== undefined).sort((a, b) => a.prio! - b.prio!);
    if (!width || width < 720) shown = order.map((c) => c.id);
    else {
      let used = fixedCols.reduce((a, c) => a + w(c), 0);
      shown = [];
      for (const c of order) {
        if (used + w(c) > width - 2) break;
        shown.push(c.id);
        used += w(c);
      }
    }
  }
  const visible = cols.filter((c) => c.fixed || shown.includes(c.id));
  const template = visible.map((c) => (c.px ? `${c.px}px` : `minmax(${c.min}px, ${c.fr}fr)`)).join(" ");
  const minWidth = visible.reduce((a, c) => a + w(c), 0);
  const stickyLeft = new Map<string, number>();
  {
    let left = 0;
    for (const c of visible) {
      if (!c.sticky) break;
      stickyLeft.set(c.id, left);
      left += c.px ?? 0;
    }
  }

  const sortCol = sort ? cols.find((c) => c.id === sort.key) : undefined;
  const external = props.sortMode === "external";
  const rows = !external && sortCol ? sortRows(props.rows, sortCol, sort!.dir) : props.rows;
  // In external mode the arrow shows only while the rows are still in that order.
  const activeSort = sort && (!external || (sortCol && sortRows(props.rows, sortCol, sort.dir).every((r, i) => r === props.rows[i]))) ? sort : null;
  const clickSort = (c: GridCol<T>) => {
    const dir: SortDir = sort?.key === c.id ? (sort.dir === "asc" ? "desc" : "asc") : c.firstDir ?? "asc";
    setSort({ key: c.id, dir });
    if (external) props.onSort?.(sortRows(props.rows, c, dir));
  };
  const page = rows.slice(0, shownCount);

  const grid = props.rows.length === 0 ? (
    <div class="dt-empty">{props.empty ?? "Nothing here yet."}</div>
  ) : (
    <div class={`dt-wrap${scrolled ? " scrolled" : ""}`} onScroll={(e) => setScrolled((e.currentTarget as HTMLDivElement).scrollLeft > 0)}>
      <div class="dt" role="table" aria-label={props.label} aria-rowcount={rows.length + 1} style={`--cols:${template};min-width:${minWidth}px`}>
        <div class="dt-row dt-head" role="row">
          {visible.map((c) => {
            const on = activeSort?.key === c.id;
            const st = stickyLeft.has(c.id) ? `left:${stickyLeft.get(c.id)}px` : undefined;
            return (
              <div class={`dt-th c-${c.id}${stickyLeft.has(c.id) ? " sticky" : ""}${c.align === "end" ? " end" : ""}`} role="columnheader" style={st}
                aria-sort={on ? (activeSort!.dir === "asc" ? "ascending" : "descending") : c.sortValue ? "none" : undefined}>
                {c.header ?? (c.sortValue ? (
                  <button type="button" class={`th-sort${on ? " on" : ""}`} onClick={() => clickSort(c)} aria-label={`Sort by ${c.label.toLowerCase()}`} title={`Sort by ${c.label.toLowerCase()}`}>
                    <span>{c.label}</span>
                    <Icon name={on && activeSort!.dir === "desc" ? "dn" : "up"} size={11} class="th-arrow" />
                  </button>
                ) : c.label ? <span>{c.label}</span> : <span class="sr">{c.id}</span>)}
              </div>
            );
          })}
        </div>
        {page.map((r, i) => {
          const ex = props.expanded?.(r);
          return (
            <Fragment key={props.rowKey(r)}>
              <div class={`dt-row ${props.rowClass?.(r) ?? ""}`} role="row">
                {visible.map((c) => (
                  <div class={`dt-cell c-${c.id}${stickyLeft.has(c.id) ? " sticky" : ""}${c.card ? ` card-${c.card}` : ""}${c.align === "end" ? " end" : ""}`} role="cell"
                    style={stickyLeft.has(c.id) ? `left:${stickyLeft.get(c.id)}px` : undefined}
                    data-label={c.card && c.card !== "full" ? undefined : c.label || undefined}>
                    {c.render(r, i)}
                  </div>
                ))}
              </div>
              {ex && <div class="dt-peek" role="row"><div role="cell" class="dt-peek-cell">{ex}</div></div>}
            </Fragment>
          );
        })}
      </div>
    </div>
  );

  return (
    <div class={props.bare ? "dt-bare" : "dt-card"} ref={box}>
      {(props.title || props.toolbar) && (
        <div class="dt-toolbar">
          <div class="dt-title">{props.title}</div>
          <div class="dt-tools">
            {props.toolbar}
            {optional.length > 0 && <ColumnMenu cols={optional} shown={shown} auto={pref === "auto"} setPref={setPref} />}
          </div>
        </div>
      )}
      {grid}
      {rows.length > page.length && (
        <div class="dt-more">
          <span class="muted small">Showing {page.length.toLocaleString()} of {rows.length.toLocaleString()}</span>
          <button type="button" class="btn small" onClick={() => setShownCount(shownCount + (props.pageSize ?? 100))}>Show {Math.min(props.pageSize ?? 100, rows.length - page.length)} more</button>
          <button type="button" class="btn ghost small" onClick={() => setShownCount(Infinity)}>Show all</button>
        </div>
      )}
    </div>
  );
}

function ColumnMenu<T>(props: { cols: GridCol<T>[]; shown: string[]; auto: boolean; setPref: (p: ColPref) => void }) {
  const pop = usePopover();
  const set = new Set(props.shown);
  const toggle = (id: string) => props.setPref(props.cols.map((o) => o.id).filter((x) => (x === id ? !set.has(id) : set.has(x))));
  return (
    <div class="pop-wrap" ref={pop.ref}>
      <button type="button" class="btn small" aria-expanded={pop.open} aria-haspopup="true" onClick={() => pop.setOpen(!pop.open)}>
        <Icon name="columns" size={14} /> Columns{props.auto ? "" : ` · ${props.shown.length}`}
      </button>
      {pop.open && (
        <div class="pop" role="group" aria-label="Choose columns">
          <label class="pop-item strong">
            <input type="checkbox" role="switch" class="switch" checked={props.auto} onChange={() => props.setPref(props.auto ? props.shown : "auto")} />
            <span><b>Auto</b><span class="pop-sub">Show what fits the width</span></span>
          </label>
          <div class="pop-title">Columns</div>
          {props.cols.map((c) => (
            <label class="pop-item">
              <input type="checkbox" class="cb" checked={set.has(c.id)} onChange={() => toggle(c.id)} />
              {c.label}
            </label>
          ))}
          <div class="pop-foot">
            <button type="button" class="btn ghost small" onClick={() => props.setPref("auto")}>Reset</button>
            <button type="button" class="btn ghost small" onClick={() => props.setPref(props.cols.map((o) => o.id))}>Show all</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Sorting for small plain tables: <th> buttons + sorted rows. */
export function useTableSort<T>(rows: T[], getters: Record<string, (r: T) => string | number | null | undefined>, initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const sorted = sort && getters[sort.key] ? sortRows(rows, { id: sort.key, label: "", min: 0, fr: 0, render: () => null, sortValue: getters[sort.key] }, sort.dir) : rows;
  const Th = (p: { k: string; children: ComponentChildren; first?: SortDir; class?: string }) => {
    const on = sort?.key === p.k;
    return (
      <th class={p.class} aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button type="button" class={`th-sort${on ? " on" : ""}`}
          onClick={() => setSort({ key: p.k, dir: on ? (sort!.dir === "asc" ? "desc" : "asc") : p.first ?? "asc" })}>
          <span>{p.children}</span><Icon name={on && sort!.dir === "desc" ? "dn" : "up"} size={11} class="th-arrow" />
        </button>
      </th>
    );
  };
  return { sorted, Th };
}

export interface SortCol<T> {
  key: string;
  label: ComponentChildren;
  get?: (r: T) => string | number | null | undefined; // sortable when given
  render: (r: T) => ComponentChildren;
  class?: string;
  first?: SortDir;
}

/** A plain small table whose headers sort it. */
export function SortTable<T>(props: { rows: T[]; cols: SortCol<T>[]; initial?: SortState | null; class?: string }) {
  const getters: Record<string, (r: T) => string | number | null | undefined> = {};
  for (const c of props.cols) if (c.get) getters[c.key] = c.get;
  const { sorted, Th } = useTableSort(props.rows, getters, props.initial ?? null);
  return (
    <div class="table-scroll"><table class={`table ${props.class ?? ""}`}>
      <thead>
        <tr>{props.cols.map((c) => (c.get ? <Th k={c.key} first={c.first} class={c.class}>{c.label}</Th> : <th class={c.class}>{c.label}</th>))}</tr>
      </thead>
      <tbody>{sorted.map((r) => <tr>{props.cols.map((c) => <td class={c.class}>{c.render(r)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
