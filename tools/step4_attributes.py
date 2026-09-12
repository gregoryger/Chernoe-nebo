"""Шаг 4. Собрать атрибуты районов и барьеры рёбер → data/districts.meta.json.

Что откуда:
  население    OSM, узлы place=city|town|village с тегом population, разносим
               по районам точкой-в-полигоне и суммируем
  аэродромы    OSM aeroway=aerodrome
  дороги       OSM highway=trunk|primary|secondary → плотность → access
  реки         OSM waterway=river, крупные именованные → барьеры рёбер
  лесистость   КУРИРУЕМАЯ ТАБЛИЦА, см. FOREST ниже

Про лесистость честно: правильный источник — зональная статистика по ESA
WorldCover 10 м, но это десятки гигабайт тайлов на площадь края и отдельный
растровый стек. Для прототипа взята таблица по географическому характеру
округов; она помечена как приближение и заменяется на реальную зональную
статистику без изменений в остальном коде.
"""
import json
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import overpass

DATA = pathlib.Path(__file__).parent.parent / "data"
CACHE = DATA / "raw" / "cache"
CACHE.mkdir(parents=True, exist_ok=True)
KRAI = 190090
R = 6371.0088


def cached(name: str, ql: str) -> dict:
    """Overpass-запрос с кэшем на диске: шаг перезапускается без перекачки."""
    f = CACHE / f"{name}.json"
    if f.exists() and f.stat().st_size > 100:
        print(f"  {name}: из кэша")
        return json.loads(f.read_text(encoding="utf-8"))
    print(f"  {name}: запрашиваю...", end="", flush=True)
    data = overpass.query(ql)
    f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f" ok, элементов {len(data['elements'])}")
    return data


def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y):
            if x < x1 + (y - y1) / (y2 - y1) * (x2 - x1):
                inside = not inside
    return inside


# --------------------------------------------------- лесистость и тип горючего
# fuelClass: 1 тундра · 2 северная тайга · 3 средняя тайга · 4 сосняк · 5 лесостепь
# ПРИБЛИЖЕНИЕ — заменяется зональной статистикой по ESA WorldCover.
FOREST = {
    "Таймырский Долгано-Ненецкий муниципальный округ": (0.04, 1),
    "городской округ Норильск":                        (0.02, 1),
    "Эвенкийский муниципальный округ":                 (0.72, 2),
    "Туруханский муниципальный округ":                 (0.70, 2),
    "Северо-Енисейский муниципальный округ":           (0.84, 3),
    "Енисейский муниципальный округ":                  (0.86, 3),
    "Мотыгинский муниципальный округ":                 (0.85, 3),
    "Кежемский муниципальный округ":                   (0.83, 3),
    "Богучанский муниципальный округ":                 (0.86, 3),
    "Абанский муниципальный округ":                    (0.62, 3),
    "Дзержинско-Тасеевский муниципальный округ":       (0.68, 3),
    "Бирилюсский муниципальный округ":                 (0.78, 3),
    "Казачинско-Пировский муниципальный округ":        (0.76, 3),
    "Большемуртинско-Сухобузимский муниципальный округ": (0.58, 4),
    "Емельяновский муниципальный округ":               (0.55, 4),
    "Манско-Уярский муниципальный округ":              (0.66, 4),
    "Ирбейско-Саянский муниципальный округ":           (0.72, 4),
    "Иланско-Нижнеингашский муниципальный округ":      (0.64, 3),
    "Канский муниципальный округ":                     (0.38, 4),
    "Рыбинский муниципальный округ":                   (0.40, 4),
    "Козульский муниципальный округ":                  (0.70, 4),
    "Ачинский муниципальный округ":                    (0.30, 5),
    "Боготольский муниципальный округ":                (0.40, 4),
    "Назаровский муниципальный округ":                 (0.22, 5),
    "Ужурский муниципальный округ":                    (0.20, 5),
    "Шарыповский муниципальный округ":                 (0.28, 5),
    "Балахтинско-Новосёловский муниципальный округ":   (0.42, 4),
    "Идринско-Краснотуранский муниципальный округ":    (0.30, 5),
    "Минусинский муниципальный округ":                 (0.24, 5),
    "Курагинский муниципальный округ":                 (0.74, 4),
    "Каратузский муниципальный округ":                 (0.70, 4),
    "Ермаковский муниципальный округ":                 (0.78, 4),
    "Шушенский муниципальный округ":                   (0.64, 4),
    "городской округ Красноярск":                      (0.18, 4),
    "городской округ Дивногорск":                      (0.80, 4),
    "Сосновоборский муниципальный округ":              (0.15, 4),
    "ЗАТО Железногорск":                               (0.62, 4),
    "ЗАТО Зеленогорск":                                (0.45, 4),
    "ЗАТО Солнечный":                                  (0.20, 5),
}
K_BY_CLASS = {1: 0.30, 2: 0.70, 3: 1.00, 4: 1.25, 5: 0.90}

