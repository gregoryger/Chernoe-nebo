"""Шаг 2. Скачать геометрию границ районов.

Тянем `out geom` по одному отношению за раз. Кроме координат нам нужны id
способов (way id) каждого участника: соседние административные отношения в OSM
ссылаются на ОДИН И ТОТ ЖЕ way вдоль общей границы. Это даёт точный граф
соседства пересечением множеств way id — без геометрических операций и без
shapely.

Загрузка возобновляемая: каждый район пишется отдельным файлом, уже скачанные
пропускаются. Сибирские округа большие, а соединение рвётся.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import overpass

RAW = pathlib.Path(__file__).parent.parent / "data" / "raw"
PARTS = RAW / "geom"
PARTS.mkdir(parents=True, exist_ok=True)

listing = json.loads((RAW / "districts_list.json").read_text(encoding="utf-8"))
districts = listing["districts"]

print(f"Районов к загрузке: {len(districts)}")
done = skipped = 0

for i, d in enumerate(districts, 1):
    rid, name = d["id"], d["name"]
    part = PARTS / f"{rid}.json"
    if part.exists() and part.stat().st_size > 200:
        skipped += 1
        continue

    print(f"  [{i:>2}/{len(districts)}] {name[:44]:<46}", end="", flush=True)
    data = overpass.query(f"[out:json][timeout:600];rel({rid});out geom;")

    rel = next((e for e in data["elements"] if e["type"] == "relation"), None)
    if rel is None:
        print(" ПУСТО")
        continue

    members = [
        {
            "ref": m["ref"],
            "role": m.get("role", ""),
            # 5 знаков ~ 1 м на этих широтах, дальше упростим Дугласом-Пейкером
            "geometry": [[round(p["lon"], 5), round(p["lat"], 5)] for p in m["geometry"]],
        }
        for m in rel.get("members", [])
        if m["type"] == "way" and "geometry" in m
    ]
    rec = {"id": rid, "name": name, "tags": rel.get("tags", {}), "members": members}
    part.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")

    pts = sum(len(m["geometry"]) for m in members)
    print(f" ways={len(members):<5} точек={pts:<8} {part.stat().st_size / 1e6:.1f} МБ")
    done += 1

print(f"\nСкачано сейчас: {done}, пропущено (уже было): {skipped}")
total = sum(p.stat().st_size for p in PARTS.glob("*.json"))
print(f"Файлов на диске: {len(list(PARTS.glob('*.json')))}, суммарно {total / 1e6:.1f} МБ")

missing = [d["name"] for d in districts if not (PARTS / f"{d['id']}.json").exists()]
if missing:
    print(f"НЕ ЗАГРУЖЕНЫ ({len(missing)}):", missing)
else:
    print("Все районы на месте.")
