import os, time, base64, logging
import urllib.request, urllib.parse, json
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("seeder")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
SPOTIFY_ID   = os.environ["SPOTIFY_CLIENT_ID"]
SPOTIFY_SEC  = os.environ["SPOTIFY_CLIENT_SECRET"]

BASE = SUPABASE_URL.rstrip("/") + "/rest/v1"
SH   = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json"}

def rq(method, url, headers=None, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}

def get_token():
    creds = base64.b64encode(f"{SPOTIFY_ID}:{SPOTIFY_SEC}".encode()).decode()
    body  = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    r = urllib.request.Request("https://accounts.spotify.com/api/token", data=body,
        headers={"Authorization": "Basic " + creds, "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(r, timeout=10) as resp:
        d = json.loads(resp.read())
    token = d.get("access_token")
    if not token: raise RuntimeError("No token: " + str(d))
    log.info(f"Token OK ({token[:12]}...) expires={d.get('expires_in')}")
    return token, int(d.get("expires_in", 3600))

def search(token, name):
    url = f"https://api.spotify.com/v1/search?q={urllib.parse.quote(name)}&type=artist&limit=1"
    r = urllib.request.Request(url, headers={"Authorization": "Bearer " + token}, method="GET")
    try:
        with urllib.request.urlopen(r, timeout=8) as resp:
            items = json.loads(resp.read()).get("artists", {}).get("items", [])
            return items[0] if items else None
    except urllib.error.HTTPError as e:
        return "RATE_LIMIT" if e.code == 429 else None
    except Exception:
        return None

def run():
    log.info("=== Spotify Seeder starting ===")
    token, expires_in = get_token()
    token_at = time.time()

    artists, offset = [], 0
    while True:
        url = f"{BASE}/artists?select=id,name&spotify_id=is.null&limit=200&offset={offset}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=SH, method="GET"), timeout=10) as resp:
            batch = json.loads(resp.read())
        if not batch: break
        artists.extend(batch)
        if len(batch) < 200: break
        offset += 200
    log.info(f"Uncached artists: {len(artists)}")

    found = errors = 0
    for i, artist in enumerate(artists):
        if time.time() - token_at > (expires_in - 60):
            token, expires_in = get_token(); token_at = time.time()

        hit = search(token, artist["name"])
        if hit == "RATE_LIMIT":
            log.warning("Rate limited - sleeping 10s"); time.sleep(10)
            hit = search(token, artist["name"])

        if hit and isinstance(hit, dict) and hit.get("id"):
            now = datetime.now(timezone.utc).isoformat()
            rq("PATCH", f"{BASE}/artists?id=eq.{artist['id']}", SH, {"spotify_id": hit["id"]})
            rq("POST", f"{BASE}/artist_streaming_signals?on_conflict=artist_id",
                {**SH, "Prefer": "resolution=merge-duplicates,return=minimal"},
                {"artist_id": artist["id"], "captured_at": now,
                 "spotify_listeners": hit.get("followers", {}).get("total", 0),
                 "spotify_popularity": hit.get("popularity", 0)})
            found += 1
        else:
            errors += 1

        if (i + 1) % 50 == 0:
            log.info(f"  {i+1}/{len(artists)} | found={found} errors={errors}")
        time.sleep(0.15)

    log.info(f"=== DONE === found={found} errors={errors} total={len(artists)}")

if __name__ == "__main__":
    run()