# ------------------------------------------------------------------- загрузка

print("Читаю базу...")
adjacency = json.loads((DATA / "adjacency.json").read_text(encoding="utf-8"))
gj = json.loads((DATA / "districts.geojson").read_text(encoding="utf-8"))
geoms = {f["properties"]["id"]: f["geometry"]["coordinates"] for f in gj["features"]}
names = {rid: m["name"] for rid, m in adjacency.items()}


# Анклавы (Норильск, Зеленогорск, ЗАТО) лежат ВНУТРИ полигона округа-хозяина,
# поэтому точка внутри Норильска попадает и в Таймыр тоже. Перебираем районы от
# меньшего к большему и берём первое попадание — так населённый пункт достаётся
# анклаву, а не округу вокруг него.
BY_AREA = sorted(geoms, key=lambda r: adjacency[r]["area"])


def locate(pt):
    """Найти САМЫЙ МЕЛКИЙ район, содержащий точку."""
    for rid in BY_AREA:
        if any(point_in_ring(pt, poly[0]) for poly in geoms[rid]):
            return rid
    return None


print("Overpass-запросы:")
places = cached("places", f"""
[out:json][timeout:300];
rel({KRAI});map_to_area->.k;
node["place"~"^(city|town|village)$"]["population"](area.k);
out body;
""")

aerodromes = cached("aerodromes", f"""
[out:json][timeout:300];
rel({KRAI});map_to_area->.k;
(node["aeroway"="aerodrome"](area.k);way["aeroway"="aerodrome"](area.k););
out center;
""")

roads = cached("roads", f"""
[out:json][timeout:600];
rel({KRAI});map_to_area->.k;
way["highway"~"^(trunk|primary|secondary)$"](area.k);
out geom;
""")

# Запрос «все именованные реки края» Overpass не тянет: это 2.4 млн км² и
# десятки тысяч way, сервер уходит в таймаут. Сужаем до списка крупных рек
# регуляркой по имени — барьерами работают только они.
MAJOR = ("Енисей", "Ангара", "Подкаменная Тунгуска", "Нижняя Тунгуска",
         "Чулым", "Кан", "Мана", "Кас", "Сым", "Бахта", "Курейка", "Пясина",
         "Хатанга", "Хета", "Котуй", "Вельмо", "Тасеева", "Бирюса", "Оя", "Туба")
NAME_RE = "^(" + "|".join(MAJOR) + ")$"

rivers = cached("rivers", f"""
[out:json][timeout:600];
rel({KRAI});map_to_area->.k;
way["waterway"="river"]["name"~"{NAME_RE}"](area.k);
out geom;
""")

# ---------------------------------------------------------------- население

print("\nРазношу население по районам...")
pop = {rid: 0 for rid in adjacency}
unplaced = 0
for e in places["elements"]:
    raw = e.get("tags", {}).get("population", "")
    digits = "".join(c for c in raw if c.isdigit())
    if not digits:
        continue
    rid = locate([e["lon"], e["lat"]])
    if rid is None:
        unplaced += 1
        continue
    pop[rid] += int(digits)
print(f"  узлов с населением: {len(places['elements'])}, вне полигонов: {unplaced}")
print(f"  суммарно разнесено: {sum(pop.values()):,}".replace(",", " "))

# ---------------------------------------------------------------- аэродромы

airfield = {rid: False for rid in adjacency}
for e in aerodromes["elements"]:
    lon = e.get("lon") or e.get("center", {}).get("lon")
    lat = e.get("lat") or e.get("center", {}).get("lat")
    if lon is None:
        continue
    rid = locate([lon, lat])
    if rid:
        airfield[rid] = True
print(f"  аэродромы найдены в {sum(airfield.values())} районах")

# --------------------------------------------------- дороги → плотность/access

