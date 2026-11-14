import { useMemo, useState } from "preact/hooks";
import { api } from "../api";
import type { FilterDef } from "../filter";
import { buildPaper, defaultSettings, GENERATOR_VERSION, randomSeed, type SamplingSettings } from "../sampler";
import { getBoot } from "../store";
import type { LibQ } from "../types";
import { ErrorBox, Modal, names, toast } from "../ui";
import { useConceptAccuracy } from "./Analytics";

export function PaperBuilder(props: { candidates: LibQ[]; def: FilterDef; savedFilterId: string | null; onClose: () => void }) {
  const boot = getBoot()!;
  const n = names(boot);
  const [count, setCount] = useState(Math.min(10, props.candidates.length));
  const [seed, setSeed] = useState(randomSeed());
  const [name, setName] = useState(`Paper ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`);
  const [settings, setSettings] = useState<SamplingSettings>(defaultSettings());
  const [useMix, setUseMix] = useState(false);
  const [withSolutions, setWithSolutions] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accuracy = useConceptAccuracy();

  const effective = useMemo(() => ({ ...settings, mix: useMix ? settings.mix : {} }), [settings, useMix]);
  const result = useMemo(
    () => buildPaper(props.candidates, Math.max(1, count), seed, effective, accuracy),
    [props.candidates, count, seed, effective, accuracy],
  );

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", "/api/papers", {
        name,
        saved_filter_id: props.savedFilterId,
        filter_definition: props.def,
        sampling_settings: effective,
        seed,
        generator_version: GENERATOR_VERSION,
        requested_count: count,
        solutions_mode: withSolutions ? "included" : "hidden",
        items: result.picks.map((p) => ({ question_id: p.q.id, question_version_id: p.q.version_id, pick_reason: p.reason })),
      });
      toast("Paper saved");
      location.hash = `#/papers/${r.id}`;
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Build a paper" onClose={props.onClose} wide>
      <ErrorBox error={err} />
      <div class="grid2">
        <label class="field">Name<input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
        <label class="field">Number of questions
          <input type="number" min="1" value={count} onInput={(e) => setCount(Math.max(1, Math.trunc(Number((e.target as HTMLInputElement).value) || 1)))} />
        </label>
        <label class="field">Seed <span class="muted small">(same seed + same filter = same paper)</span>
          <span class="row"><input type="number" value={seed} onInput={(e) => setSeed(Math.trunc(Number((e.target as HTMLInputElement).value) || 0))} />
            <button class="btn ghost" type="button" onClick={() => setSeed(randomSeed())}>New</button></span>
        </label>
        <div class="field">Favour
          <label><input type="checkbox" checked={settings.favourWrong} onChange={(e) => setSettings({ ...settings, favourWrong: (e.target as HTMLInputElement).checked })} /> ones I got wrong</label>
          <label><input type="checkbox" checked={settings.favourStale} onChange={(e) => setSettings({ ...settings, favourStale: (e.target as HTMLInputElement).checked })} /> ones not seen recently</label>
          <label><input type="checkbox" checked={settings.favourWeak} onChange={(e) => setSettings({ ...settings, favourWeak: (e.target as HTMLInputElement).checked })} /> weak concepts</label>
        </div>
      </div>
      <div class="field solutions-choice">
        <span>Solutions</span>
        <label><input type="radio" name="sol" checked={withSolutions} onChange={() => setWithSolutions(true)} /> <b>Include solutions</b> — open any question's worked solution while practising; printed copy ends with a solutions section</label>
        <label><input type="radio" name="sol" checked={!withSolutions} onChange={() => setWithSolutions(false)} /> <b>No solutions</b> — test conditions: solutions stay hidden in this paper and its printed copy</label>
      </div>
      <div class="field">
        <label><input type="checkbox" checked={useMix} onChange={(e) => setUseMix((e.target as HTMLInputElement).checked)} /> Set a difficulty mix</label>
        {useMix && (
          <div class="row wrap">
            {boot.difficulties.map((d) => (
              <label class="small">{d.label}{" "}
                <input type="number" min="0" max="100" class="w5" value={settings.mix[d.code] ?? 0}
                  onInput={(e) => setSettings({ ...settings, mix: { ...settings.mix, [d.code]: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) } })} /> %
              </label>
            ))}
          </div>
        )}
      </div>

      {result.shortfall > 0 && (
        <div class="warn-box" role="alert">
          Only {props.candidates.length} question{props.candidates.length === 1 ? "" : "s"} match the filter, but you asked for {count}.{" "}
          <button class="btn small" onClick={() => setCount(props.candidates.length)}>Use {props.candidates.length}</button>{" "}
          or close this and widen the filter.
        </div>
      )}

      <h3>Preview ({result.picks.length})</h3>
      <ol class="pick-list">
        {result.picks.map((p) => (
          <li>
            <a href={`#/q/${p.q.id}`} target="_blank" rel="noopener">Q{p.q.qno}</a>{" "}
            <span class="muted small">{p.q.file_name} · {p.q.difficulty_code ? n.difficulty.get(p.q.difficulty_code) : "no label"}</span>
            <span class="small why"> — {p.reason.target}{p.reason.factors.length ? `; ${p.reason.factors.join(", ")}` : ""} (weight {p.reason.weight})</span>
          </li>
        ))}
      </ol>
      <div class="row end">
        <button class="btn" onClick={props.onClose}>Cancel</button>
        <button class="btn primary" disabled={busy || !result.picks.length || result.shortfall > 0} onClick={save}>Save paper ({result.picks.length})</button>
      </div>
    </Modal>
  );
}
