import json
import copy
import os
import secrets
import threading
import time
import base64
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue, Empty, Full
from urllib.parse import urlparse, parse_qs


PORT = int(os.environ.get("PORT", "5173"))
DATA_DIR = os.path.join(os.getcwd(), "data")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")
STATE_PATH = os.path.join(DATA_DIR, "state.json")
PUBLIC_DIR = os.path.join(os.getcwd(), "public")

DUMMY_TASKS = [
    "Udělejte 10 dřepů a pošlete video/foto.",
    "Zaspívejte týmovou hymnu.",
    "Najděte v okolí červený předmět a vyfoťte ho.",
    "Vytvořte z těl písmeno T.",
    "Odpovězte na hádanku: Co má zuby, ale nekouše?",
    "Udělejte selfie s celým týmem.",
    "Postavte malou pyramidu z kamenů/klacků.",
    "Vyfoťte nejvyšší strom v okolí."
]


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_data_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    
    # If state.json is missing in DATA_DIR (e.g. empty volume), try to copy from INITIAL_DATA_DIR
    # if not os.path.exists(STATE_PATH) and os.path.exists(INITIAL_DATA_DIR):
    #     print("Initializing data from initial_data...")
    #     for filename in os.listdir(INITIAL_DATA_DIR):
    #         src = os.path.join(INITIAL_DATA_DIR, filename)
    #         dst = os.path.join(DATA_DIR, filename)
    #         if os.path.isfile(src) and not os.path.exists(dst):
    #             shutil.copy2(src, dst)
    #             print(f"Copied {filename} to {DATA_DIR}")


def save_base64_image(data_uri: str, prefix: str) -> str | None:
    if not data_uri:
        return None
    try:
        # data:image/jpeg;base64,...
        parts = data_uri.split(",", 1)
        if len(parts) != 2:
            return None
        header, encoded = parts
        ext = ".jpg"
        if "image/png" in header:
            ext = ".png"
        elif "image/gif" in header:
            ext = ".gif"
        elif "image/webp" in header:
            ext = ".webp"
        
        data = base64.b64decode(encoded)
        filename = f"{prefix}_{secrets.token_hex(8)}{ext}"
        path = os.path.join(UPLOADS_DIR, filename)
        with open(path, "wb") as f:
            f.write(data)
        return f"/uploads/{filename}"
    except Exception:
        return None


def read_state() -> dict:
    ensure_data_dir()
    if not os.path.exists(STATE_PATH):
        # Create empty default state if missing
        default_state = {
            "version": 1,
            "config": {"gameStartMs": now_ms(), "gameLocked": False, "adminPin": "1234"},
            "teams": [
                {"id": "1", "name": "Modrá", "color": "#0000ff", "pin": "modra"},
                {"id": "2", "name": "Červená", "color": "#ff0000", "pin": "cervena"},
                {"id": "3", "name": "Zelená", "color": "#00ff00", "pin": "zelena"},
                {"id": "4", "name": "Žlutá", "color": "#ffff00", "pin": "zluta"},
                {"id": "5", "name": "Oranžová", "color": "#ffa500", "pin": "oranzova"},
                {"id": "6", "name": "Fialová", "color": "#800080", "pin": "fialova"},
                {"id": "7", "name": "Růžová", "color": "#ffc0cb", "pin": "ruzova"},
            ],
            "territories": [],
            "claimRequests": [],
            "claimVerifyRequests": [],
            "eventLog": [],
            "teamStats": {}
        }
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(default_state, f, ensure_ascii=False, indent=2)
    
    with open(STATE_PATH, "r", encoding="utf-8") as f:
        state = json.load(f)
        
    # AUTO-FIX: If teams are missing or empty (broken state), restore them
    if not state.get("teams"):
        state["teams"] = [
            {"id": "1", "name": "Modrá", "color": "#0000ff", "pin": "1234"},
            {"id": "2", "name": "Červená", "color": "#ff0000", "pin": "1234"},
            {"id": "3", "name": "Zelená", "color": "#00ff00", "pin": "1234"},
            {"id": "4", "name": "Žlutá", "color": "#ffff00", "pin": "1234"},
            {"id": "5", "name": "Oranžová", "color": "#ffa500", "pin": "1234"},
            {"id": "6", "name": "Fialová", "color": "#800080", "pin": "1234"},
            {"id": "7", "name": "Růžová", "color": "#ffc0cb", "pin": "1234"},
        ]
        if "config" not in state: state["config"] = {}
        state["config"]["adminPin"] = "1234"
        write_state(state)

    # AUTO-FIX: Always try to load territories from map.geojson if they are missing or if config says so
    # Default to map.geojson if not configured
    if not state.get("config", {}).get("territoriesGeojson"):
        if "config" not in state: state["config"] = {}
        state["config"]["territoriesGeojson"] = "map.geojson"
        state["config"]["mapMode"] = "osm" # Ensure map mode is set
        write_state(state)
    
    # Force reload of territories if they are empty in state but map.geojson is configured
    if not state.get("territories") and state.get("config", {}).get("territoriesGeojson"):
        try:
             apply_geojson_territories(state)
             # If we successfully loaded territories, save them to state (or at least the config)
             if state.get("territories"):
                 write_state(state)
        except Exception:
             pass

    try:
        apply_geojson_territories(state)
    except Exception:
        pass
    return state


def write_state(state: dict) -> None:
    ensure_data_dir()
    persist = state
    config = (state.get("config", {}) or {}) if isinstance(state, dict) else {}
    if config.get("territoriesGeojson"):
        persist = copy.deepcopy(state)
        for z in persist.get("territories", []) or []:
            if isinstance(z, dict):
                z.pop("polygon", None)
                z.pop("neighbors", None)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(persist, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)


def add_event(state: dict, kind: str, territory_id: str | None = None, team_ids: list[str] | None = None, **fields) -> None:
    if "eventLog" not in state or not isinstance(state.get("eventLog"), list):
        state["eventLog"] = []
    ev = {"id": "ev_" + secrets.token_hex(8), "tsMs": now_ms(), "kind": str(kind or "")}
    if territory_id:
        ev["territoryId"] = str(territory_id)
    if team_ids:
        ev["teamIds"] = [str(t) for t in team_ids if t]
    for k, v in fields.items():
        if v is None:
            continue
        ev[str(k)] = v
    state["eventLog"].append(ev)
    if len(state["eventLog"]) > 250:
        state["eventLog"] = state["eventLog"][-250:]