print("Считаю плотность дорог...")
road_km = {rid: 0.0 for rid in adjacency}
for w in roads["elements"]:
    g = w.get("geometry") or []
    if len(g) < 2:
        continue
    mid = g[len(g) // 2]
    rid = locate([mid["lon"], mid["lat"]])
    if rid is None:
        continue
    pts = [[p["lon"], p["lat"]] for p in g]
    road_km[rid] += sum(haversine(pts[i], pts[i + 1]) for i in range(len(pts) - 1))

# -------------------------------------------------------- реки → барьеры рёбер

print("Считаю речные барьеры на рёбрах...")
river_pts = []
for w in rivers["elements"]:
    for p in w.get("geometry") or []:
        river_pts.append((p["lon"], p["lat"]))
print(f"  точек крупных рек: {len(river_pts)}")

# Сетка 0.25° для быстрого поиска ближайшей речной точки.
CELL = 0.25
grid = {}
for lon, lat in river_pts:
    grid.setdefault((int(lon / CELL), int(lat / CELL)), []).append((lon, lat))


def near_river(pt, max_km=6.0):
    cx, cy = int(pt[0] / CELL), int(pt[1] / CELL)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for q in grid.get((cx + dx, cy + dy), ()):
                if haversine(pt, q) <= max_km:
                    return True
    return False


# Общая граница i↔j восстанавливается из геометрии: берём вершины полигона i,
# лежащие близко к полигону j. Дорого в лоб, поэтому сэмплируем вершины.
verts = {rid: [p for poly in polys for p in poly[0]] for rid, polys in geoms.items()}
river_edges = 0
for rid, m in adjacency.items():
    for edge in m["neighbors"]:
        oth = edge["to"]
        mine, theirs = verts.get(rid, []), verts.get(oth, [])
        if not mine or not theirs:
            edge["river"] = 0.0
            continue
        tset = {(round(p[0], 2), round(p[1], 2)) for p in theirs}
        shared_pts = [p for p in mine if (round(p[0], 2), round(p[1], 2)) in tset]
        if not shared_pts:
            edge["river"] = 0.0
            continue
        step = max(1, len(shared_pts) // 40)
        sample = shared_pts[::step]
        frac = sum(1 for p in sample if near_river(p)) / len(sample)
        edge["river"] = round(0.40 * frac, 3) if frac > 0.30 else 0.0
        if edge["river"] > 0:
            river_edges += 1
print(f"  рёбер с речным барьером: {river_edges} из "
      f"{sum(len(m['neighbors']) for m in adjacency.values())}")

# -------------------------------------------------------------------- сборка

print("\nСобираю districts.meta.json...")
max_density = max((road_km[r] / max(1, adjacency[r]["area"]) for r in adjacency), default=1)
meta = {}
missing_forest = []

for rid, m in adjacency.items():
    name = m["name"]
    if name not in FOREST:
        missing_forest.append(name)
    forest, fuel_class = FOREST.get(name, (0.5, 3))
    road_density = road_km[rid] / max(1, m["area"])
    access = min(1.0, 0.55 * (road_density / max_density) ** 0.5
                 + (0.25 if airfield[rid] else 0.0)
                 + 0.20 * min(1.0, pop[rid] / 50000))
    # Зона контроля — это удалённые северные округа, а не любой малолюдный
    # полигон: у ЗАТО плотность тоже может выйти низкой. Отсекаем по площади,
    # иначе в зоны контроля попадают городские анклавы.
    density = pop[rid] / max(1, m["area"])
    ctrl = density < 0.30 and m["area"] > 40_000

    for e in m["neighbors"]:
        e.setdefault("river", 0.0)
        e["road"] = 0.0  # см. примечание в отчёте: дороги вдоль границ здесь не барьер
        e["barrier"] = round(min(0.60, e["river"] + e["road"]), 3)

    meta[rid] = {
        "id": rid,
        "name": name,
        "area": m["area"],
        "centroid": m["centroid"],
        "forest": forest,
        "fuelClass": fuel_class,
        "k": K_BY_CLASS[fuel_class],
        "pop": pop[rid],
        "access": round(access, 3),
        "ctrlZone": ctrl,
        "hasAirfield": airfield[rid],
        "hasWater": bool(river_pts) and any(near_river(p, 25.0) for p in verts[rid][::20]),
        "roadKm": round(road_km[rid]),
        "neighbors": [
            {"to": e["to"], "w": e["w"], "barrier": e["barrier"],
             "river": e["river"], "road": e["road"]}
            for e in m["neighbors"]
        ],
    }

(DATA / "districts.meta.json").write_text(
    json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

if missing_forest:
    print(f"  НЕТ В ТАБЛИЦЕ ЛЕСИСТОСТИ: {missing_forest}")

ctrl_zones = [m["name"] for m in meta.values() if m["ctrlZone"]]
forest_ha = sum(m["area"] * m["forest"] * 100 for m in meta.values())
print(f"\nРайонов: {len(meta)}")
print(f"Зон контроля: {len(ctrl_zones)} — {', '.join(n[:22] for n in ctrl_zones)}")
print(f"Лесопокрытая площадь: {forest_ha / 1e6:.1f} млн га")
print(f"Население разнесено: {sum(m['pop'] for m in meta.values()):,}".replace(",", " "))
print(f"Файл: {(DATA / 'districts.meta.json').stat().st_size / 1024:.0f} КБ")
