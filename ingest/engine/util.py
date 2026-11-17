"""Foundation library (work package W1): canonical JSON, hashing, atomic writes, deterministic zip,
verdict files, exit codes and structured logs.

Rules implemented here: R1 (determinism), R6 (hash everything), R10 (exit codes), R11 (structured logs),
R14 (no vacuous passes).
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
import tempfile
import unicodedata
import zlib
from pathlib import Path

ENGINE_VERSION = "0.1.0"

EXIT_PASS, EXIT_WARN, EXIT_FAIL, EXIT_USAGE, EXIT_INTERNAL = 0, 10, 20, 30, 40
ORDER = {"PASS": 0, "INFO": 1, "WARN": 2, "FAIL": 3}
EXIT_FOR = {"PASS": EXIT_PASS, "INFO": EXIT_PASS, "WARN": EXIT_WARN, "FAIL": EXIT_FAIL}


class StageFail(Exception):
    """A stage stopped rather than guessed (R2). Carries a locator and a next action (R9)."""

    def __init__(self, message: str, *, locator: str | None = None, check: str | None = None, hint: str | None = None):
        super().__init__(message)
        self.message, self.locator, self.check, self.hint = message, locator, check, hint

    def as_dict(self) -> dict:
        return {k: v for k, v in {"message": self.message, "locator": self.locator, "check": self.check, "next": self.hint}.items() if v}


class UsageError(Exception):
    pass


# --------------------------------------------------------------------------- canonical JSON and hashing
def nfc(value):
    """Recursively put every string (keys too) in Unicode NFC form."""
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [nfc(v) for v in value]
    if isinstance(value, dict):
        return {nfc(k): nfc(v) for k, v in value.items()}
    return value


def canon_bytes(obj, *, pretty: bool = False) -> bytes:
    """Byte-stable JSON: sorted keys, LF, UTF-8, NFC, no timestamps added by us."""
    if pretty:
        text = json.dumps(nfc(obj), sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    else:
        text = json.dumps(nfc(obj), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return text.encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_obj(obj) -> str:
    return sha256_bytes(canon_bytes(obj))


def atomic_write(path: Path, data: bytes) -> None:
    """Write to a temporary file in the same folder, then rename: a killed process leaves no partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_json(path: Path, obj, *, pretty: bool = True) -> str:
    data = canon_bytes(obj, pretty=pretty)
    atomic_write(path, data)
    return sha256_bytes(data)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- deterministic zip (R1)
def stored_zip(entries: dict[str, bytes]) -> bytes:
    """A zip with stored (uncompressed) entries, sorted paths and a fixed 1980-01-01 time.

    Written by hand so that no zip library version can change the bytes.
    """
    out, central, offset = bytearray(), bytearray(), 0
    dos_time, dos_date = 0, (0 << 9) | (1 << 5) | 1  # 1980-01-01 00:00:00
    for name in sorted(entries):
        if name.startswith("/") or ".." in name.split("/"):
            raise StageFail(f"unsafe path in pack zip: {name!r}")
        data, raw = entries[name], name.encode("utf-8")
        crc = zlib.crc32(data) & 0xFFFFFFFF
        local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0x0800, 0, dos_time, dos_date, crc, len(data), len(data), len(raw), 0)
        out += local + raw + data
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0x0800, 0, dos_time, dos_date, crc, len(data), len(data),
                               len(raw), 0, 0, 0, 0, 0, offset) + raw
        offset += len(local) + len(raw) + len(data)
    end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(central), offset, 0)
    return bytes(out + central + end)


def pack_identity(entries: dict[str, bytes]) -> str:
    """SHA-256 of the sorted list of (path, size, sha256): independent of zip bytes."""
    listing = [[name, len(entries[name]), sha256_bytes(entries[name])] for name in sorted(entries)]
    return sha256_obj(listing)


# --------------------------------------------------------------------------- verdicts (section 5.2)
class Verdict:
    """One gate's verdict file. Every check runs even after one fails; status is the worst check."""

    def __init__(self, gate: str):
        self.gate, self.checks, self.selftest = gate, [], None

    def add(self, check_id: str, status: str, message: str, *, examined: int, expected: int | None = None,
            locator: str | None = None, details=None, zero_ok: bool = False) -> str:
        if status not in ORDER:
            raise ValueError(status)
        # R14: fewer examined than expected, or zero examined where zero is implausible, is a FAIL.
        if status in ("PASS", "INFO"):
            if expected is not None and examined < expected:
                status, message = "FAIL", f"vacuous: examined {examined} of {expected} expected. {message}"
            elif examined == 0 and not zero_ok:
                status, message = "FAIL", f"vacuous: examined nothing. {message}"
        entry = {"id": check_id, "status": status, "message": message, "examined": examined, "expected": expected}
        if locator:
            entry["locator"] = locator
        if details is not None:
            entry["details"] = details
        self.checks.append(entry)
        return status

    @property
    def status(self) -> str:
        worst = "PASS"
        for c in self.checks:
            if ORDER[c["status"]] > ORDER[worst]:
                worst = c["status"]
        if self.selftest and self.selftest.get("status") == "FAIL":
            worst = "FAIL"
        return worst

    def as_dict(self) -> dict:
        return {"gate": self.gate, "selftest": self.selftest, "status": self.status, "checks": self.checks}

    def write(self, path: Path) -> str:
        return write_json(path, self.as_dict())


# --------------------------------------------------------------------------- logs (R11)
_LOG_CTX = {"run_id": None, "stage": None, "json": False}


def log_context(**kw) -> None:
    _LOG_CTX.update(kw)


def log(level: str, event: str, **fields) -> None:
    """One JSON line per event on stderr. Never log secrets (nothing here ever reads one)."""
    line = {"level": level, "run_id": _LOG_CTX["run_id"], "stage": _LOG_CTX["stage"], "event": event, **fields}
    sys.stderr.write(json.dumps(line, ensure_ascii=False, sort_keys=True) + "\n")


def words(text: str) -> int:
    return len(text.split())
