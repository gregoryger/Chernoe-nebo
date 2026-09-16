"""Шаг 5. Геометрия крупных рек края — тех, что работают барьерами в симуляции.

Спутниковая подложка показывает реки сама, но игроку нужно видеть не всякую
воду, а именно ту, которая мешает огню. В модели барьер дают только крупные
реки, поэтому тянем их поимённо, а не все waterway=river подряд: последних
в крае десятки тысяч, и они утопили бы и загрузку, и кадр.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import overpass

DATA = pathlib.Path(__file__).parent.parent / "data"
RAW = DATA / "raw"

# Те же реки, что дают barrier в step4_attributes.py.
RIVERS = [
    "Енисей",
    "Ангара",
    "Подкаменная Тунгуска",
    "Нижняя Тунгуска",
    "Чулым",
    "Кан",
    "Кеть",
    "Курейка",
    "Хатанга",
    "Пясина",
]

krai_id = json.loads((RAW / "districts_list.json").read_text(encoding="utf-8"))["krai_id"]
names = "|".join(RIVERS)

print(f"Запрашиваю {len(RIVERS)} рек внутри края...")
data = overpass.query(f"""
[out:json][timeout:600];
rel({krai_id});map_to_area->.krai;
(
  way["waterway"="river"]["name"~"^({names})$"](area.krai);
  way["natural"="water"]["name"~"^({names})$"](area.krai);
);
out geom;
""")

ways = [e for e in data["elements"] if e["type"] == "way" and "geometry" in e]
print(f"  получено линий: {len(ways)}")


def simplify(pts: list[list[float]], tol: float) -> list[list[float]]:
    """Дуглас-Пейкер. Тот же алгоритм, что в step3_build.py."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        ax, ay = pts[lo]
        bx, by = pts[hi]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        worst, wi = 0.0, -1
        for i in range(lo + 1, hi):
            px, py = pts[i]
            dist = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if dist > worst:
                worst, wi = dist, i
        if wi >= 0 and worst > tol:
            keep[wi] = True
            stack.append((lo, wi))
            stack.append((wi, hi))
    return [p for p, k in zip(pts, keep) if k]


features = []
before = after = 0
by_name: dict[str, int] = {}

for w in ways:
    name = w.get("tags", {}).get("name", "?")
    pts = [[round(p["lon"], 4), round(p["lat"], 4)] for p in w["geometry"]]
    before += len(pts)
    pts = simplify(pts, 0.006)
    after += len(pts)
    if len(pts) < 2:
        continue
    by_name[name] = by_name.get(name, 0) + 1
    features.append({
        "type": "Feature",
        "properties": {"name": name},
        "geometry": {"type": "LineString", "coordinates": pts},
    })

out = DATA / "rivers.geojson"
out.write_text(
    json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
    encoding="utf-8",
)

print(f"  точек: {before} → {after}")
for n, c in sorted(by_name.items(), key=lambda kv: -kv[1]):
    print(f"    {n:<24} {c} сегм.")
print(f"\nСохранено: {out} ({out.stat().st_size / 1e3:.0f} КБ)")
