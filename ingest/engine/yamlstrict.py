"""YAML loading for profiles and jobs: duplicate keys are an error (section 6.3 step 1), and every value
remembers its line so lint errors can name a line (step 9)."""
from __future__ import annotations

import yaml

from util import StageFail


class _Loader(yaml.SafeLoader):
    pass


def _construct_mapping(loader: _Loader, node: yaml.MappingNode, deep: bool = False):
    seen = {}
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=True)
        if key in seen:
            raise StageFail(f"duplicate key {key!r} (first used on line {seen[key]})",
                            locator=f"line {key_node.start_mark.line + 1}", check="lint.duplicate_key")
        seen[key] = key_node.start_mark.line + 1
    return yaml.SafeLoader.construct_mapping(loader, node, deep=deep)


_Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


def _lines(node, path, out):
    out[path] = node.start_mark.line + 1
    if isinstance(node, yaml.MappingNode):
        for k, v in node.value:
            _lines(v, f"{path}/{k.value}", out)
    elif isinstance(node, yaml.SequenceNode):
        for i, v in enumerate(node.value):
            _lines(v, f"{path}/{i}", out)


def load(text: str, name: str = "<yaml>"):
    """Returns (data, lines) where lines maps a JSON-pointer-like path to a 1-based line number."""
    try:
        data = yaml.load(text, Loader=_Loader)  # noqa: S506 - _Loader is a SafeLoader
        root = yaml.compose(text, Loader=yaml.SafeLoader)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        raise StageFail(f"{name}: not valid YAML: {getattr(e, 'problem', e)}",
                        locator=f"line {mark.line + 1}" if mark else None, check="lint.yaml")
    lines: dict[str, int] = {}
    if root is not None:
        _lines(root, "", lines)
    return data, lines


def line_of(lines: dict[str, int], path: str) -> int | None:
    """Line of the deepest known ancestor of `path`."""
    while path and path not in lines:
        path = path.rsplit("/", 1)[0]
    return lines.get(path)
