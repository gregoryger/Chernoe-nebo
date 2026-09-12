"""Шаг 1. Найти отношение Красноярского края и перечислить его районы (admin_level=6).

Геометрию тут НЕ тянем — только id и теги, чтобы оценить состав и объём.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import overpass

OUT = pathlib.Path(__file__).parent.parent / "data" / "raw"
OUT.mkdir(parents=True, exist_ok=True)

print("Ищу отношение Красноярского края...")
krai = overpass.query("""
[out:json][timeout:120];
relation["boundary"="administrative"]["admin_level"="4"]["name"="Красноярский край"];
out ids tags;
""")

if not krai["elements"]:
    raise SystemExit("Край не найден — проверь название в OSM")

krai_rel = krai["elements"][0]
krai_id = krai_rel["id"]
print(f"  найдено: relation/{krai_id} — {krai_rel['tags'].get('name')}")

print("Запрашиваю районы (admin_level=6)...")
districts = overpass.query(f"""
[out:json][timeout:300];
rel({krai_id});map_to_area->.krai;
relation["boundary"="administrative"]["admin_level"="6"](area.krai);
out ids tags;
""")

els = districts["elements"]
print(f"  получено отношений: {len(els)}")

rows = []
for e in els:
    t = e.get("tags", {})
    rows.append({
        "id": e["id"],
        "name": t.get("name", "?"),
        "admin_level": t.get("admin_level"),
        "population": t.get("population"),
        "place": t.get("place"),
        "type": t.get("type"),
    })

rows.sort(key=lambda r: r["name"])
for r in rows:
    pop = r["population"] or "-"
    print(f"  {r['id']:<12} {r['name'][:46]:<48} pop={pop}")

(OUT / "districts_list.json").write_text(
    json.dumps({"krai_id": krai_id, "districts": rows}, ensure_ascii=False, indent=1),
    encoding="utf-8",
)
print(f"\nСохранено: {OUT / 'districts_list.json'}")
print(f"Всего районов: {len(rows)}")
print(f"С тегом population: {sum(1 for r in rows if r['population'])}")
