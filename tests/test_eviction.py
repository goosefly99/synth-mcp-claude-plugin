"""Eviction cap for the module-level collection ``STORE``.

``SYNTH_MAX_COLLECTIONS`` is opt-in: unset (the default) preserves the
historical unlimited behavior byte-for-byte; set to a positive integer, each
``load_collection`` evicts whole least-recently-loaded collections beyond the
cap. Re-loading a collection refreshes its load recency.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from synth_mcp.server import STORE, load_collection


def write_collection(tmp_path: Path, name: str) -> str:
    data = {"items": [{"id": "1", "content": f"{name} content", "title": name, "tags": []}]}
    file_path = tmp_path / f"{name}.json"
    file_path.write_text(json.dumps(data), encoding="utf-8")
    return str(file_path)


@pytest.fixture(autouse=True)
def clean_store() -> Iterator[None]:
    STORE.clear()
    yield
    STORE.clear()


def test_unset_cap_keeps_all_collections(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SYNTH_MAX_COLLECTIONS", raising=False)
    for name in ("a", "b", "c"):
        load_collection(write_collection(tmp_path, name))
    assert list(STORE) == ["a", "b", "c"]


def test_cap_evicts_least_recently_loaded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SYNTH_MAX_COLLECTIONS", "2")
    for name in ("a", "b", "c"):
        load_collection(write_collection(tmp_path, name))
    assert list(STORE) == ["b", "c"]


def test_reload_refreshes_load_recency(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SYNTH_MAX_COLLECTIONS", "2")
    path_a = write_collection(tmp_path, "a")
    load_collection(path_a)
    load_collection(write_collection(tmp_path, "b"))
    load_collection(path_a)  # "b" is now the least-recently-loaded
    load_collection(write_collection(tmp_path, "c"))
    assert list(STORE) == ["a", "c"]


def test_invalid_or_nonpositive_cap_is_ignored(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for raw in ("not-a-number", "0", "-3", "  "):
        STORE.clear()
        monkeypatch.setenv("SYNTH_MAX_COLLECTIONS", raw)
        for name in ("a", "b", "c"):
            load_collection(write_collection(tmp_path, name))
        assert len(STORE) == 3
