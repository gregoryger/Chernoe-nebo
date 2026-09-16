"""Шаг 6. Внешний контур края одним куском.

Маска, затемняющая всё вокруг игрового поля, строилась как многоугольник на
весь мир с 51 дырой — по внешнему кольцу каждого округа. Такая фигура не
триангулируется: на экране она то шла тёмными полосами, то накрывала карту
целиком.

Чистый контур берётся из уже скачанных данных, без сети. Внутренние границы
принадлежат двум округам сразу (в OSM это буквально один и тот же way),
внешние — ровно одному. Отбираем вторые и сшиваем в кольца.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from step3_build import dp_simplify, stitch  # noqa: E402

DATA = pathlib.Path(__file__).parent.parent / "data"
PARTS = DATA / "raw" / "geom"

parts = sorted(PARTS.glob("*.json"))
print(f"Округов на диске: {len(parts)}")

# way id -> сколько округов на него ссылаются; и его геометрия
owners: dict[int, int] = {}
geom: dict[int, list] = {}

for f in parts:
    rec = json.loads(f.read_text(encoding="utf-8"))
    seen = set()
    for m in rec["members"]:
        if m["role"] not in ("outer", ""):
            continue
        ref = m["ref"]
        if ref in seen:
            continue
        seen.add(ref)
        owners[ref] = owners.get(ref, 0) + 1
        geom[ref] = m["geometry"]

border = [ref for ref, n in owners.items() if n == 1]
inner = len(owners) - len(border)
print(f"Всего way: {len(owners)} | внешних (1 владелец): {len(border)} | внутренних: {inner}")

rings = stitch([geom[r] for r in border])
rings.sort(key=len, reverse=True)
print(f"Сшито колец: {len(rings)}, крупнейшее — {len(rings[0])} точек")

# Мелкие кольца — острова в Карском море и подобное. Для маски они не нужны:
# каждое лишнее кольцо возвращает ту же проблему с триангуляцией.
big = [r for r in rings if len(r) >= 40]
print(f"Оставлено колец от 40 точек: {len(big)}")

polys = []
before = after = 0
for r in big:
    before += len(r)
    s = dp_simplify([list(p) for p in r], 0.01)
    if s[0] != s[-1]:
        s.append(s[0])
    if len(s) < 4:
        continue
    after += len(s)
    polys.append([s])

out = DATA / "krai_outline.geojson"
out.write_text(json.dumps({
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {},
        "geometry": {"type": "MultiPolygon", "coordinates": polys},
    }],
}, ensure_ascii=False), encoding="utf-8")

print(f"Точек: {before} → {after}")
print(f"Сохранено: {out} ({out.stat().st_size / 1e3:.0f} КБ)")
