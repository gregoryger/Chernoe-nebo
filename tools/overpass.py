"""Тонкая обёртка над Overpass API.

Два решения, продиктованные окружением (Windows + Git Bash):

1. Запросы отправляем через curl, а не через urllib. У Python здесь устаревшее
   хранилище корневых сертификатов, и overpass-api.de отваливается по
   CERTIFICATE_VERIFY_FAILED. curl использует системное хранилище Windows
   (Schannel) и ходит туда нормально.

2. Тело запроса кладём во временный файл в UTF-8 и передаём как
   `--data-urlencode data@file`. Кириллица в аргументах командной строки
   портится ещё до того, как её увидит curl.
"""
import json
import pathlib
import subprocess
import tempfile
import time

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]


def query(ql: str, attempts: int = 6) -> dict:
    """Выполнить Overpass QL и вернуть разобранный JSON."""
    last = None
    with tempfile.TemporaryDirectory() as tmp:
        qf = pathlib.Path(tmp) / "query.overpassql"
        of = pathlib.Path(tmp) / "out.json"
        qf.write_text(ql, encoding="utf-8")

        for attempt in range(attempts):
            endpoint = ENDPOINTS[attempt % len(ENDPOINTS)]
            proc = subprocess.run(
                [
                    "curl", "-s", "--compressed", "--max-time", "900",
                    "-A", "chernoe-nebo/0.1 (game prototype, educational)",
                    "-X", "POST", endpoint,
                    "--data-urlencode", f"data@{qf}",
                    "-o", str(of),
                ],
                capture_output=True,
            )
            if proc.returncode == 0 and of.exists() and of.stat().st_size > 0:
                try:
                    return json.loads(of.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    head = of.read_text(encoding="utf-8", errors="replace")[:160]
                    last = f"не JSON: {head!r}"
            else:
                last = f"curl rc={proc.returncode} {proc.stderr.decode(errors='replace')[:120]}"

            wait = min(15 * (attempt + 1), 60)
            print(f"    попытка {attempt + 1} ({endpoint.split('/')[2]}): {last}; жду {wait} с")
            time.sleep(wait)

    raise RuntimeError(f"Overpass недоступен после {attempts} попыток: {last}")