def apply_geojson_territories(state: dict) -> None:
    if not isinstance(state, dict):
        return
    config = state.get("config", {}) or {}
    filename = config.get("territoriesGeojson")
    if not filename:
        return
    path = filename if os.path.isabs(str(filename)) else os.path.join(DATA_DIR, str(filename))
    if not os.path.exists(path):
        return

    is_geo = config.get("mapMode") == "geo"
    simple = config.get("simpleMap", {}) or {}
    width = float(simple.get("width", 1000))
    height = float(simple.get("height", 1000))
    id_prefix = str(config.get("territoriesGeojsonIdPrefix") or "z")

    with open(path, "r", encoding="utf-8") as f:
        fc = json.load(f)
    features = fc.get("features", []) if isinstance(fc, dict) else []

    label_to_ring: dict[str, list[tuple[float, float]]] = {}
    polygons_without_label: list[list[tuple[float, float]]] = []

    for feat in features:
        geom = (feat or {}).get("geometry", {}) or {}
        props = (feat or {}).get("properties", {}) or {}
        coords = geom.get("coordinates", [])

        # Handle Polygon type (list of rings)
        if geom.get("type") == "Polygon":
            if not isinstance(coords, list) or len(coords) == 0:
                continue
            ring_coords = coords[0] # Outer ring
            ring = [(float(c[0]), float(c[1])) for c in ring_coords if isinstance(c, list) and len(c) >= 2]
            if len(ring) < 4:
                continue
            
            text = props.get("Text")
            if text:
                label_to_ring[str(text)] = ring
            else:
                polygons_without_label.append(ring)
            continue

        # Handle LineString type (legacy)
        if geom.get("type") == "LineString":
            if not isinstance(coords, list) or len(coords) < 4:
                continue
            ring = [(float(c[0]), float(c[1])) for c in coords if isinstance(c, list) and len(c) >= 2]
            if len(ring) < 4:
                continue
            if ring[0] != ring[-1]:
                dx = ring[0][0] - ring[-1][0]
                dy = ring[0][1] - ring[-1][1]
                if (dx * dx + dy * dy) <= (0.12 * 0.12):
                    ring.append(ring[0])
                else:
                    continue
            
            text = props.get("Text")
            if text:
                label_to_ring[str(text)] = ring
            else:
                polygons_without_label.append(ring)
            continue

    # Fallback: Match Points (Labels) to Polygons without label
    labels: list[tuple[str, tuple[float, float]]] = []
    for feat in features:
        geom = (feat or {}).get("geometry", {}) or {}
        if geom.get("type") != "Point":
            continue
        props = (feat or {}).get("properties", {}) or {}
        text = props.get("Text")
        if text is None:
            continue
        coords = geom.get("coordinates", [])
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        labels.append((str(text), (float(coords[0]), float(coords[1]))))

    def point_in_polygon(pt: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
        x, y = pt
        inside = False
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            if (y1 > y) != (y2 > y):
                xin = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-30) + x1
                if x < xin:
                    inside = not inside
        return inside

    def get_ring_area(ring: list[tuple[float, float]]) -> float:
        area2 = 0.0
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            area2 += x1 * y2 - x2 * y1
        return abs(area2) * 0.5

    for text, pt in labels:
        if text in label_to_ring:
            continue
        containing = [ring for ring in polygons_without_label if point_in_polygon(pt, ring)]
        if containing:
            # Pick smallest area (most specific polygon)
            label_to_ring[text] = min(containing, key=get_ring_area)

    if not label_to_ring:
        return

    # Normalization logic
    if is_geo:
        # Pass through lat/lng (GeoJSON is [lng, lat], Leaflet wants [lat, lng])
        # We will return [lat, lng] for client
        def normalize_xy(x: float, y: float) -> tuple[float, float]:
            return (x, y) # x=lng, y=lat. Server loop below swaps them to [lat, lng]
    else:
        # Legacy simple map normalization
        xs: list[float] = []
        ys: list[float] = []
        for ring in label_to_ring.values():
            for x, y in ring:
                xs.append(x)
                ys.append(y)
        minx = min(xs)
        maxx = max(xs)
        miny = min(ys)
        maxy = max(ys)
        
        # Custom transformation for 'podklad.png' if defined... 
        # But user wants to delete it. We revert to standard auto-scale if not geo.
        def normalize_xy(x: float, y: float) -> tuple[float, float]:
             nx = (x - minx) / (maxx - minx) if maxx != minx else 0.0
             ny = (y - miny) / (maxy - miny) if maxy != miny else 0.0
             return (nx * width, ny * height)

    def clean_ring(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        last = None
        for x, y in ring:
            if last is None or last[0] != x or last[1] != y:
                out.append((x, y))
                last = (x, y)
        if out and out[0] != out[-1]:
            out.append(out[0])
        return out

    computed: dict[str, dict] = {}
    for label, ring in label_to_ring.items():
        territory_id = f"{id_prefix}{label}"
        pts: list[list[float]] = []
        for x, y in clean_ring(ring):
            sx, sy = normalize_xy(x, y)
            # GeoJSON x=Lng, y=Lat.
            # Client expects [Lat, Lng].
            if is_geo:
                pts.append([sy, sx]) # [Lat, Lng]
            else:
                pts.append([round(sy, 1), round(sx, 1)])
        computed[territory_id] = {"polygon": pts, "neighbors": []}


    vert_sets: dict[str, set[tuple[int, int]]] = {}
    for tid, payload in computed.items():
        poly = payload.get("polygon") or []
        # In Geo mode, coords are floats (lat/lng). 
        # For neighbor detection, we need to be careful with floating point comparison.
        # We'll use scaled integers for comparison (e.g. 5 decimal places).
        scale = 100000 if is_geo else 1
        vert_sets[tid] = set((int(round(p[1] * scale)), int(round(p[0] * scale))) for p in poly if isinstance(p, list) and len(p) >= 2)

    ids = list(computed.keys())
    for i, a in enumerate(ids):
        for j in range(i + 1, len(ids)):
            b = ids[j]
            shared = len(vert_sets[a].intersection(vert_sets[b]))
            if shared >= 2:
                computed[a]["neighbors"].append(b)
                computed[b]["neighbors"].append(a)

    for z in state.get("territories", []) or []:
        if not isinstance(z, dict):
            continue
        tid = z.get("id")
        if tid in computed:
            z["polygon"] = computed[tid]["polygon"]
            z["neighbors"] = computed[tid]["neighbors"]


def ensure_team_stats(state: dict) -> None:
    if "teamStats" not in state or not isinstance(state["teamStats"], dict):
        state["teamStats"] = {}
    
    # Ensure all teams have entries
    for t in state.get("teams", []) or []:
        tid = t.get("id")
        if tid and tid not in state["teamStats"]:
            state["teamStats"][tid] = {"captures": 0, "totalTimeMs": 0}

def update_territory_ownership_time(state: dict, territory: dict) -> None:
    # If the territory has an owner and a capturedAtMs timestamp,
    # calculate the time elapsed and add it to the owner's totalTimeMs.
    owner = territory.get("ownerTeamId")
    captured_at = territory.get("capturedAtMs")
    
    if owner and captured_at:
        ensure_team_stats(state)
        now = now_ms()
        elapsed = max(0, now - int(captured_at))
        
        stats = state["teamStats"].get(owner)
        if stats:
            stats["totalTimeMs"] = int(stats.get("totalTimeMs", 0)) + elapsed
    
    # Reset the timestamp for the next period (or clear it if losing ownership)
    territory["capturedAtMs"] = now_ms()


def sanitize_state_for_client(state: dict, session: dict | None = None, compact: bool = False) -> dict:
    role = (session or {}).get("role")
    team_id = (session or {}).get("teamId")

    claim_requests_out: list[dict] = []
    raw_claims = state.get("claimRequests", []) or []
    if isinstance(raw_claims, list):
        for r in raw_claims:
            if not isinstance(r, dict):
                continue
            if role == "admin":
                claim_requests_out.append(
                    {
                        "id": r.get("id"),
                        "territoryId": r.get("territoryId"),
                        "teamId": r.get("teamId"),
                        "question": r.get("question", ""),
                        "answer": r.get("answer", ""),
                        "status": r.get("status", "pending"),
                        "rejectReason": r.get("rejectReason"),
                        "cooldownUntilMs": r.get("cooldownUntilMs"),
                        "createdAtMs": r.get("createdAtMs"),
                        "resolvedAtMs": r.get("resolvedAtMs"),
                    }
                )
            elif role == "team" and team_id and r.get("teamId") == team_id:
                claim_requests_out.append(
                    {
                        "id": r.get("id"),
                        "territoryId": r.get("territoryId"),
                        "teamId": r.get("teamId"),
                        "question": r.get("question", ""),
                        "answer": r.get("answer", ""),
                        "status": r.get("status", "pending"),
                        "rejectReason": r.get("rejectReason"),
                        "cooldownUntilMs": r.get("cooldownUntilMs"),
                        "createdAtMs": r.get("createdAtMs"),
                        "resolvedAtMs": r.get("resolvedAtMs"),
                    }
                )

    claim_verify_requests_out: list[dict] = []
    raw_verify = state.get("claimVerifyRequests", []) or []
    if isinstance(raw_verify, list):
        for r in raw_verify:
            if not isinstance(r, dict):
                continue
            if role == "admin" or (role == "team" and team_id and r.get("teamId") == team_id):
                claim_verify_requests_out.append(
                    {
                        "id": r.get("id"),
                        "territoryId": r.get("territoryId"),
                        "teamId": r.get("teamId"),
                        "status": r.get("status", "pending"),
                        "createdAtMs": r.get("createdAtMs"),
                        "resolvedAtMs": r.get("resolvedAtMs"),
                        "expiresAtMs": r.get("expiresAtMs"),
                        "lat": r.get("lat"),
                        "lng": r.get("lng"),
                        "assignedTask": r.get("assignedTask"),
                    }
                )

    cooldown_out = None
    if role == "team" and team_id:
        team_cooldowns = state.get("teamCooldowns", {}) or {}
        cd = team_cooldowns.get(team_id) if isinstance(team_cooldowns, dict) else None
        if isinstance(cd, dict):
            until_ms = cd.get("untilMs")
            reason = cd.get("reason")
            if until_ms is not None or reason is not None:
                cooldown_out = {"untilMs": until_ms, "reason": reason}

    event_log_out: list[dict] = []
    raw_events = state.get("eventLog", []) or []
    if isinstance(raw_events, list):
        allow = {
            "id",
            "tsMs",
            "kind",
            "territoryId",
            "teamId",
            "fromTeamId",
            "toTeamId",
            "result",
        }
        for ev in raw_events[-200:]:
            if not isinstance(ev, dict):
                continue
            if role == "admin":
                pass
            elif role == "team" and team_id:
                team_ids = ev.get("teamIds") or []
                if isinstance(team_ids, list):
                    team_ids = [str(t) for t in team_ids]
                else:
                    team_ids = []
                if str(team_id) not in team_ids:
                    continue
            else:
                continue
            event_log_out.append({k: ev.get(k) for k in allow if k in ev})

    territory_locks_out: dict[str, int] = {}
    raw_territory_locks = state.get("territoryLocks", {}) or {}
    if isinstance(raw_territory_locks, dict):
        for k, v in raw_territory_locks.items():
            try:
                territory_locks_out[str(k)] = int(v)
            except Exception:
                continue
    
    # Stats
    ensure_team_stats(state)
    team_stats_out = state.get("teamStats", {})

    return {
        "version": state.get("version", 1),
        "config": state.get("config", {}),
        "teams": [
            {"id": t["id"], "name": t["name"], "color": t["color"]}
            for t in state.get("teams", [])
        ],
        "territories": [
            {
                "id": z["id"],
                "name": z.get("name", z["id"]),
                "ownerTeamId": z.get("ownerTeamId"),
                "capturedAtMs": z.get("capturedAtMs"),
                "neighbors": z.get("neighbors", []) if not compact else [],
                "polygon": z.get("polygon", []) if not compact else [],
            }
            for z in state.get("territories", [])
        ],
        "attackLocks": state.get("attackLocks", {}) if role == "admin" else (state.get("attackLocks", {}) or {}).get(team_id, {}) if (role == "team" and team_id) else {},
        "territoryLocks": territory_locks_out,
        "claimVerifyRequests": claim_verify_requests_out,
        "claimRequests": claim_requests_out,
        "cooldown": cooldown_out,
        "eventLog": event_log_out,
        "teamStats": team_stats_out,
    }


def has_any_territory(state: dict, team_id: str) -> bool:
    for t in state.get("territories", []):
        if t.get("ownerTeamId") == team_id:
            return True
    return False


def is_adjacent_to_owned(state: dict, team_id: str, territory_id: str) -> bool:
    owned = [t["id"] for t in state.get("territories", []) if t.get("ownerTeamId") == team_id]
    if len(owned) == 0:
        return True

    target = next((t for t in state.get("territories", []) if t["id"] == territory_id), None)
    if not target:
        return False

    owned_set = set(owned)
    for n in target.get("neighbors", []):
        if n in owned_set:
            return True
    for o in owned:
        ot = next((t for t in state.get("territories", []) if t["id"] == o), None)
        if ot and territory_id in ot.get("neighbors", []):
            return True
    return False


def is_locked_for_team(state: dict, team_id: str, territory_id: str) -> bool:
    territory_locks = state.get("territoryLocks", {}) or {}
    if isinstance(territory_locks, dict):
        v = territory_locks.get(territory_id)
        try:
            until_ms = int(v)
        except Exception:
            until_ms = 0
        if until_ms > 0 and now_ms() < until_ms:
            return True
    locks = state.get("attackLocks", {}).get(team_id, {})
    v = locks.get(territory_id)
    if isinstance(v, bool):
        return v
    try:
        until_ms = int(v)
    except Exception:
        return False
    return now_ms() < until_ms


def get_lock_until_ms(state: dict, team_id: str, territory_id: str) -> int | None:
    territory_locks = state.get("territoryLocks", {}) or {}
    if isinstance(territory_locks, dict):
        v = territory_locks.get(territory_id)
        try:
            until_ms = int(v)
        except Exception:
            until_ms = 0
        if until_ms > 0 and now_ms() < until_ms:
            return until_ms
    locks = state.get("attackLocks", {}).get(team_id, {})
    v = locks.get(territory_id)
    if isinstance(v, bool):
        return None
    try:
        until_ms = int(v)
    except Exception:
        return None
    return until_ms


def set_territory_lock(state: dict, territory_id: str, until_ms: int) -> None:
    if "territoryLocks" not in state or not isinstance(state["territoryLocks"], dict):
        state["territoryLocks"] = {}
    state["territoryLocks"][territory_id] = int(until_ms)


def set_lock(state: dict, team_id: str, territory_id: str, until_ms: int | None = None) -> None:
    if "attackLocks" not in state or not isinstance(state["attackLocks"], dict):
        state["attackLocks"] = {}
    if team_id not in state["attackLocks"] or not isinstance(state["attackLocks"][team_id], dict):
        state["attackLocks"][team_id] = {}
    state["attackLocks"][team_id][territory_id] = True if until_ms is None else int(until_ms)


def ensure_team_ever_owned(state: dict) -> dict:
    if "teamEverOwned" not in state or not isinstance(state.get("teamEverOwned"), dict):
        state["teamEverOwned"] = {}
    ever = state["teamEverOwned"]
    for z in state.get("territories", []) or []:
        if not isinstance(z, dict):
            continue
        owner = z.get("ownerTeamId")
        if owner:
            ever[str(owner)] = True
    for r in state.get("claimRequests", []) or []:
        if not isinstance(r, dict):
            continue
        if str(r.get("status") or "") == "approved":
            tid = r.get("teamId")
            if tid:
                ever[str(tid)] = True
    return ever


def mark_team_ever_owned(state: dict, team_id: str) -> None:
    ever = ensure_team_ever_owned(state)
    ever[str(team_id)] = True


def ensure_game_start_ms(state: dict) -> tuple[int, bool]:
    cfg = state.get("config", {})
    if not isinstance(cfg, dict):
        cfg = {}
        state["config"] = cfg
    v = cfg.get("gameStartMs")
    try:
        start_ms = int(v)
        if start_ms > 0:
            return start_ms, False
    except Exception:
        pass
    start_ms = now_ms()
    cfg["gameStartMs"] = start_ms
    return start_ms, True


def get_claim_start_delay_ms(state: dict) -> int:
    cfg = state.get("config", {})
    if not isinstance(cfg, dict):
        return 0
    v = cfg.get("claimStartDelayMs", 0)
    try:
        ms = int(v)
    except Exception:
        ms = 0
    return max(0, ms)


def is_game_locked(state: dict) -> bool:
    cfg = state.get("config", {})
    if not isinstance(cfg, dict):
        return False
    return bool(cfg.get("gameLocked", False))


def get_team_cooldown(state: dict, team_id: str) -> dict | None:
    cooldowns = state.get("teamCooldowns", {}) or {}
    if not isinstance(cooldowns, dict):
        return None
    cd = cooldowns.get(team_id)
    if not isinstance(cd, dict):
        return None
    return cd


def is_team_in_cooldown(state: dict, team_id: str) -> tuple[bool, int, str]:
    cd = get_team_cooldown(state, team_id) or {}
    try:
        until_ms = int(cd.get("untilMs") or 0)
    except Exception:
        until_ms = 0
    reason = str(cd.get("reason") or "")
    active = now_ms() < until_ms
    return active, until_ms, reason


def set_team_cooldown(state: dict, team_id: str, until_ms: int, reason: str) -> None:
    if "teamCooldowns" not in state or not isinstance(state["teamCooldowns"], dict):
        state["teamCooldowns"] = {}
    state["teamCooldowns"][team_id] = {"untilMs": int(until_ms), "reason": str(reason or "")}


class Broadcaster:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._clients: dict[str, dict] = {}

    def add_client(self, session: dict) -> tuple[str, Queue]:
        cid = secrets.token_hex(8)
        q: Queue = Queue(maxsize=5)
        with self._lock:
            self._clients[cid] = {"queue": q, "session": dict(session)}
        return cid, q

    def remove_client(self, cid: str) -> None:
        with self._lock:
            self._clients.pop(cid, None)

    def broadcast_state(self, state: dict) -> None:
        with self._lock:
            for payload in self._clients.values():
                q = payload.get("queue")
                session = payload.get("session") or {}
                if not isinstance(q, Queue):
                    continue
                # Use compact=True to reduce bandwidth (omit polygons)
                data = json.dumps(sanitize_state_for_client(state, session, compact=True), ensure_ascii=False)
                message = f"event: state\ndata: {data}\n\n"
                try:
                    q.put_nowait(message)
                except Full:
                    try:
                        q.get_nowait()
                    except Exception:
                        pass
                    try:
                        q.put_nowait(message)
                    except Exception:
                        pass


broadcaster = Broadcaster()


class Sessions:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, dict] = {}

    def create_team_session(self, team_id: str) -> str:
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._sessions[token] = {
                "token": token,
                "teamId": team_id,
                "role": "team",
                "expiresAtMs": now_ms() + 12 * 60 * 60 * 1000,
            }
        return token

    def create_admin_session(self) -> str:
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._sessions[token] = {
                "token": token,
                "role": "admin",
                "expiresAtMs": now_ms() + 12 * 60 * 60 * 1000,
            }
        return token

    def get(self, token: str) -> dict | None:
        if not token:
            return None
        with self._lock:
            s = self._sessions.get(token)
            if not s:
                return None
            if int(s.get("expiresAtMs", 0)) < now_ms():
                self._sessions.pop(token, None)
                return None
            return dict(s)


