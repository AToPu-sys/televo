# Minimal App Store Connect API client. Credentials from ~/.appstoreconnect/config.env (never printed).
#   uv run --with pyjwt --with cryptography scripts/asc/asc.py GET /v1/apps?filter[bundleId]=...
import json, os, sys, time, urllib.request, urllib.error
import jwt
cfg = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~/.appstoreconnect/config.env")) if "=" in l)
def token():
    key = open(cfg["ASC_KEY_PATH"]).read()
    now = int(time.time())
    return jwt.encode({"iss": cfg["ASC_ISSUER_ID"], "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"}, key,
                      algorithm="ES256", headers={"kid": cfg["ASC_KEY_ID"], "typ": "JWT"})
def call(method, path, body=None):
    req = urllib.request.Request("https://api.appstoreconnect.apple.com" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read(); return e.code, (json.loads(t) if t else None)
if __name__ == "__main__":
    st, js = call(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else None)
    print(st); print(json.dumps(js, ensure_ascii=False, indent=1)[:6000])
