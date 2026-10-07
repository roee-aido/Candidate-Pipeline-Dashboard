"""Local server for the Candidate Pipeline Dashboard.

Serves the static site and a small API that runs Apify Actors for the lead details page.
The Apify token is read on the server only: from the APIFY_TOKEN environment variable,
or from a local `.env` file (git-ignored). It is never sent to the browser or written to logs.

Run:   python server.py            then open http://localhost:8000
Port:  set PORT in the environment or in .env (default 8000).

Only the Python standard library is used (Python 3.9+).
"""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_dotenv(path):
    """Minimal KEY=VALUE reader for .env. Variables already set in the environment win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv(ROOT / ".env")

HOST = "127.0.0.1"  # local machine only
PORT = int(os.environ.get("PORT", "8000"))
APIFY_API = "https://api.apify.com/v2"

# The only Actors this server will run. Each has a fixed result limit and a hard cost cap
# (maxTotalChargeUsd), so a run can never cost more than the cap, whatever happens.
ACTORS = {
    "profile": {  # one Instagram profile by username / link
        "id": "apify~instagram-profile-scraper",
        "event": "profile",
        "max_results": 1,
        "cap_usd": 0.01,
    },
    "search": {  # Instagram profile search by name
        "id": "apify~instagram-search-scraper",
        "event": "result",
        "max_results": 5,
        "cap_usd": 0.03,
    },
}

RUN_TIMEOUT_SECS = 180   # Apify stops the run after this
WAIT_LIMIT_SECS = 240    # this server stops waiting after this
MAX_BODY_BYTES = 4096

USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
RESERVED_PATHS = {"p", "reel", "reels", "explore", "stories", "accounts", "tv", "direct", "about"}

STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "application/javascript; charset=utf-8"}

_pricing_cache = {}  # actor id -> (fetched_at, pricing dict)


class ApiError(Exception):
    """An error to return to the browser: HTTP status, stable code, Hebrew message."""

    def __init__(self, status, code, message):
        super().__init__(code)
        self.status, self.code, self.message = status, code, message


def apify_token():
    return os.environ.get("APIFY_TOKEN", "").strip()


def apify_request(method, path, body=None, timeout=30):
    """Calls the Apify API with the server-side token. Returns the parsed JSON 'data'."""
    token = apify_token()
    if not token:
        raise ApiError(503, "APIFY_TOKEN_MISSING",
                       "השרת לא מוגדר עם טוקן של Apify. הגדירו APIFY_TOKEN בקובץ .env והפעילו את השרת מחדש.")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{APIFY_API}{path}", data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8")).get("data")
    except urllib.error.HTTPError as err:
        try:
            info = json.loads(err.read().decode("utf-8")).get("error", {})
        except Exception:
            info = {}
        kind = info.get("type", "")
        if err.code == 401:
            raise ApiError(502, "APIFY_AUTH", "Apify דחה את הטוקן שמוגדר בשרת (שגוי או נמחק). בדקו את APIFY_TOKEN בקובץ .env.")
        if err.code == 402 or "usage" in kind or "credit" in kind:
            raise ApiError(502, "APIFY_CREDIT", "אין מספיק קרדיט בחשבון Apify להרצה הזו. בדקו את היתרה ב-console.apify.com.")
        raise ApiError(502, "APIFY_ERROR", f"Apify החזיר שגיאה ({err.code}{', ' + kind if kind else ''}).")
    except (urllib.error.URLError, TimeoutError):
        raise ApiError(504, "APIFY_UNREACHABLE", "לא ניתן להתחבר ל-Apify. בדקו את החיבור לאינטרנט ונסו שוב.")


def actor_pricing(mode):
    """Current price of the Actor's main event, read live from Apify (cached for 10 minutes)."""
    actor = ACTORS[mode]
    cached = _pricing_cache.get(actor["id"])
    if cached and time.time() - cached[0] < 600:
        return cached[1]

    req = urllib.request.Request(f"{APIFY_API}/acts/{actor['id']}")  # public Actor info, no token needed
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            info = json.loads(res.read().decode("utf-8"))["data"]
    except Exception:
        raise ApiError(504, "APIFY_UNREACHABLE", "לא ניתן לקרוא את מחיר ההרצה מ-Apify. בדקו את החיבור לאינטרנט.")

    now = datetime.now(timezone.utc).isoformat()
    current = [p for p in info.get("pricingInfos") or [] if (p.get("startedAt") or "") <= now]
    pricing = current[-1] if current else {}
    model = pricing.get("pricingModel", "UNKNOWN")
    price = None
    if model == "PAY_PER_EVENT":
        event = pricing.get("pricingPerEvent", {}).get("actorChargeEvents", {}).get(actor["event"], {})
        tiers = event.get("eventTieredPricingUsd") or {}
        # The FREE tier is the highest price, so the estimate is an upper bound for any plan.
        price = (tiers.get("FREE") or {}).get("tieredEventPriceUsd", event.get("eventPriceUsd"))

    result = {
        "mode": mode,
        "actor": actor["id"].replace("~", "/"),
        "actorTitle": info.get("title"),
        "pricingModel": model,
        "event": actor["event"],
        "pricePerResultUsd": price,
        "maxResults": actor["max_results"],
        "estimatedMaxUsd": round(price * actor["max_results"], 4) if price is not None else None,
        "hardCapUsd": actor["cap_usd"],
    }
    _pricing_cache[actor["id"]] = (time.time(), result)
    return result