sessions = Sessions()


def json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        base = PUBLIC_DIR
        p = urlparse(path).path
        if p.startswith("/uploads/"):
            return os.path.join(UPLOADS_DIR, p.replace("/uploads/", "", 1))
        if p == "/":
            p = "/index.html"
        local = os.path.normpath(os.path.join(base, p.lstrip("/")))
        if not local.startswith(os.path.normpath(base)):
            return base
        return local

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            try:
                state = read_state()
                qs = parse_qs(parsed.query)
                token = (qs.get("token") or [""])[0]
                session = sessions.get(token)
                json_response(self, HTTPStatus.OK, sanitize_state_for_client(state, session))
            except Exception as e:
                json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(e)})
            return

        if parsed.path == "/api/stream":
            qs = parse_qs(parsed.query)
            token = (qs.get("token") or [""])[0]
            session = sessions.get(token)
            if not session:
                json_response(self, HTTPStatus.UNAUTHORIZED, {"error": "Přihlášení vypršelo."})
                return

            cid, q = broadcaster.add_client(session)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            try:
                state = read_state()
                initial = json.dumps(sanitize_state_for_client(state, session), ensure_ascii=False)
                self.wfile.write(f"event: state\ndata: {initial}\n\n".encode("utf-8"))
                self.wfile.flush()

                last_ping = time.time()
                while True:
                    try:
                        msg = q.get(timeout=1.0)
                        self.wfile.write(msg.encode("utf-8"))
                        self.wfile.flush()
                    except Empty:
                        if time.time() - last_ping > 15:
                            self.wfile.write(b": ping\n\n")
                            self.wfile.flush()
                            last_ping = time.time()
            except BrokenPipeError:
                pass
            except ConnectionAbortedError:
                pass
            except ConnectionResetError:
                pass
            except OSError:
                pass
            finally:
                broadcaster.remove_client(cid)
            return

        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        body = read_json_body(self)

        if parsed.path == "/api/login":
            team_id = str(body.get("teamId") or "")
            pin = str(body.get("pin") or "")
            try:
                state = read_state()
                team = next((t for t in state.get("teams", []) if t.get("id") == team_id), None)
                if not team:
                    json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Neplatný tým."})
                    return
                # DEBUG FALLBACK: If user enters "1234" but stored PIN is different, update stored PIN to "1234"
                # This is a temporary fix to regain access
                if pin == "1234" and str(team.get("pin") or "") != "1234":
                     team["pin"] = "1234"
                     write_state(state)

                if str(team.get("pin") or "") != pin:
                    json_response(self, HTTPStatus.UNAUTHORIZED, {"error": "Špatný PIN."})
                    return
                token = sessions.create_team_session(team_id)
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "token": token,
                        "team": {"id": team["id"], "name": team["name"], "color": team["color"]},
                    },
                )
            except Exception as e:
                json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(e)})
            return

        if parsed.path == "/api/admin/login":
            pin = str(body.get("pin") or "")
            try:
                state = read_state()
                admin_pin = str((state.get("config", {}) or {}).get("adminPin") or "")
                
                # FALLBACK: If adminPin is missing, FORCE it to 1234
                if not admin_pin:
                    if "config" not in state: state["config"] = {}
                    state["config"]["adminPin"] = "1234"
                    write_state(state)
                    admin_pin = "1234"

                # DEBUG FALLBACK: If user enters "1234" but stored PIN is different, update stored PIN to "1234"
                # This is a temporary fix to regain access
                if pin == "1234" and admin_pin != "1234":
                    if "config" not in state: state["config"] = {}
                    state["config"]["adminPin"] = "1234"
                    write_state(state)
                    admin_pin = "1234"

                if pin != admin_pin:
                    json_response(self, HTTPStatus.UNAUTHORIZED, {"error": "Špatný admin PIN."})
                    return
                token = sessions.create_admin_session()
                json_response(self, HTTPStatus.OK, {"token": token, "admin": True})
            except Exception as e:
                json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(e)})
            return

        if parsed.path == "/api/admin/save_geojson":
            token = str(body.get("token") or "")
            session = sessions.get(token)
            if not session or session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return
            
            # The body IS the FeatureCollection (with token extra field which is fine for JSON)
            fc = body
            if not fc or fc.get("type") != "FeatureCollection":
                 json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Neplatný GeoJSON"})
                 return
            
            # Clean token from FC before saving to keep file clean
            if "token" in fc:
                del fc["token"]

            # Save to data/CTH_geo.geojson
            path = os.path.join(DATA_DIR, "CTH_geo.geojson")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(fc, f, ensure_ascii=False, indent=2)
            
            # Reload state to reflect changes immediately
            try:
                state = read_state()
                # Re-apply polygons from the new file
                apply_geojson_territories(state)
                write_state(state)
                broadcaster.broadcast_state(state)
            except Exception as e:
                print(f"Error re-applying state: {e}")

            json_response(self, HTTPStatus.OK, {"ok": True})
            return

        token = str(body.get("token") or "")
        session = sessions.get(token)
        if not session:
            json_response(self, HTTPStatus.UNAUTHORIZED, {"error": "Přihlášení vypršelo."})
            return

        if parsed.path == "/api/territory/info":
            territory_id = str(body.get("territoryId") or "")
            state = read_state()
            territory = next((t for t in state.get("territories", []) if t["id"] == territory_id), None)
            if not territory:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Území neexistuje."})
                return

            if session.get("role") == "admin":
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "territory": {
                            "id": territory["id"],
                            "name": territory.get("name", territory["id"]),
                            "ownerTeamId": territory.get("ownerTeamId"),
                        },
                        "canClaim": False,
                        "canAttack": False,
                        "locked": False,
                        "claimTask": None,
                    },
                )
                return

            team_id = session.get("teamId")
            if not team_id:
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Neplatná session."})
                return
            owned = territory.get("ownerTeamId")
            any_owned = has_any_territory(state, team_id)
            adjacent_ok = is_adjacent_to_owned(state, team_id, territory_id)
            territory_locks = state.get("territoryLocks", {}) or {}
            global_until_ms = None
            if isinstance(territory_locks, dict):
                try:
                    cand = int(territory_locks.get(territory_id) or 0)
                except Exception:
                    cand = 0
                if cand > 0 and now_ms() < cand:
                    global_until_ms = cand
            global_locked = global_until_ms is not None
            locked = is_locked_for_team(state, team_id, territory_id)
            lu = get_lock_until_ms(state, team_id, territory_id)
            lock_until_ms = lu if (lu is not None and now_ms() < int(lu)) else None
            cooldown_active, cooldown_until_ms, cooldown_reason = is_team_in_cooldown(state, team_id)
            ever = ensure_team_ever_owned(state)
            team_ever_owned = bool(ever.get(team_id))
            game_start_ms, gs_changed = ensure_game_start_ms(state)
            if gs_changed:
                write_state(state)
                broadcaster.broadcast_state(state)
            game_locked = is_game_locked(state)

            pending_claim = next(
                (
                    r
                    for r in (state.get("claimRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status", "pending") == "pending"
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                ),
                None,
            )

            pending_verify = next(
                (
                    r
                    for r in (state.get("claimVerifyRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status", "pending") == "pending"
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                ),
                None,
            )
            approved_verify = next(
                (
                    r
                    for r in (state.get("claimVerifyRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status") in ("approved", "task_assigned")
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                    and now_ms() < int(r.get("expiresAtMs") or 0)
                ),
                None,
            )
            verified = bool(approved_verify)
            task_assigned = approved_verify and approved_verify.get("status") == "task_assigned"

            start_delay_ms = get_claim_start_delay_ms(state)
            start_blocked_until_ms = (game_start_ms + start_delay_ms) if start_delay_ms > 0 else None
            start_blocked = (
                (start_delay_ms > 0)
                and (not any_owned)
                and (not team_ever_owned)
                and (now_ms() < int(start_blocked_until_ms or 0))
            )
            base_can_claim = (
                (owned is None)
                and (not pending_claim)
                and ((not any_owned) or adjacent_ok)
                and (not global_locked)
                and (not locked)
                and (not game_locked)
            )
            
            can_claim = base_can_claim and verified and (not cooldown_active) and (not start_blocked)
            
            tasks = territory.get("tasks", {}) or {}
            claim_verify_id = None
            assigned_task_text = None
            if isinstance(pending_verify, dict):
                claim_verify_id = pending_verify.get("id")
            elif isinstance(approved_verify, dict):
                claim_verify_id = approved_verify.get("id")
                assigned_task_text = approved_verify.get("assignedTask")

            json_response(
                self,
                HTTPStatus.OK,
                {
                    "territory": {
                        "id": territory["id"],
                        "name": territory.get("name", territory["id"]),
                        "ownerTeamId": territory.get("ownerTeamId"),
                    },
                    "canClaim": can_claim,
                    "canAttack": False, # Battles disabled
                    "locked": locked,
                    "lockUntilMs": lock_until_ms,
                    "claimTask": assigned_task_text if task_assigned else (tasks.get("claim") if pending_claim else None),
                    "claimRequestPending": bool(pending_claim),
                    "claimRequestId": pending_claim.get("id") if isinstance(pending_claim, dict) else None,
                    "claimVerificationPending": bool(pending_verify),
                    "claimVerificationApproved": verified,
                    "claimVerificationTaskAssigned": task_assigned,
                    "claimVerificationId": claim_verify_id,
                    "claimVerificationExpiresAtMs": approved_verify.get("expiresAtMs") if isinstance(approved_verify, dict) else None,
                    "canRequestClaimVerification": (
                        base_can_claim and (not cooldown_active) and (not verified) and (not pending_verify) and (not start_blocked)
                    ),
                    "claimStartBlockedUntilMs": start_blocked_until_ms,
                    "cooldownUntilMs": cooldown_until_ms if cooldown_active else None,
                    "cooldownReason": cooldown_reason if cooldown_active else None,
                },
            )
            return

        if parsed.path == "/api/territory/claim":
            if session.get("role") != "team":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen tým může obsazovat."})
                return
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Obsazení probíhá přes admina (pošli žádost)."})
            return

        if parsed.path == "/api/territory/claimVerifyRequest":
            if session.get("role") != "team":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen tým může žádat o ověření."})
                return
            territory_id = str(body.get("territoryId") or "")
            lat = body.get("lat")
            lng = body.get("lng")

            if not territory_id:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Chybí territoryId."})
                return

            team_id = session.get("teamId")
            if not team_id:
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Neplatná session."})
                return

            state = read_state()
            if is_game_locked(state):
                json_response(self, HTTPStatus.LOCKED, {"error": "Hra je ukončená."})
                return
            cooldown_active, cooldown_until_ms, _ = is_team_in_cooldown(state, team_id)
            if cooldown_active:
                left_ms = max(0, cooldown_until_ms - now_ms())
                left_min = int((left_ms + 59999) // 60000)
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": f"Špatná odpověď. Zkus to za {left_min} min."})
                return

            territory = next((t for t in state.get("territories", []) if t["id"] == territory_id), None)
            if not territory:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Území neexistuje."})
                return
            if territory.get("ownerTeamId") is not None:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Území už má vlastníka."})
                return
            
            if is_locked_for_team(state, team_id, territory_id):
                json_response(self, HTTPStatus.LOCKED, {"error": "Území je pro tebe zamknuté."})
                return

            territory_locks = state.get("territoryLocks", {}) or {}
            if isinstance(territory_locks, dict):
                try:
                    lock_until_ms = int(territory_locks.get(territory_id) or 0)
                except Exception:
                    lock_until_ms = 0
                if lock_until_ms > 0 and now_ms() < lock_until_ms:
                    left_ms = max(0, lock_until_ms - now_ms())
                    left_min = int((left_ms + 59999) // 60000)
                    json_response(self, HTTPStatus.LOCKED, {"error": f"Území je zamknuté ještě {left_min} min."})
                    return

            any_owned = has_any_territory(state, team_id)
            adjacent_ok = is_adjacent_to_owned(state, team_id, territory_id)
            if any_owned and (not adjacent_ok):
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Musíš navazovat na své území."})
                return

            ever = ensure_team_ever_owned(state)
            team_ever_owned = bool(ever.get(team_id))
            game_start_ms, gs_changed = ensure_game_start_ms(state)
            if gs_changed:
                write_state(state)
                broadcaster.broadcast_state(state)
            start_delay_ms = get_claim_start_delay_ms(state)
            if start_delay_ms > 0 and (not any_owned) and (not team_ever_owned):
                until_ms = int(game_start_ms + start_delay_ms)
                if now_ms() < until_ms:
                    left_ms = max(0, until_ms - now_ms())
                    left_min = int((left_ms + 59999) // 60000)
                    json_response(self, HTTPStatus.BAD_REQUEST, {"error": f"Můžeš začít zabírat za {left_min} min."})
                    return

            pending_claim = next(
                (
                    r
                    for r in (state.get("claimRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status", "pending") == "pending"
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                ),
                None,
            )
            if pending_claim:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Žádost už čeká na schválení adminem."})
                return

            pending_verify = next(
                (
                    r
                    for r in (state.get("claimVerifyRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status") in ("pending", "approved") # Include approved to avoid duplicate requests while waiting for task
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                ),
                None,
            )
            if pending_verify:
                json_response(self, HTTPStatus.OK, {"ok": True, "claimVerifyRequestId": pending_verify.get("id")})
                return

            approved_verify = next(
                (
                    r
                    for r in (state.get("claimVerifyRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status") == "approved"
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                    and now_ms() < int(r.get("expiresAtMs") or 0)
                ),
                None,
            )
            if approved_verify:
                json_response(self, HTTPStatus.OK, {"ok": True, "claimVerifyRequestId": approved_verify.get("id")})
                return

            req = {
                "id": "cv_" + secrets.token_hex(8),
                "territoryId": territory_id,
                "teamId": team_id,
                "status": "pending",
                "createdAtMs": now_ms(),
                "resolvedAtMs": None,
                "expiresAtMs": None,
                "lat": lat,
                "lng": lng,
            }
            state.setdefault("claimVerifyRequests", []).append(req)
            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True, "claimVerifyRequestId": req["id"]})
            return

        if parsed.path == "/api/territory/claimRequest":
            if session.get("role") != "team":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen tým může žádat o obsazení."})
                return
            territory_id = str(body.get("territoryId") or "")
            answer = str(body.get("answer") or "").strip()
            image_data = str(body.get("image") or "")

            if not territory_id:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Chybí territoryId."})
                return
            
            if image_data:
                # Save image and append URL to answer
                url = save_base64_image(image_data, "proof")
                if url:
                    answer = (answer + f" <a href='{url}' target='_blank'>[FOTO]</a>").strip()
            
            if len(answer) > 2000: # Increased limit for appended HTML/URL
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Odpověď je příliš dlouhá."})
                return

            team_id = session.get("teamId")
            if not team_id:
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Neplatná session."})
                return

            state = read_state()
            if is_game_locked(state):
                json_response(self, HTTPStatus.LOCKED, {"error": "Hra je ukončená."})
                return
            cooldown_active, cooldown_until_ms, _ = is_team_in_cooldown(state, team_id)
            if cooldown_active:
                left_ms = max(0, cooldown_until_ms - now_ms())
                left_min = int((left_ms + 59999) // 60000)
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": f"Špatná odpověď. Zkus to za {left_min} min."})
                return

            territory = next((t for t in state.get("territories", []) if t["id"] == territory_id), None)
            if not territory:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Území neexistuje."})
                return
            if territory.get("ownerTeamId") is not None:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Území už má vlastníka."})
                return

            if is_locked_for_team(state, team_id, territory_id):
                json_response(self, HTTPStatus.LOCKED, {"error": "Území je pro tebe zamknuté."})
                return

            territory_locks = state.get("territoryLocks", {}) or {}
            if isinstance(territory_locks, dict):
                try:
                    lock_until_ms = int(territory_locks.get(territory_id) or 0)
                except Exception:
                    lock_until_ms = 0
                if lock_until_ms > 0 and now_ms() < lock_until_ms:
                    left_ms = max(0, lock_until_ms - now_ms())
                    left_min = int((left_ms + 59999) // 60000)
                    json_response(self, HTTPStatus.LOCKED, {"error": f"Území je zamknuté ještě {left_min} min."})
                    return

            verified = next(
                (
                    r
                    for r in (state.get("claimVerifyRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status") == "task_assigned"
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                    and now_ms() < int(r.get("expiresAtMs") or 0)
                ),
                None,
            )
            if not verified:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Nejdřív počkej na přidělení úkolu adminem."})
                return

            any_owned = has_any_territory(state, team_id)
            adjacent_ok = is_adjacent_to_owned(state, team_id, territory_id)
            if any_owned and (not adjacent_ok):
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Musíš navazovat na své území."})
                return

            ever = ensure_team_ever_owned(state)
            team_ever_owned = bool(ever.get(team_id))
            game_start_ms, gs_changed = ensure_game_start_ms(state)
            if gs_changed:
                write_state(state)
                broadcaster.broadcast_state(state)
            start_delay_ms = get_claim_start_delay_ms(state)
            if start_delay_ms > 0 and (not any_owned) and (not team_ever_owned):
                until_ms = int(game_start_ms + start_delay_ms)
                if now_ms() < until_ms:
                    left_ms = max(0, until_ms - now_ms())
                    left_min = int((left_ms + 59999) // 60000)
                    json_response(self, HTTPStatus.BAD_REQUEST, {"error": f"Můžeš začít zabírat za {left_min} min."})
                    return

            pending = next(
                (
                    r
                    for r in (state.get("claimRequests", []) or [])
                    if isinstance(r, dict)
                    and r.get("status", "pending") == "pending"
                    and r.get("territoryId") == territory_id
                    and r.get("teamId") == team_id
                ),
                None,
            )
            if pending:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Žádost už čeká na schválení adminem."})
                return

            tasks = territory.get("tasks", {}) or {}
            req = {
                "id": "cr_" + secrets.token_hex(8),
                "territoryId": territory_id,
                "teamId": team_id,
                "question": str(tasks.get("claim") or ""),
                "answer": answer,
                "status": "pending",
                "rejectReason": None,
                "cooldownUntilMs": None,
                "createdAtMs": now_ms(),
                "resolvedAtMs": None,
            }
            state.setdefault("claimRequests", []).append(req)
            if "claimVerifyRequests" in state and isinstance(state.get("claimVerifyRequests"), list):
                state["claimVerifyRequests"] = [
                    r
                    for r in state.get("claimVerifyRequests", [])
                    if not (
                        isinstance(r, dict)
                        and r.get("territoryId") == territory_id
                        and r.get("teamId") == team_id
                        and r.get("status") == "approved"
                    )
                ]
            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True, "claimRequestId": req["id"]})
            return

        if parsed.path == "/api/admin/territory/setOwner":
            if session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return
            territory_id = str(body.get("territoryId") or "")
            owner_team_id = body.get("ownerTeamId")
            owner_team_id = None if owner_team_id in (None, "", "null") else str(owner_team_id)

            state = read_state()
            if is_game_locked(state):
                json_response(self, HTTPStatus.LOCKED, {"error": "Hra je ukončená."})
                return
            territory = next((t for t in state.get("territories", []) if t["id"] == territory_id), None)
            if not territory:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Území neexistuje."})
                return
            if owner_team_id is not None:
                team_exists = any(t.get("id") == owner_team_id for t in state.get("teams", []))
                if not team_exists:
                    json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Neplatný tým."})
                    return
            prev_owner = territory.get("ownerTeamId")
            
            # Stats Update
            ensure_team_stats(state)
            update_territory_ownership_time(state, territory)
            
            territory["ownerTeamId"] = owner_team_id
            
            if owner_team_id:
                stats = state["teamStats"].get(owner_team_id)
                if stats:
                    stats["captures"] = int(stats.get("captures", 0)) + 1
            
            add_event(
                state,
                "owner_set",
                territory_id=territory_id,
                team_ids=[str(prev_owner or ""), str(owner_team_id or "")],
                fromTeamId=prev_owner,
                toTeamId=owner_team_id,
            )
            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True})
            return

        if parsed.path == "/api/admin/territories/reset":
            if session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return

            state = read_state()
            for t in state.get("territories", []) or []:
                if isinstance(t, dict):
                    t["ownerTeamId"] = None
                    t["capturedAtMs"] = None
            state["attackLocks"] = {}
            state["territoryLocks"] = {}
            state["teamCooldowns"] = {}
            state["claimRequests"] = []
            state["claimVerifyRequests"] = []
            state["eventLog"] = []
            state["teamEverOwned"] = {}
            state["teamStats"] = {}
            # state["gpsOkByTerritoryId"] is client side, no need to clear here
            cfg = state.get("config", {})
            if not isinstance(cfg, dict):
                cfg = {}
                state["config"] = cfg
            cfg["gameStartMs"] = now_ms()
            cfg["gameLocked"] = False
            
            ensure_team_stats(state)
            
            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True})
            return

        if parsed.path == "/api/admin/game/setLocked":
            if session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return
            locked_raw = body.get("locked")
            locked = False
            if isinstance(locked_raw, bool):
                locked = locked_raw
            elif isinstance(locked_raw, (int, float)):
                locked = bool(locked_raw)
            else:
                locked = str(locked_raw or "").strip().lower() in ("1", "true", "yes", "y", "ok")
            
            state = read_state()
            cfg = state.get("config", {})
            if not isinstance(cfg, dict):
                cfg = {}
                state["config"] = cfg
            
            # If locking the game, update totalTimeMs for all owned territories and stop the clock (clear capturedAtMs)
            if locked and not cfg.get("gameLocked"):
                ensure_team_stats(state)
                for t in state.get("territories", []) or []:
                    if t.get("ownerTeamId") and t.get("capturedAtMs"):
                        update_territory_ownership_time(state, t)
                        t["capturedAtMs"] = None # Stop the clock
            
            cfg["gameLocked"] = bool(locked)
            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True, "gameLocked": bool(cfg["gameLocked"])})
            return

        if parsed.path == "/api/admin/claimRequest/resolve":
            if session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return
            request_id = str(body.get("claimRequestId") or "")
            correct_raw = body.get("correct")
            approve_raw = body.get("approve")
            if correct_raw is None:
                correct_raw = approve_raw

            correct = False
            if isinstance(correct_raw, bool):
                correct = correct_raw
            elif isinstance(correct_raw, (int, float)):
                correct = bool(correct_raw)
            else:
                correct = str(correct_raw or "").strip().lower() in ("1", "true", "yes", "y", "ok")
            if not request_id:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Chybí claimRequestId."})
                return

            state = read_state()
            if is_game_locked(state):
                json_response(self, HTTPStatus.LOCKED, {"error": "Hra je ukončená."})
                return
            req = next(
                (r for r in (state.get("claimRequests", []) or []) if isinstance(r, dict) and r.get("id") == request_id),
                None,
            )
            if not req:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Žádost neexistuje."})
                return
            if req.get("status", "pending") != "pending":
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Žádost už je vyřízená."})
                return

            territory_id = str(req.get("territoryId") or "")
            team_id = str(req.get("teamId") or "")
            territory = next((t for t in state.get("territories", []) if t.get("id") == territory_id), None)
            if not territory:
                req["status"] = "rejected"
                req["rejectReason"] = "territoryMissing"
                req["resolvedAtMs"] = now_ms()
                write_state(state)
                broadcaster.broadcast_state(state)
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Území už neexistuje."})
                return

            if correct:
                if territory.get("ownerTeamId") is not None:
                    req["status"] = "rejected"
                    req["rejectReason"] = "territoryAlreadyOwned"
                    req["resolvedAtMs"] = now_ms()
                    write_state(state)
                    broadcaster.broadcast_state(state)
                    json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Území už má vlastníka."})
                    return
                
                # Stats Update
                ensure_team_stats(state)
                # Previous owner (should be None here, but for safety)
                update_territory_ownership_time(state, territory)
                
                territory["ownerTeamId"] = team_id
                
                # Increment capture count
                stats = state["teamStats"].get(team_id)
                if stats:
                    stats["captures"] = int(stats.get("captures", 0)) + 1
                
                req["status"] = "approved"
                req["rejectReason"] = None
                req["cooldownUntilMs"] = None
                
                # Lock for 30 mins after capture
                lock_until = now_ms() + 30 * 60 * 1000
                set_territory_lock(state, territory_id, lock_until)

                # RACE CONDITION: Cancel all other pending claims/verifications for this territory
                # 1. Cancel pending claimRequests
                for other_req in state.get("claimRequests", []) or []:
                    if (
                        isinstance(other_req, dict)
                        and other_req.get("territoryId") == territory_id
                        and other_req.get("status") == "pending"
                        and other_req.get("id") != req["id"]
                    ):
                        other_req["status"] = "rejected"
                        other_req["rejectReason"] = "territoryCapturedByOther"
                        other_req["resolvedAtMs"] = now_ms()
                
                # 2. Cancel pending/active verifications
                for other_ver in state.get("claimVerifyRequests", []) or []:
                    if (
                        isinstance(other_ver, dict)
                        and other_ver.get("territoryId") == territory_id
                        and other_ver.get("status") in ("pending", "approved", "task_assigned")
                        # We don't necessarily need to cancel the winner's verification, but it's done anyway
                    ):
                        other_ver["status"] = "rejected"
                        other_ver["expiresAtMs"] = None
                        other_ver["resolvedAtMs"] = now_ms()

            else:
                req["status"] = "rejected"
                req["rejectReason"] = "wrongAnswer"
                cd_until = now_ms() + 30 * 60 * 1000
                set_lock(state, team_id, territory_id, cd_until)
                req["cooldownUntilMs"] = cd_until
            req["resolvedAtMs"] = now_ms()
            add_event(
                state,
                "claim",
                territory_id=territory_id,
                team_ids=[team_id],
                teamId=team_id,
                result=req.get("status"),
            )

            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True, "status": req["status"]})
            return

        if parsed.path == "/api/admin/claimVerifyRequest/resolve":
            if session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return
            request_id = str(body.get("claimVerifyRequestId") or "")
            ok_raw = body.get("ok")
            ok = True
            if ok_raw is not None:
                if isinstance(ok_raw, bool):
                    ok = ok_raw
                elif isinstance(ok_raw, (int, float)):
                    ok = bool(ok_raw)
                else:
                    ok = str(ok_raw or "").strip().lower() in ("1", "true", "yes", "y", "ok")
            if not request_id:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Chybí claimVerifyRequestId."})
                return

            state = read_state()
            if is_game_locked(state):
                json_response(self, HTTPStatus.LOCKED, {"error": "Hra je ukončená."})
                return
            req = next(
                (r for r in (state.get("claimVerifyRequests", []) or []) if isinstance(r, dict) and r.get("id") == request_id),
                None,
            )
            if not req:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Žádost neexistuje."})
                return
            if req.get("status", "pending") != "pending":
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Žádost už je vyřízená."})
                return

            req["resolvedAtMs"] = now_ms()
            if ok:
                req["status"] = "approved"
                req["expiresAtMs"] = now_ms() + 10 * 60 * 1000
            else:
                req["status"] = "rejected"
                req["expiresAtMs"] = None

            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True, "status": req["status"]})
            return

        if parsed.path == "/api/admin/claimVerifyRequest/assignTask":
            if session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return
            request_id = str(body.get("claimVerifyRequestId") or "")
            task_text = str(body.get("task") or "").strip()
            
            if not request_id:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Chybí claimVerifyRequestId."})
                return
            if not task_text:
                json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Chybí text úkolu."})
                return

            state = read_state()
            if is_game_locked(state):
                json_response(self, HTTPStatus.LOCKED, {"error": "Hra je ukončená."})
                return
            req = next(
                (r for r in (state.get("claimVerifyRequests", []) or []) if isinstance(r, dict) and r.get("id") == request_id),
                None,
            )
            if not req:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Žádost neexistuje."})
                return
            
            # Allow assigning task if it's approved OR pending (skip approval step if desired, but UI flows approved->task)
            # Actually, standard flow is Pending -> Approved -> TaskAssigned
            if req.get("status") not in ("approved", "pending"): 
                 # We allow pending too, in case admin wants to skip explicit "OK" and just assign task immediately
                 pass
            
            if req.get("status") == "rejected":
                 json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Žádost byla zamítnuta."})
                 return

            req["status"] = "task_assigned"
            req["assignedTask"] = task_text
            req["resolvedAtMs"] = now_ms()
            req["expiresAtMs"] = now_ms() + 60 * 60 * 1000 # 1 hour to complete task

            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True})
            return

        if parsed.path == "/api/admin/reset_teams":
            token = str(body.get("token") or "")
            session = sessions.get(token)
            if not session or session.get("role") != "admin":
                json_response(self, HTTPStatus.FORBIDDEN, {"error": "Jen admin."})
                return
            
            state = read_state()
            state["teams"] = [
                {"id": "1", "name": "Modrá", "color": "#0000ff", "pin": "modra"},
                {"id": "2", "name": "Červená", "color": "#ff0000", "pin": "cervena"},
                {"id": "3", "name": "Zelená", "color": "#00ff00", "pin": "zelena"},
                {"id": "4", "name": "Žlutá", "color": "#ffff00", "pin": "zluta"},
                {"id": "5", "name": "Oranžová", "color": "#ffa500", "pin": "oranzova"},
                {"id": "6", "name": "Fialová", "color": "#800080", "pin": "fialova"},
                {"id": "7", "name": "Růžová", "color": "#ffc0cb", "pin": "ruzova"},
            ]
            cfg = state.get("config", {})
            if not isinstance(cfg, dict):
                cfg = {}
                state["config"] = cfg
            cfg["adminPin"] = "1234"
            
            # Ensure territories are re-applied from GeoJSON
            try:
                apply_geojson_territories(state)
            except Exception:
                pass

            write_state(state)
            broadcaster.broadcast_state(state)
            json_response(self, HTTPStatus.OK, {"ok": True})
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"error": "Neznámý endpoint."})


def state_broadcast_worker() -> None:
    while True:
        try:
            state = read_state()
            broadcaster.broadcast_state(state)
        except Exception:
            pass
        time.sleep(5.0)


if __name__ == "__main__":
    os.chdir(os.getcwd())
    t2 = threading.Thread(target=state_broadcast_worker, daemon=True)
    t2.start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Server běží na http://localhost:{PORT}/")
    httpd.serve_forever()
