// Locked boxes for question and solution content (FR-1.5): a sandboxed srcdoc frame
// (no scripts), a Content-Security-Policy that blocks every outside call, and the
// app's own styles kept out. The parent measures the height so the box fits.
import { useEffect, useRef, useState } from "preact/hooks";
import { blobText } from "./api";
import {
  blobAssetResolver, documentHtml, ensureMath, inlineAssets, renderSolutionBody, renderStoredQuestion,
  type AssetResolver, type QuestionRenderOptions,
} from "./render";
import type { StoredQuestion } from "../shared/qpack/types";

export function DocFrame(props: { doc: string | null; error?: string | null; title?: string; minHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(props.minHeight ?? 60);
  useEffect(() => {
    const f = ref.current;
    if (!f || !props.doc) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const d = f.contentDocument;
      if (d?.documentElement) setH(Math.max(props.minHeight ?? 40, Math.ceil(d.documentElement.getBoundingClientRect().height) + 2));
    };
    const onLoad = () => {
      measure();
      requestAnimationFrame(measure);
      (f.contentDocument as Document & { fonts?: { ready: Promise<unknown> } })?.fonts?.ready.then(measure).catch(() => {});
      const body = f.contentDocument?.body;
      if (body && "ResizeObserver" in window) {
        ro = new ResizeObserver(measure);
        ro.observe(body);
      }
      // details/summary (hints) change height without resizing images
      f.contentDocument?.addEventListener("toggle", measure, true);
    };
    f.addEventListener("load", onLoad);
    return () => {
      f.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [props.doc]);
  if (props.error) return <div class="frame-error">Could not show this: {props.error}</div>;
  if (!props.doc) return <div class="frame-loading" style={{ height: `${h}px` }}>Loading…</div>;
  return (
    <iframe
      ref={ref}
      class="qframe"
      title={props.title ?? "Question"}
      sandbox="allow-same-origin"
      referrerpolicy="no-referrer"
      srcDoc={props.doc}
      style={{ height: `${h}px` }}
    />
  );
}

function useAsyncDoc(make: () => Promise<string>, deps: unknown[]) {
  const [doc, setDoc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setErr(null);
    make().then((d) => live && setDoc(d)).catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, deps);
  return { doc, err };
}

const storedCache = new Map<string, Promise<StoredQuestion>>();
export function loadStored(sha: string): Promise<StoredQuestion> {
  let p = storedCache.get(sha);
  if (!p) {
    p = blobText(sha).then((t) => JSON.parse(t) as StoredQuestion);
    p.catch(() => storedCache.delete(sha));
    storedCache.set(sha, p);
  }
  return p;
}

export interface VersionRef {
  content_format: string | null; // 'qpack_v1' | 'html_fragment'
  blob_sha256: string; // html_blob_sha256 column
  css_sha256?: string | null; // legacy stylesheet
}

/** Any stored question version: canonical (rendered here) or a v1 HTML fragment (shown as imported). */
export function QuestionView(props: { v: VersionRef; opts?: QuestionRenderOptions; title?: string; minHeight?: number }) {
  const { v, opts } = props;
  const { doc, err } = useAsyncDoc(async () => {
    if (v.content_format === "qpack_v1") {
      await ensureMath();
      const stored = await loadStored(v.blob_sha256);
      const body = await inlineAssets(renderStoredQuestion(stored, opts ?? {}), blobAssetResolver);
      return documentHtml(body, { extraCss: stored.css });
    }
    const [html, css] = await Promise.all([blobText(v.blob_sha256), v.css_sha256 ? blobText(v.css_sha256) : Promise.resolve("")]);
    return documentHtml(html, { extraCss: css });
  }, [v.blob_sha256, v.content_format, v.css_sha256, JSON.stringify(opts ?? {})]);
  return <DocFrame doc={doc} error={err} title={props.title} minHeight={props.minHeight} />;
}

/** A question that is not stored yet (import review), with its images resolved locally. */
export function StoredView(props: { stored: StoredQuestion; resolve: AssetResolver; opts?: QuestionRenderOptions; title?: string }) {
  const { doc, err } = useAsyncDoc(async () => {
    await ensureMath();
    const body = await inlineAssets(renderStoredQuestion(props.stored, props.opts ?? { showMarks: true }), props.resolve);
    return documentHtml(body, { extraCss: props.stored.css });
  }, [props.stored]);
  return <DocFrame doc={doc} error={err} title={props.title} />;
}

export interface SolutionRow {
  body_text: string | null;
  body_blob_sha256?: string | null;
  body_format?: string | null;
  origin?: string;
}

/** A solution: Markdown/LaTeX, plain text, HTML, or a v1 HTML file. */
export function SolutionView(props: { s: SolutionRow; cssSha?: string | null; resolve?: AssetResolver; extraCss?: string | null }) {
  const { s } = props;
  const { doc, err } = useAsyncDoc(async () => {
    if (s.body_blob_sha256) {
      const [html, css] = await Promise.all([blobText(s.body_blob_sha256), props.cssSha ? blobText(props.cssSha) : Promise.resolve("")]);
      return documentHtml(html, { extraCss: css });
    }
    await ensureMath();
    const body = await inlineAssets(renderSolutionBody(s.body_format ?? "text", s.body_text ?? ""), props.resolve ?? blobAssetResolver);
    return documentHtml(body, { extraCss: props.extraCss });
  }, [s.body_text, s.body_blob_sha256, s.body_format, props.cssSha]);
  return <DocFrame doc={doc} error={err} title="Solution" />;
}