def run_actor(mode, actor_input):
    """Starts the Actor, waits for it to finish, and returns (items, run summary)."""
    actor = ACTORS[mode]
    params = urllib.parse.urlencode({"timeout": RUN_TIMEOUT_SECS, "maxTotalChargeUsd": actor["cap_usd"]})
    run = apify_request("POST", f"/acts/{actor['id']}/runs?{params}", actor_input)

    started = time.time()
    while run.get("status") in ("READY", "RUNNING") and time.time() - started < WAIT_LIMIT_SECS:
        run = apify_request("GET", f"/actor-runs/{run['id']}?waitForFinish=60", timeout=75)

    if run.get("status") in ("READY", "RUNNING"):
        raise ApiError(504, "RUN_TOO_LONG", "ההרצה ב-Apify נמשכת יותר מדי זמן. בדקו את מצבה ב-console.apify.com.")
    if run.get("status") != "SUCCEEDED":
        raise ApiError(502, "RUN_FAILED", f"ההרצה ב-Apify לא הצליחה (סטטוס: {run.get('status')}).")

    query = urllib.parse.urlencode({"clean": "true", "format": "json", "limit": actor["max_results"]})
    token = apify_token()
    req = urllib.request.Request(f"{APIFY_API}/datasets/{run['defaultDatasetId']}/items?{query}",
                                 headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            items = json.loads(res.read().decode("utf-8"))
    except Exception:
        raise ApiError(502, "APIFY_ERROR", "ההרצה הסתיימה, אבל לא ניתן היה לקרוא את התוצאות מ-Apify.")
    return items, run_cost_summary(mode, run, items)


def run_cost_summary(mode, run, items):
    """Waits for Apify to record the run's charges, then summarizes the run and its cost.

    Apify records the charge a few seconds after the run ends (right at the end it still shows $0).
    Every row the Actor writes is charged, including "not_found" error rows (verified on a real run),
    so the wait is for one charged event per dataset row.
    """
    actor = ACTORS[mode]

    def charged(r):
        return (r.get("chargedEventCounts") or {}).get(actor["event"], 0)

    valid = sum(1 for item in items if normalize_profile(item))
    expected_events = len(items)
    for _ in range(6):
        if charged(run) >= expected_events:
            break
        time.sleep(2)
        run = apify_request("GET", f"/actor-runs/{run['id']}")

    # Pay-per-event Actors charge exactly (charged events x event price). Apify's usageTotalUsd field
    # catches up later than the event counts, so the cost is computed from the events when possible.
    price = actor_pricing(mode).get("pricePerResultUsd")
    summary = {
        "runId": run.get("id"),
        "status": run.get("status"),
        "finishedAt": run.get("finishedAt"),
        "results": valid,
        "chargedEvents": charged(run),
        "costUsd": round(charged(run) * price, 4) if price is not None else run.get("usageTotalUsd"),
        "apifyUsageUsd": run.get("usageTotalUsd"),
        "costConfirmed": charged(run) >= expected_events,
        "expectedCostUsd": round(price * expected_events, 4) if price is not None else None,
        "chargedEventCounts": run.get("chargedEventCounts") or {},
        "consoleUrl": f"https://console.apify.com/view/runs/{run.get('id')}",
    }
    return summary


def clean_text(value, limit):
    return str(value).strip()[:limit] if value not in (None, "") else ""


def normalize_profile(item):
    """Keeps only the public profile fields the page shows. Returns None for 'not found' items."""
    if not isinstance(item, dict) or item.get("error") or not item.get("username"):
        return None
    username = clean_text(item.get("username"), 30)
    return {
        "username": username,
        "fullName": clean_text(item.get("fullName"), 120),
        "url": f"https://www.instagram.com/{username}/",  # built from the username, so link and name always match
        "biography": clean_text(item.get("biography"), 1000),
        "externalUrl": clean_text(item.get("externalUrl"), 300),
        "followersCount": item.get("followersCount"),
        "followsCount": item.get("followsCount"),
        "postsCount": item.get("postsCount"),
        "verified": bool(item.get("verified")),
        "private": bool(item.get("private")),
        "isBusinessAccount": bool(item.get("isBusinessAccount")),
        "businessCategoryName": clean_text(item.get("businessCategoryName"), 120),
        "profilePicUrl": clean_text(item.get("profilePicUrl"), 1000),
    }


def username_from(value):
    """Accepts '@name', 'name' or an instagram.com profile link. Returns the username or None."""
    value = (value or "").strip()
    if "instagram.com" in value:
        if not value.startswith("http"):
            value = "https://" + value
        parsed = urllib.parse.urlparse(value)
        if not parsed.netloc.endswith("instagram.com"):
            return None
        parts = [p for p in parsed.path.split("/") if p]
        value = parts[0] if parts else ""
        if value.lower() in RESERVED_PATHS:
            return None
    value = value.lstrip("@")
    return value if USERNAME_RE.match(value) else None


def imported_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def api_profile(body):
    username = username_from(body.get("profile"))
    if not username:
        raise ApiError(400, "BAD_PROFILE", "הקישור לפרופיל לא תקין. הזינו קישור בצורה https://www.instagram.com/username/ או שם משתמש.")
    items, run = run_actor("profile", {"usernames": [username]})
    profiles = [p for p in map(normalize_profile, items) if p]
    if not profiles:
        return {"status": "not_found", "username": username, "run": run, "importedAt": imported_now()}
    return {"status": "ok", "profile": profiles[0], "run": run, "importedAt": imported_now()}


def api_search(body):
    query = clean_text(body.get("query"), 60)
    if len(query) < 2:
        raise ApiError(400, "BAD_QUERY", "יש להזין לפחות 2 תווים לחיפוש.")
    items, run = run_actor("search", {
        "search": query,
        "searchType": "user",
        "searchLimit": ACTORS["search"]["max_results"],
    })
    results = [p for p in map(normalize_profile, items) if p]
    return {"status": "ok" if results else "no_results", "query": query, "results": results,
            "run": run, "importedAt": imported_now()}


class Handler(SimpleHTTPRequestHandler):
    server_version = "CandidatePipeline/1.0"

    # ----- helpers -----
    def allowed_hosts(self):
        return {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, err):
        self.send_json(err.status, {"error": err.code, "message": err.message})

    def host_ok(self):
        # Rejects requests that reach this port under another host name (DNS rebinding protection).
        return self.headers.get("Host", "") in self.allowed_hosts()

    def log_message(self, fmt, *args):  # short log line, never includes headers or bodies
        print(f"[{self.log_date_time_string()}] {self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}")

    # ----- GET -----
    def do_GET(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "BAD_HOST"})
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/health":
            return self.send_json(200, {"ok": True, "apifyConfigured": bool(apify_token())})
        if path == "/api/apify/estimate":
            mode = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("mode", [""])[0]
            if mode not in ACTORS:
                return self.send_json(400, {"error": "BAD_MODE"})
            try:
                return self.send_json(200, actor_pricing(mode))
            except ApiError as err:
                return self.send_error_json(err)
        return self.serve_static(path)

    def serve_static(self, path):
        # Only the site's own files are served: never .env, server.py, .git or other project files.
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        allowed = rel in ("index.html", "forecast.html") or (rel.startswith(("css/", "js/")) and Path(rel).suffix in STATIC_TYPES)
        file = (ROOT / rel).resolve()
        if not allowed or ROOT not in file.parents or not file.is_file():
            return self.send_json(404, {"error": "NOT_FOUND"})
        body = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_TYPES[file.suffix])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ----- POST (paid Apify runs) -----
    def do_POST(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "BAD_HOST"})
        # Only this site may trigger runs: another website open in the browser must not spend Apify credit.
        if self.headers.get("Origin") not in {f"http://{h}" for h in self.allowed_hosts()}:
            return self.send_json(403, {"error": "BAD_ORIGIN", "message": "בקשה ממקור לא מורשה."})
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_json(415, {"error": "BAD_CONTENT_TYPE"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self.send_json(413, {"error": "TOO_LARGE"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except ValueError:
            return self.send_json(400, {"error": "BAD_JSON"})

        routes = {"/api/apify/instagram/profile": api_profile, "/api/apify/instagram/search": api_search}
        handler = routes.get(urllib.parse.urlparse(self.path).path)
        if not handler:
            return self.send_json(404, {"error": "NOT_FOUND"})
        try:
            self.send_json(200, handler(body))
        except ApiError as err:
            self.send_error_json(err)
        except Exception as err:  # unexpected: report generically, log the type only
            print(f"Unexpected error: {type(err).__name__}")
            self.send_json(500, {"error": "SERVER_ERROR", "message": "שגיאה לא צפויה בשרת המקומי."})


if __name__ == "__main__":
    print(f"Candidate Pipeline Dashboard: http://localhost:{PORT}")
    print(f"Apify token configured: {'yes' if apify_token() else 'no (set APIFY_TOKEN in .env)'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
