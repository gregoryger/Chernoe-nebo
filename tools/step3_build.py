"""Шаг 3. Из сырых отношений OSM собрать два файла, которые читает игра.

  data/districts.geojson   — геометрия для MapLibre, упрощённая
  data/adjacency.json      — граф соседства с весами рёбер

Граф строится пересечением множеств way id. Соседние административные
отношения в OSM ссылаются на один и тот же way вдоль общей границы, поэтому
общая граница считается точно и без геометрических операций: длина общей
границы — это сумма длин общих way.
"""
import json
import math
import pathlib

RAW = pathlib.Path(__file__).parent.parent / "data" / "raw" / "geom"
OUT = pathlib.Path(__file__).parent.parent / "data"

# Допуск упрощения в градусах. ~0.008° по долготе на широте 60° — около 450 м.
SIMPLIFY_TOL = 0.008
R = 6371.0088  # средний радиус Земли, км


# ---------------------------------------------------------------- геометрия

def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def line_length(pts):
    return sum(haversine(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def ring_area(ring):
    """Площадь сферического многоугольника, км². Формула через избыток."""
    if len(ring) < 4:
        return 0.0
    total = 0.0
    for i in range(len(ring) - 1):
        lon1, lat1 = math.radians(ring[i][0]), math.radians(ring[i][1])
        lon2, lat2 = math.radians(ring[i + 1][0]), math.radians(ring[i + 1][1])
        total += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
    return abs(total * R * R / 2.0)


def dp_simplify(pts, tol):
    """Дуглас-Пейкер, итеративный (рекурсия на 36 тыс. точек переполняет стек)."""
    if len(pts) < 3:
        return pts[:]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = pts[lo]
        bx, by = pts[hi]
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        best, best_i = -1.0, -1
        for i in range(lo + 1, hi):
            px, py = pts[i]
            if denom == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, best_i = d, i
        if best > tol:
            keep[best_i] = True
            stack.append((lo, best_i))
            stack.append((best_i, hi))
    return [p for p, k in zip(pts, keep) if k]


def stitch(ways):
    """Сшить отрезки в замкнутые кольца по совпадающим концам."""
    segs = [list(map(tuple, w)) for w in ways if len(w) >= 2]
    rings, used = [], [False] * len(segs)
    ends = {}
    for i, s in enumerate(segs):
        ends.setdefault(s[0], []).append(i)
        ends.setdefault(s[-1], []).append(i)

    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        chain = segs[i][:]
        progress = True
        while progress and chain[0] != chain[-1]:
            progress = False
            for j in ends.get(chain[-1], []):
                if used[j]:
                    continue
                s = segs[j]
                if s[0] == chain[-1]:
                    chain += s[1:]
                elif s[-1] == chain[-1]:
                    chain += s[-2::-1]
                else:
                    continue
                used[j] = True
                progress = True
                break
        if len(chain) >= 4:
            if chain[0] != chain[-1]:
                chain.append(chain[0])  # замыкаем разрыв в исходных данных
            rings.append([list(p) for p in chain])
    return rings


# ---------------------------------------------------------------- загрузка

parts = sorted(RAW.glob("*.json"))
print(f"Читаю {len(parts)} районов...")

districts, way_len, way_owners = {}, {}, {}

for p in parts:
    rec = json.loads(p.read_text(encoding="utf-8"))
    rid = str(rec["id"])
    outer = []
    for m in rec["members"]:
        if m["role"] not in ("outer", "", "exclave"):
            continue
        outer.append(m["geometry"])
        wid = m["ref"]
        if wid not in way_len:
            way_len[wid] = line_length(m["geometry"])
        way_owners.setdefault(wid, set()).add(rid)
    districts[rid] = {
        "id": rid,
        "name": rec["name"],
        "tags": rec["tags"],
        "ways": {m["ref"] for m in rec["members"] if m["role"] in ("outer", "", "exclave")},
        "raw_outer": outer,
    }

# ------------------------------------------------------------ граф соседства

print("Строю граф соседства по общим way...")
shared = {}
for wid, owners in way_owners.items():
    if len(owners) < 2:
        continue
    owners = sorted(owners)
    for i in range(len(owners)):
        for j in range(i + 1, len(owners)):
            key = (owners[i], owners[j])
            shared[key] = shared.get(key, 0.0) + way_len[wid]

perimeter = {
    rid: sum(way_len[w] for w in d["ways"] if w in way_len) or 1.0
    for rid, d in districts.items()
}

adjacency = {rid: [] for rid in districts}
for (a, b), length in shared.items():
    adjacency[a].append({"to": b, "km": round(length, 1),
                         "w": round(min(1.0, length / perimeter[a]), 4)})
    adjacency[b].append({"to": a, "km": round(length, 1),
                         "w": round(min(1.0, length / perimeter[b]), 4)})
for rid in adjacency:
    adjacency[rid].sort(key=lambda e: -e["km"])

# --------------------------------------------------------- сборка геометрии

print("Сшиваю кольца и упрощаю...")
features = []
meta = {}
raw_pts = simp_pts = 0

for rid, d in districts.items():
    rings = stitch(d["raw_outer"])
    rings.sort(key=ring_area, reverse=True)
    area_km2 = ring_area(rings[0]) if rings else 0.0
    # мелкие острова (Таймыр) дают десятки колец — на игровой карте они шум
    # Порог должен быть относительным: абсолютный в десятки км² убивает
    # городские округа и ЗАТО целиком.
    rings = [r for r in rings if ring_area(r) > max(1.0, area_km2 * 0.002)]

    simplified = []
    for r in rings:
        raw_pts += len(r)
        s = dp_simplify(r, SIMPLIFY_TOL)
        if len(s) < 4:
            continue
        if s[0] != s[-1]:
            s.append(s[0])
        s = [[round(x, 4), round(y, 4)] for x, y in s]
        simp_pts += len(s)
        simplified.append([s])

    if not simplified:
        print(f"  ВНИМАНИЕ: {d['name']} — не удалось собрать кольца")
        continue

    total_area = sum(ring_area(poly[0]) for poly in simplified)
    flat = [pt for poly in simplified for pt in poly[0]]
    cx = sum(p[0] for p in flat) / len(flat)
    cy = sum(p[1] for p in flat) / len(flat)

    features.append({
        "type": "Feature",
        "id": int(rid),
        "properties": {"id": rid, "name": d["name"]},
        "geometry": {"type": "MultiPolygon", "coordinates": simplified},
    })
    meta[rid] = {
        "id": rid,
        "name": d["name"],
        "area": round(total_area),
        "centroid": [round(cx, 4), round(cy, 4)],
        "perimeter": round(perimeter[rid]),
        "neighbors": adjacency[rid],
    }

# ------------------------------------------------- анклавы и калибровка площади

def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
            if x < xi:
                inside = not inside
    return inside


geom_by_id = {f["properties"]["id"]: f["geometry"]["coordinates"] for f in features}

# Анклав (Норильск, Зеленогорск, ЗАТО) не делит way с окружающим округом, поэтому
# в графе повисает без рёбер: огонь в него не придёт и из него не выйдет.
# Связываем по вхождению центроида в чужой полигон.
for rid, m in meta.items():
    if m["neighbors"]:
        continue
    host = next(
        (oid for oid, polys in geom_by_id.items()
         if oid != rid and any(point_in_ring(m["centroid"], poly[0]) for poly in polys)),
        None,
    )
    if host is None:
        print(f"  ВНИМАНИЕ: {m['name']} остался без соседей")
        continue
    edge_km = round(m["perimeter"], 1)
    meta[rid]["neighbors"].append({"to": host, "km": edge_km, "w": 1.0})
    meta[host]["neighbors"].append({"to": rid, "km": edge_km,
                                    "w": round(min(1.0, edge_km / meta[host]["perimeter"]), 4)})
    print(f"  анклав: {m['name']} → вложен в {meta[host]['name']}")

# Сумма площадей выходит больше официальной: анклавы считаются и сами по себе,
# и внутри округов, которые их окружают. Игре важно, чтобы «выгорело N га»
# сравнивалось с реальными сводками, поэтому нормируем на официальную цифру.
OFFICIAL_KM2 = 2_366_797
computed = sum(m["area"] for m in meta.values())
scale = OFFICIAL_KM2 / computed
for m in meta.values():
    m["area"] = round(m["area"] * scale)
print(f"\nКалибровка площади: {computed:,} → {OFFICIAL_KM2:,} км² (×{scale:.4f})"
      .replace(",", " "))

OUT.mkdir(exist_ok=True)
gj = {"type": "FeatureCollection", "features": features}
(OUT / "districts.geojson").write_text(json.dumps(gj, ensure_ascii=False,
                                                  separators=(",", ":")), encoding="utf-8")
(OUT / "adjacency.json").write_text(json.dumps(meta, ensure_ascii=False,
                                               separators=(",", ":")), encoding="utf-8")

size = (OUT / "districts.geojson").stat().st_size
print(f"\nТочек: {raw_pts} → {simp_pts} (в {raw_pts / max(1, simp_pts):.1f} раза меньше)")
print(f"districts.geojson: {size / 1024:.0f} КБ, объектов {len(features)}")
print(f"Суммарная площадь: {sum(m['area'] for m in meta.values()):,} км²".replace(",", " "))
print(f"Рёбер в графе: {sum(len(m['neighbors']) for m in meta.values()) // 2}")

iso = [m["name"] for m in meta.values() if not m["neighbors"]]
if iso:
    print(f"БЕЗ СОСЕДЕЙ ({len(iso)}): {iso}")
