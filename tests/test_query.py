"""Collection targeting in ``query_items`` (the ``synth_query`` tool path).

A named collection must be queried exclusively, and naming a collection that
is not loaded must raise — never silently fall back to querying every loaded
collection. Querying all collections happens only when the caller passes no
collection name.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from synth_mcp.server import STORE, load_collection, query_items


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


def test_named_but_not_loaded_raises(tmp_path: Path) -> None:
    load_collection(write_collection(tmp_path, "alpha"))
    load_collection(write_collection(tmp_path, "beta"))
    with pytest.raises(ValueError) as exc_info:
        query_items(collection="gamma")
    message = str(exc_info.value)
    assert "gamma" in message
    assert "alpha" in message
    assert "beta" in message


def test_named_with_empty_store_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError) as exc_info:
        query_items(collection="gamma")
    message = str(exc_info.value)
    assert "gamma" in message
    assert "none" in message


def test_named_and_loaded_queries_only_that_collection(tmp_path: Path) -> None:
    load_collection(write_collection(tmp_path, "alpha"))
    load_collection(write_collection(tmp_path, "beta"))
    results = query_items(collection="alpha")
    assert len(results) == 1
    assert all(entry["collection"] == "alpha" for entry in results)


def test_no_name_queries_all_collections(tmp_path: Path) -> None:
    load_collection(write_collection(tmp_path, "alpha"))
    load_collection(write_collection(tmp_path, "beta"))
    results = query_items()
    assert {entry["collection"] for entry in results} == {"alpha", "beta"}


def test_no_name_with_empty_store_returns_empty(tmp_path: Path) -> None:
    assert query_items() == []
