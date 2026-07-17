from __future__ import annotations

import json
import os
import secrets
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
STORE: dict[str, dict[str, Any]] = {}

mcp = FastMCP("synth-mcp")


def _output_dir() -> Path:
    env = os.environ.get("SYNTH_OUTPUT_DIR")
    if env:
        return Path(env).expanduser().resolve()

    config_path = PLUGIN_ROOT / "config.local.json"
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            config = None
        if isinstance(config, dict):
            output_dir = config.get("output_dir")
            if isinstance(output_dir, str) and output_dir.strip():
                return Path(output_dir).expanduser().resolve()

    return Path.cwd().resolve() / "specs"


def _max_collections() -> int | None:
    raw = os.environ.get("SYNTH_MAX_COLLECTIONS")
    if raw is None or not raw.strip():
        return None
    try:
        value = int(raw.strip())
    except ValueError:
        return None
    return value if value > 0 else None


def _as_string(value: Any) -> str:
    return "" if value is None else str(value)


def _detect_field_map(data: dict[str, Any], overrides: dict[str, str] | None = None) -> dict[str, str]:
    overrides = overrides or {}
    items_key = overrides.get("items_key", "items")
    if not isinstance(data.get(items_key), list):
        array_key = next((key for key, value in data.items() if isinstance(value, list)), None)
        if array_key:
            items_key = array_key

    items = data.get(items_key)
    if not isinstance(items, list) or not items:
        raise ValueError(f'No items array found in data (tried key "{items_key}")')

    sample = items[0]
    if not isinstance(sample, dict):
        raise ValueError("Items array must contain objects")

    def find_field(candidates: list[str]) -> str | None:
        for candidate in candidates:
            if candidate in sample:
                return candidate
        return None

    def find_id_field() -> str:
        direct = find_field(["id", "tweet_id", "post_id", "article_id", "item_id", "uid", "key"])
        if direct:
            return direct
        suffixed = next((key for key in sample if key.endswith("_id")), None)
        return suffixed or "id"

    return {
        "items_key": items_key,
        "id_field": overrides.get("id_field", find_id_field()),
        "content_field": overrides.get(
            "content_field",
            find_field(["content", "body", "text", "description", "full_text", "article_text"]) or "content",
        ),
        "title_field": overrides.get(
            "title_field",
            find_field(["summary", "title", "name", "headline", "subject"]) or "title",
        ),
        "tags_field": overrides.get(
            "tags_field",
            find_field(["tags", "categories", "labels", "keywords", "topics"]) or "tags",
        ),
        "author_field": overrides.get(
            "author_field",
            find_field(["profile", "author", "user", "creator", "poster"]) or "",
        ),
        "date_field": overrides.get(
            "date_field",
            find_field(["date", "created_at", "published", "timestamp", "published_at", "created"]) or "",
        ),
        "url_field": overrides.get(
            "url_field",
            find_field(["url", "link", "href", "source_url", "permalink"]) or "",
        ),
    }


def _normalize_item(raw: dict[str, Any], field_map: dict[str, str], index: int) -> dict[str, Any]:
    def get(field: str | None) -> Any:
        return raw.get(field) if field else None

    raw_author = get(field_map.get("author_field") or None)
    author: dict[str, Any] | None = None
    if isinstance(raw_author, str):
        author = {"name": raw_author}
    elif isinstance(raw_author, dict):
        author = {
            "name": _as_string(raw_author.get("display_name") or raw_author.get("name") or raw_author.get("username") or raw_author.get("handle") or "Unknown"),
        }
        if raw_author.get("handle") or raw_author.get("username"):
            author["handle"] = _as_string(raw_author.get("handle") or raw_author.get("username"))
        if raw_author.get("bio"):
            author["bio"] = _as_string(raw_author.get("bio"))

    known_fields = {
        field_map["id_field"],
        field_map["content_field"],
        field_map["title_field"],
        field_map["tags_field"],
        field_map["author_field"],
        field_map["date_field"],
        field_map["url_field"],
    }
    known_fields.discard("")

    metadata: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in known_fields:
            metadata[key] = value

    raw_tags = get(field_map["tags_field"])
    if isinstance(raw_tags, list):
        tags = [_as_string(tag) for tag in raw_tags]
    elif raw_tags is None:
        tags = []
    else:
        tags = [_as_string(raw_tags)]

    content = _as_string(get(field_map["content_field"]))
    raw_title = get(field_map["title_field"])
    if raw_title is not None and raw_title != content:
        title = _as_string(raw_title)
    elif content:
        title = content[:120] + ("..." if len(content) > 120 else "")
    else:
        title = f"Item {index}"

    return {
        "id": _as_string(get(field_map["id_field"]) or f"item_{index}"),
        "title": title,
        "content": content,
        "url": get(field_map["url_field"]) if field_map["url_field"] else None,
        "date": get(field_map["date_field"]) if field_map["date_field"] else None,
        "author": author,
        "tags": tags,
        "metadata": metadata,
    }


