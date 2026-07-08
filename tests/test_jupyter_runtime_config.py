from scripts.jupyter_client import parse_runtime_config


def test_parse_runtime_config_accepts_dict() -> None:
    assert parse_runtime_config({"target_file": "a.parquet"}) == {"target_file": "a.parquet"}


def test_parse_runtime_config_accepts_json_string() -> None:
    assert parse_runtime_config('{"target_file": "a.parquet"}') == {"target_file": "a.parquet"}


def test_parse_runtime_config_empty_values() -> None:
    assert parse_runtime_config(None) == {}
    assert parse_runtime_config("") == {}
