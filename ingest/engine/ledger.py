"""The coverage ledger (spec section 5.5, structural decision 3).

Every piece of source content is a *block*. Each block must end up claimed by a pack field or ignored with a
reason. A leftover block stops the run. The independent checker (ingest/checker/g3.mjs) re-reads the source by
its own route and compares it with this ledger, so the ledger is evidence, not a claim to be trusted.
"""
from __future__ import annotations

from util import StageFail, words

# How a claimed block reached the pack:
#   verbatim - the field's visible text must equal the block's text, token for token (checked by G3.compare)
#   derived  - the value was computed from the text (regex group, map, number): conserved, not token-compared
#   asset    - the block is a figure packaged as a file
MODES = ("verbatim", "derived", "asset")


class Ledger:
    def __init__(self):
        self.blocks: list[dict] = []
        self.claims: dict[int, list[dict]] = {}
        self.ignored: dict[int, dict] = {}
        self.rules: list[dict] = []          # one entry per ignore rule, with match counts
        self.added: list[dict] = []          # text the engine wrote that is not in the source
        self.stripped: list[dict] = []       # text the engine removed from the front of a field (labels, numbers)
        self.groups: dict[str, dict[str, list[str]]] = {}  # question -> field -> member fields compared together

    # ---- blocks
    def add_block(self, kind: str, text: str, locator: str, **extra) -> int:
        bid = len(self.blocks)
        self.blocks.append({"id": bid, "order": bid, "kind": kind, "text": text, "locator": locator, **extra})
        return bid

    # ---- claims
    def claim(self, bid: int, q: str | None, field: str, mode: str = "verbatim", shared: bool = False) -> None:
        if mode not in MODES:
            raise ValueError(mode)
        if bid in self.ignored:
            b = self.blocks[bid]
            raise StageFail(f"block is both ignored (rule {self.ignored[bid]['rule']}) and claimed by {field}",
                            locator=b["locator"], check="S2.coverage", hint="narrow the ignore rule or the field's selector")
        entry = {"q": q, "field": field, "mode": mode, "shared": shared}
        existing = self.claims.setdefault(bid, [])
        if entry not in existing:
            existing.append(entry)

    def ignore(self, bid: int, rule: int, reason: str) -> None:
        if bid in self.claims:
            b = self.blocks[bid]
            raise StageFail(f"block is both claimed and ignored (rule {rule})", locator=b["locator"], check="S2.coverage")
        self.ignored.setdefault(bid, {"rule": rule, "reason": reason})

    def add_literal(self, q: str | None, field: str, text: str, why: str) -> None:
        self.added.append({"q": q, "field": field, "text": text, "why": why})

    def strip_prefix(self, q: str | None, field: str, text: str, why: str) -> None:
        self.stripped.append({"q": q, "field": field, "text": text, "why": why})

    def group(self, q: str, field: str, members: list[str]) -> None:
        self.groups.setdefault(q, {})[field] = members

    # ---- results
    def problems(self) -> dict:
        unclaimed = [b for b in self.blocks if b["id"] not in self.claims and b["id"] not in self.ignored]
        double = []
        for bid, claims in self.claims.items():
            owners = {(c["q"], c["field"]) for c in claims if c["mode"] != "derived"}
            exclusive = {(c["q"], c["field"]) for c in claims if c["mode"] != "derived" and not c["shared"]}
            if len(exclusive) > 1:   # one owner, plus any number of claims declared shared
                double.append({"block": bid, "locator": self.blocks[bid]["locator"], "claims": sorted(f"{q}:{f}" for q, f in owners)})
        return {"unclaimed": unclaimed, "double": double}

    def rule_stats(self) -> list[dict]:
        stats = [dict(r, match_blocks=0, match_tokens=0) for r in self.rules]
        for bid, ig in self.ignored.items():
            s = stats[ig["rule"]]
            s["match_blocks"] += 1
            s["match_tokens"] += words(self.blocks[bid]["text"])
        return stats

    def as_dict(self) -> dict:
        out = []
        for b in self.blocks:
            row = dict(b)
            if b["id"] in self.ignored:
                row["status"], row["by"] = "ignored", self.ignored[b["id"]]
            elif b["id"] in self.claims:
                row["status"], row["by"] = "claimed", self.claims[b["id"]]
            else:
                row["status"] = "unclaimed"
            out.append(row)
        return {"blocks": out, "ignore_rules": self.rule_stats(), "added": self.added, "stripped": self.stripped, "groups": self.groups}