def load_collection(file_path: str, name: str | None = None, field_overrides: dict[str, str] | None = None) -> dict[str, Any]:
    abs_path = Path(file_path).expanduser().resolve()
    raw = json.loads(abs_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Collection root must be a JSON object")

    field_map = _detect_field_map(raw, field_overrides)
    raw_items = raw[field_map["items_key"]]
    if not isinstance(raw_items, list):
        raise ValueError(f'Field "{field_map["items_key"]}" must be an array')

    items = []
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            raise ValueError("Collection items must be objects")
        items.append(_normalize_item(raw_item, field_map, index))

    tag_set = sorted({tag for item in items for tag in item["tags"]})
    collection = {
        "name": name or abs_path.stem,
        "file_path": str(abs_path),
        "loaded_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "item_count": len(items),
        "items": items,
        "field_map": field_map,
        "raw_metadata": raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {},
        "available_tags": tag_set,
    }
    STORE[collection["name"]] = collection

    max_collections = _max_collections()
    if max_collections is not None:
        # Opt-in cap (SYNTH_MAX_COLLECTIONS): refresh load recency, then
        # evict whole least-recently-loaded collections beyond the cap.
        STORE[collection["name"]] = STORE.pop(collection["name"])
        while len(STORE) > max_collections:
            del STORE[next(iter(STORE))]

    return collection


def _matches_filters(item: dict[str, Any], tags: list[str] | None, search: str | None, fields: dict[str, str] | None) -> bool:
    if tags:
        lower_tags = [tag.lower() for tag in item["tags"]]
        if not any(tag.lower() in lower_tags for tag in tags):
            return False
    if search:
        needle = search.lower()
        haystack = " ".join([item["title"], item["content"], *item["tags"]]).lower()
        if needle not in haystack:
            return False
    if fields:
        for key, value in fields.items():
            if value.lower() not in _as_string(item["metadata"].get(key)).lower():
                return False
    return True


def query_items(
    collection: str | None = None,
    tags: list[str] | None = None,
    search: str | None = None,
    fields: dict[str, str] | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    targets = [STORE.get(collection)] if collection and STORE.get(collection) else list(STORE.values())
    if collection and not targets:
        raise ValueError(f"Collection '{collection}' not loaded. Use synth_load_collection first.")
    results: list[dict[str, Any]] = []
    for col in targets:
        if not col:
            continue
        for item in col["items"]:
            if not _matches_filters(item, tags, search, fields):
                continue
            results.append({"collection": col["name"], "item": item})
            if len(results) >= limit:
                return results
    return results


def get_items(collection_name: str, item_ids: list[str]) -> list[dict[str, Any]]:
    col = STORE.get(collection_name)
    if not col:
        raise ValueError(f"Collection '{collection_name}' not loaded")
    items = []
    for item_id in item_ids:
        match = next((item for item in col["items"] if item["id"] == item_id), None)
        if not match:
            raise ValueError(f"Item '{item_id}' not found in collection '{collection_name}'")
        items.append(match)
    return items


def list_collections() -> list[dict[str, Any]]:
    return [
        {
            "name": col["name"],
            "item_count": col["item_count"],
            "file_path": col["file_path"],
            "loaded_at": col["loaded_at"],
            "available_tags": col["available_tags"],
        }
        for col in STORE.values()
    ]


def get_collection(name: str) -> dict[str, Any] | None:
    return STORE.get(name)


def create_spec_synthesis(
    title: str,
    source_groups: list[dict[str, Any]],
    options: dict[str, str] | None = None,
) -> tuple[dict[str, Any], str]:
    options = options or {}
    spec_id = secrets.token_hex(16)
    created_date = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date().isoformat()

    all_items: list[dict[str, Any]] = []
    for group in source_groups:
        for item in group["items"]:
            all_items.append(
                {
                    "item": item,
                    "collection": group["collection"],
                    "relevance": group.get("relevance_notes", {}).get(item["id"], ""),
                }
            )

    spec_sources = [
        {
            "collection": entry["collection"],
            "item_id": entry["item"]["id"],
            "title": entry["item"]["title"],
            "relevance": entry["relevance"],
        }
        for entry in all_items
    ]

    source_content_lines: list[str] = []
    for entry in all_items:
        item = entry["item"]
        lines = [f"=== Source: {item['title']} ===", f"Collection: {entry['collection']} | ID: {item['id']}"]
        author = item.get("author")
        if isinstance(author, dict):
            handle = f" ({author['handle']})" if author.get("handle") else ""
            lines.append(f"Author: {author['name']}{handle}")
            if author.get("bio"):
                lines.append(f"Bio: {author['bio']}")
        if item.get("date"):
            lines.append(f"Date: {item['date']}")
        if item.get("url"):
            lines.append(f"URL: {item['url']}")
        if item["tags"]:
            lines.append(f"Tags: {', '.join(item['tags'])}")
        lines.append("")
        lines.append(item["content"])
        for key in ["strategy_type", "instrument", "platform", "dependencies", "engagement", "embedded_content", "has_article_content"]:
            if item["metadata"].get(key) is not None:
                value = item["metadata"][key]
                lines.append(f"{key}: {json.dumps(value) if isinstance(value, (dict, list)) else str(value)}")
        source_content_lines.append("\n".join(lines))

    tag_counts = Counter(tag for entry in all_items for tag in entry["item"]["tags"])
    shared_tags = sorted(
        ((tag, count) for tag, count in tag_counts.items() if count > 1),
        key=lambda pair: pair[1],
        reverse=True,
    )

    all_deps: set[str] = set()
    all_platforms: set[str] = set()
    all_instruments: set[str] = set()
    for entry in all_items:
        item = entry["item"]
        deps = item["metadata"].get("dependencies")
        if isinstance(deps, list):
            all_deps.update(_as_string(dep) for dep in deps)
        if item["metadata"].get("platform"):
            all_platforms.add(_as_string(item["metadata"]["platform"]))
        if item["metadata"].get("instrument"):
            all_instruments.add(_as_string(item["metadata"]["instrument"]))

    template = {
        "spec_id": spec_id,
        "title": title,
        "created_date": created_date,
        "updated_date": created_date,
        "version": "1.0",
        "status": "draft",
        "domain": options.get("domain"),
        "spec_type": options.get("spec_type", "implementation"),
        "sources": spec_sources,
        "overview": {
            "description": "",
            "objectives": [],
            "constraints": [options["focus"]] if options.get("focus") else [],
            "assumptions": [],
        },
        "architecture": {
            "components": [],
            "data_flow": "",
            "integration_points": sorted(all_deps | all_platforms),
        },
        "implementation": {
            "phases": [],
            "tech_stack": sorted(all_deps),
            "complexity": "medium",
        },
        "risks": [],
        "success_criteria": [],
        "notes": "",
    }

    synthesis_parts = [
        f"# Design Spec Synthesis: {title}",
        "",
        f"**Spec ID:** {spec_id}",
        f"**Type:** {options.get('spec_type', 'implementation')}",
        f"**Domain:** {options['domain']}" if options.get("domain") else None,
        f"**Focus:** {options['focus']}" if options.get("focus") else None,
        "",
        f"## Source Material ({len(all_items)} items from {len(source_groups)} collection(s))",
        "",
        "\n\n---\n\n".join(source_content_lines),
        "",
        "## Cross-Reference Analysis",
        "",
        f"**Shared tags:** {', '.join(f'{tag} ({count})' for tag, count in shared_tags) or 'None'}",
        f"**Platforms:** {', '.join(sorted(all_platforms)) or 'None'}",
        f"**Instruments:** {', '.join(sorted(all_instruments)) or 'None'}",
        f"**Dependencies:** {', '.join(sorted(all_deps)) or 'None'}",
        "",
        "## Spec Template",
        "",
        "Complete this spec by synthesising the source material above.",
        "Fill in all empty strings and arrays. Return the full JSON object.",
        "",
        "```json",
        json.dumps(template, indent=2),
        "```",
    ]
    synthesis = "\n".join(part for part in synthesis_parts if part is not None)

    return template, synthesis


def _save_spec(spec: dict[str, Any], output_dir: str | None = None) -> Path:
    directory = Path(output_dir).expanduser().resolve() if output_dir else _output_dir()
    directory.mkdir(parents=True, exist_ok=True)
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in spec["title"]).strip("-")
    slug = "-".join(part for part in slug.split("-") if part)[:60]
    file_path = directory / f"{slug}--{spec['spec_id'][:8]}.json"
    spec["updated_date"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date().isoformat()
    file_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    return file_path


def _list_specs(directory: str | None = None) -> list[dict[str, Any]]:
    dir_path = Path(directory).expanduser().resolve() if directory else _output_dir()
    if not dir_path.exists():
        return []
    results: list[dict[str, Any]] = []
    for file_path in sorted(dir_path.glob("*.json")):
        try:
            spec = json.loads(file_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(spec, dict) or "spec_id" not in spec:
            continue
        results.append(
            {
                "spec_id": spec.get("spec_id", ""),
                "title": spec.get("title", ""),
                "created_date": spec.get("created_date", ""),
                "status": spec.get("status", ""),
                "spec_type": spec.get("spec_type", ""),
                "source_count": len(spec.get("sources", []) or []),
                "file_path": str(file_path),
            }
        )
    return results


@mcp.tool()
def synth_load_collection(
    file_path: str,
    name: str | None = None,
    items_key: str | None = None,
    id_field: str | None = None,
    content_field: str | None = None,
    title_field: str | None = None,
    tags_field: str | None = None,
) -> str:
    overrides = {
        key: value
        for key, value in {
            "items_key": items_key,
            "id_field": id_field,
            "content_field": content_field,
            "title_field": title_field,
            "tags_field": tags_field,
        }.items()
        if value
    }
    col = load_collection(file_path, name, overrides or None)
    lines = [
        f'Collection "{col["name"]}" loaded successfully',
        f'  Items: {col["item_count"]}',
        f'  Source: {col["file_path"]}',
        f'  Field map: {json.dumps(col["field_map"])}',
        "",
        f'  Tags ({len(col["available_tags"])}): {", ".join(col["available_tags"])}',
        "",
        "  First 5 items:",
    ]
    for item in col["items"][:5]:
        tag_suffix = f' ({", ".join(item["tags"][:4])})' if item["tags"] else ""
        lines.append(f'    [{item["id"]}] {item["title"]}{tag_suffix}')
    if col["item_count"] > 5:
        lines.append(f'    ... and {col["item_count"] - 5} more')
    return "\n".join(lines)


@mcp.tool()
def synth_query(
    collection: str | None = None,
    tags: list[str] | None = None,
    search: str | None = None,
    fields: dict[str, str] | None = None,
    limit: int = 20,
) -> str:
    results = query_items(collection, tags, search, fields, limit)
    if not results:
        return "No matching items found."
    lines = ["Found {} item(s):".format(len(results)), ""]
    for entry in results:
        item = entry["item"]
        lines.append(f'[{entry["collection"]}/{item["id"]}] {item["title"]}')
        if item.get("author"):
            author = item["author"]
            handle = f' ({author["handle"]})' if author.get("handle") else ""
            lines.append(f'  Author: {author["name"]}{handle}')
        if item["tags"]:
            lines.append(f'  Tags: {", ".join(item["tags"])}')
        if item["metadata"].get("strategy_type"):
            lines.append(f'  Strategy: {item["metadata"]["strategy_type"]}')
        if item["metadata"].get("platform"):
            lines.append(f'  Platform: {item["metadata"]["platform"]}')
        lines.append("")
    return "\n".join(lines)


@mcp.tool()
def synth_get_items(collection: str, item_ids: list[str]) -> str:
    if not collection or not item_ids:
        raise ValueError("collection and item_ids are required")
    items = get_items(collection, item_ids)
    lines = []
    for item in items:
        parts = [f'=== {item["title"]} ({item["id"]}) ===']
        if item.get("author"):
            author = item["author"]
            handle = f' ({author["handle"]})' if author.get("handle") else ""
            parts.append(f'Author: {author["name"]}{handle}')
            if author.get("bio"):
                parts.append(f'Bio: {author["bio"]}')
        if item.get("date"):
            parts.append(f'Date: {item["date"]}')
        if item.get("url"):
            parts.append(f'URL: {item["url"]}')
        if item["tags"]:
            parts.append(f'Tags: {", ".join(item["tags"])}')
        parts.append("")
        parts.append(item["content"])
        parts.append("")
        for key, value in item["metadata"].items():
            parts.append(f"{key}: {json.dumps(value) if isinstance(value, (dict, list)) else value}")
        lines.append("\n".join(parts))
    return "\n\n---\n\n".join(lines)


@mcp.tool()
def synth_create_spec(
    title: str,
    items: list[dict[str, Any]],
    spec_type: str | None = None,
    domain: str | None = None,
    focus: str | None = None,
) -> str:
    if not title or not items:
        raise ValueError("title and items are required")

    by_collection: dict[str, dict[str, Any]] = {}
    for entry in items:
        collection = entry.get("collection")
        item_id = entry.get("item_id")
        if not collection or not item_id:
            raise ValueError("Each item must have collection and item_id")
        payload = by_collection.setdefault(collection, {"ids": [], "relevance": {}})
        payload["ids"].append(item_id)
        if entry.get("relevance"):
            payload["relevance"][item_id] = entry["relevance"]

    source_groups = []
    for collection_name, payload in by_collection.items():
        source_groups.append(
            {
                "collection": collection_name,
                "items": get_items(collection_name, payload["ids"]),
                "relevance_notes": payload["relevance"],
            }
        )

    _, synthesis_prompt = create_spec_synthesis(title, source_groups, {"spec_type": spec_type or "", "domain": domain or "", "focus": focus or ""})
    return synthesis_prompt


@mcp.tool()
def synth_save_spec(spec: dict[str, Any], output_dir: str | None = None) -> str:
    if not spec or not spec.get("spec_id") or not spec.get("title"):
        raise ValueError("spec must have spec_id and title")
    file_path = _save_spec(dict(spec), output_dir)
    return f'Spec saved: {file_path}\n  Title: {spec["title"]}\n  Status: {spec.get("status", "")}\n  Sources: {len(spec.get("sources", []) or [])}'


@mcp.tool()
def synth_list_specs(directory: str | None = None) -> str:
    specs = _list_specs(directory)
    if not specs:
        return "No saved specs found."
    lines = [f"{len(specs)} saved spec(s):", ""]
    for spec in specs:
        lines.append(f'[{spec["spec_id"][:8]}] {spec["title"]}')
        lines.append(
            f'  Type: {spec["spec_type"]} | Status: {spec["status"]} | Sources: {spec["source_count"]} | Created: {spec["created_date"]}'
        )
        lines.append(f'  File: {spec["file_path"]}')
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    print("synth-mcp: MCP server started", file=sys.stderr)
    mcp.run()
