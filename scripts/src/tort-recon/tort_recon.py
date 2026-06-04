#!/usr/bin/env python3
"""
tort_recon.py — single-target OSINT enrichment for mass-tort lead acquisition.

Chains: maigret (username -> accounts + extracted name/bio/location)
        holehe  (email   -> sites where email is registered)
        ghunt   (gmail   -> google account profile)            [optional, needs auth]
        phoneinfoga (phone -> carrier/line footprint)          [optional, needs binary]

Outputs into --out:
    <slug>.json   full machine-readable dossier  (pipe into MTOS / HubSpot)
    <slug>.html   human-readable report
    <slug>_leads.csv  flattened contactable signals for your intake pipeline

Only queries PUBLIC sources. It does not dial, text, or contact anyone.
Contact/consent is a downstream step you own (TCPA/HIPAA live there, not here).

Usage:
    python3 tort_recon.py --username jdoe --email j@x.com --name "John Doe"
    python3 tort_recon.py --email a@x.com --email b@y.com --username jdoe --phone +15551234567 \
        --out ./reports --top-sites 300 --timeout 15 --ghunt --phoneinfoga
"""
import argparse, csv, glob, html, json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timezone

# ---------- helpers ----------------------------------------------------------

def have(tool: str) -> bool:
    return shutil.which(tool) is not None

def slugify(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", s).strip("_") or "target"

def run(cmd, timeout, cwd=None):
    """Run a subprocess, return (rc, stdout, stderr, timed_out)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr, False
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", e.stderr or "", True
    except FileNotFoundError:
        return 127, "", f"binary not found: {cmd[0]}", False

# ---------- collectors -------------------------------------------------------

def collect_maigret(username, outdir, top_sites, timeout, conns):
    res = {"tool": "maigret", "input": username, "status": "skipped", "hits": []}
    if not have("maigret"):
        res["error"] = "maigret not installed (pip install maigret)"
        return res
    # per-site timeout * a cap; give the whole run generous wall time
    wall = max(180, top_sites * 2)
    rc, out, err, to = run(
        ["maigret", username, "--top-sites", str(top_sites),
         "--timeout", str(timeout), "-n", str(conns),
         "-J", "ndjson", "-fo", outdir, "--no-color"],
        timeout=wall, cwd=outdir)
    report = os.path.join(outdir, f"report_{username}_ndjson.json")
    if not os.path.exists(report):
        res["status"] = "error"
        res["error"] = ("timeout" if to else "no report produced")
        res["stderr_tail"] = (err or out)[-400:]
        return res
    for ln in open(report, encoding="utf-8", errors="replace"):
        ln = ln.strip()
        if not ln:
            continue
        try:
            d = json.loads(ln)
        except json.JSONDecodeError:
            continue
        st = d.get("status", {}) or {}
        if st.get("status") == "Claimed":
            ids = st.get("ids", {}) or {}
            res["hits"].append({
                "site": st.get("site_name") or d.get("url_main"),
                "url": d.get("url_user"),
                "fullname": ids.get("fullname"),
                "bio": ids.get("bio"),
                "location": ids.get("location"),
                "image": ids.get("image"),
                "extra": {k: v for k, v in ids.items()
                          if k not in ("fullname", "bio", "location", "image")},
            })
    res["status"] = "ok"
    res["count"] = len(res["hits"])
    return res

def collect_holehe(email, outdir, timeout):
    res = {"tool": "holehe", "input": email, "status": "skipped", "hits": []}
    if not have("holehe"):
        res["error"] = "holehe not installed (pip install holehe)"
        return res
    before = set(glob.glob(os.path.join(outdir, "holehe_*.csv")))
    rc, out, err, to = run(
        ["holehe", email, "--only-used", "--no-color", "-C"],
        timeout=max(120, timeout * 10), cwd=outdir)
    after = set(glob.glob(os.path.join(outdir, "holehe_*.csv")))
    new = sorted(after - before)
    if not new:
        res["status"] = "error"
        res["error"] = ("timeout" if to else "no csv produced")
        return res
    csv_path = new[-1]
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            if str(row.get("exists")).strip().lower() == "true":
                res["hits"].append({
                    "site": row.get("name"),
                    "domain": row.get("domain"),
                    "email_recovery": row.get("emailrecovery") or None,
                    "phone_hint": row.get("phoneNumber") or None,
                })
    res["status"] = "ok"
    res["count"] = len(res["hits"])
    return res

def collect_ghunt(email, outdir, timeout):
    res = {"tool": "ghunt", "input": email, "status": "skipped"}
    if not have("ghunt"):
        res["error"] = "ghunt not installed (pip install ghunt)"
        return res
    if not email.lower().endswith("@gmail.com"):
        res["error"] = "not a gmail address; skipped"
        return res
    jpath = os.path.join(outdir, f"ghunt_{slugify(email)}.json")
    rc, out, err, to = run(["ghunt", "email", "--json", jpath, email],
                           timeout=max(60, timeout * 6), cwd=outdir)
    if os.path.exists(jpath):
        try:
            res["data"] = json.load(open(jpath, encoding="utf-8"))
            res["status"] = "ok"
            return res
        except json.JSONDecodeError:
            pass
    res["status"] = "error"
    # most common failure: not authenticated
    res["error"] = "no data (run `ghunt login` first to authenticate)"
    res["stderr_tail"] = (err or out)[-400:]
    return res

def collect_phoneinfoga(phone, outdir, timeout):
    res = {"tool": "phoneinfoga", "input": phone, "status": "skipped"}
    if not have("phoneinfoga"):
        res["error"] = "phoneinfoga not installed (download release binary)"
        return res
    rc, out, err, to = run(["phoneinfoga", "scan", "-n", phone],
                           timeout=max(60, timeout * 4), cwd=outdir)
    if to:
        res["status"] = "error"; res["error"] = "timeout"; return res
    res["status"] = "ok"
    res["raw"] = out.strip()
    return res

# ---------- report builders --------------------------------------------------

def build_leads_csv(dossier, path):
    """Flatten signals into rows your intake/CRM can ingest."""
    rows = []
    name_guess = dossier["target"].get("name")
    # prefer an extracted fullname from maigret if no name given
    for blk in dossier["results"]:
        if blk["tool"] == "maigret":
            for h in blk.get("hits", []):
                if h.get("fullname"):
                    name_guess = name_guess or h["fullname"]
                rows.append({
                    "name": h.get("fullname") or "",
                    "signal_type": "social_account",
                    "platform": h.get("site") or "",
                    "value": h.get("url") or "",
                    "location": h.get("location") or "",
                    "source_input": blk["input"],
                    "source_tool": "maigret",
                    "consent": "",  # you fill this in your pipeline
                })
        elif blk["tool"] == "holehe":
            for h in blk.get("hits", []):
                rows.append({
                    "name": name_guess or "",
                    "signal_type": "email_registration",
                    "platform": h.get("site") or "",
                    "value": h.get("domain") or "",
                    "location": "",
                    "source_input": blk["input"],
                    "source_tool": "holehe",
                    "consent": "",
                })
    fields = ["name", "signal_type", "platform", "value", "location",
              "source_input", "source_tool", "consent"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    return len(rows)

def build_html(dossier, path):
    t = dossier["target"]
    e = html.escape
    parts = [f"""<!doctype html><html><head><meta charset="utf-8">
<title>Recon dossier — {e(dossier['slug'])}</title>
<style>
 body{{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}}
 .wrap{{max-width:860px;margin:0 auto;padding:28px}}
 h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:26px 0 8px;color:#7cc4ff}}
 .meta{{color:#8a8f98;font-size:12px;margin-bottom:18px}}
 .card{{background:#171a21;border:1px solid #242833;border-radius:8px;padding:12px 14px;margin:8px 0}}
 a{{color:#7cc4ff;text-decoration:none}} a:hover{{text-decoration:underline}}
 .tag{{display:inline-block;background:#242833;border-radius:4px;padding:1px 7px;font-size:11px;color:#9aa4b2;margin-right:6px}}
 .ok{{color:#5fd38d}} .err{{color:#e57373}} .skip{{color:#8a8f98}}
 .kv{{color:#9aa4b2}} .note{{font-size:12px;color:#8a8f98;border-left:3px solid #3a3f4b;padding-left:10px;margin:14px 0}}
 table{{width:100%;border-collapse:collapse;font-size:13px}} td,th{{text-align:left;padding:5px 8px;border-bottom:1px solid #242833;vertical-align:top}}
</style></head><body><div class="wrap">
<h1>Recon dossier — {e(t.get('name') or dossier['slug'])}</h1>
<div class="meta">generated {e(dossier['generated_utc'])} · inputs:
 user={e(','.join(t.get('usernames',[])) or '—')} ·
 email={e(','.join(t.get('emails',[])) or '—')} ·
 phone={e(t.get('phone') or '—')}</div>
<div class="note">Public-source enrichment only. No contact was made. Verify identity and
 capture consent/opt-in in your intake system before any outreach (TCPA/HIPAA apply downstream).</div>
"""]
    for blk in dossier["results"]:
        cls = {"ok": "ok", "error": "err", "skipped": "skip"}.get(blk["status"], "")
        head = f'<h2>{e(blk["tool"])} <span class="{cls}">[{e(blk["status"])}]</span>'
        if "count" in blk:
            head += f' <span class="kv">— {blk["count"]} hits</span>'
        head += "</h2>"
        parts.append(head)
        if blk.get("error"):
            parts.append(f'<div class="card err">{e(blk["error"])}</div>')
        if blk["tool"] == "maigret" and blk.get("hits"):
            parts.append("<table><tr><th>Site</th><th>Profile</th><th>Extracted</th></tr>")
            for h in blk["hits"]:
                extra = " ".join(
                    f'<span class="tag">{e(str(k))}={e(str(v))}</span>'
                    for k, v in {"name": h.get("fullname"),
                                 "loc": h.get("location")}.items() if v)
                bio = e((h.get("bio") or "")[:140])
                parts.append(
                    f'<tr><td>{e(str(h.get("site")))}</td>'
                    f'<td><a href="{e(str(h.get("url")))}">link</a></td>'
                    f'<td>{extra}{("<br>"+bio) if bio else ""}</td></tr>')
            parts.append("</table>")
        if blk["tool"] == "holehe" and blk.get("hits"):
            parts.append("<table><tr><th>Site</th><th>Domain</th><th>Recovery hints</th></tr>")
            for h in blk["hits"]:
                hints = " ".join(f'<span class="tag">{e(k)}</span>'
                                 for k in ("email_recovery", "phone_hint")
                                 if h.get(k))
                parts.append(
                    f'<tr><td>{e(str(h.get("site")))}</td>'
                    f'<td>{e(str(h.get("domain")))}</td><td>{hints}</td></tr>')
            parts.append("</table>")
        if blk["tool"] == "ghunt" and blk.get("status") == "ok":
            parts.append(f'<div class="card"><pre>{e(json.dumps(blk.get("data",{}),indent=2)[:2000])}</pre></div>')
        if blk["tool"] == "phoneinfoga" and blk.get("raw"):
            parts.append(f'<div class="card"><pre>{e(blk["raw"][:2000])}</pre></div>')
    parts.append("</div></body></html>")
    open(path, "w", encoding="utf-8").write("".join(parts))

# ---------- main -------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Single-target OSINT enrichment for lead acquisition.")
    ap.add_argument("--username", action="append", default=[], help="username (repeatable)")
    ap.add_argument("--email", action="append", default=[], help="email (repeatable)")
    ap.add_argument("--name", help="known full name (optional, used for labeling)")
    ap.add_argument("--phone", help="phone in E.164, e.g. +15551234567")
    ap.add_argument("--out", default="./reports", help="output dir")
    ap.add_argument("--top-sites", type=int, default=300, help="maigret site count")
    ap.add_argument("--timeout", type=int, default=15, help="per-request timeout (s)")
    ap.add_argument("--connections", type=int, default=50, help="maigret concurrency")
    ap.add_argument("--ghunt", action="store_true", help="also run GHunt on gmail addrs")
    ap.add_argument("--phoneinfoga", action="store_true", help="also run PhoneInfoga on --phone")
    args = ap.parse_args()

    if not (args.username or args.email or args.phone):
        ap.error("give at least one of --username / --email / --phone")

    slug = slugify(args.name or (args.username[0] if args.username else
                   (args.email[0] if args.email else args.phone)))
    outdir = os.path.abspath(args.out)
    os.makedirs(outdir, exist_ok=True)

    dossier = {
        "slug": slug,
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"),
        "target": {"name": args.name, "usernames": args.username,
                   "emails": args.email, "phone": args.phone},
        "results": [],
    }

    print(f"[*] target slug: {slug}")
    print(f"[*] tools present: maigret={have('maigret')} holehe={have('holehe')} "
          f"ghunt={have('ghunt')} phoneinfoga={have('phoneinfoga')}")

    for u in args.username:
        print(f"[*] maigret -> {u}")
        dossier["results"].append(
            collect_maigret(u, outdir, args.top_sites, args.timeout, args.connections))
    for em in args.email:
        print(f"[*] holehe -> {em}")
        dossier["results"].append(collect_holehe(em, outdir, args.timeout))
        if args.ghunt:
            print(f"[*] ghunt -> {em}")
            dossier["results"].append(collect_ghunt(em, outdir, args.timeout))
    if args.phone and args.phoneinfoga:
        print(f"[*] phoneinfoga -> {args.phone}")
        dossier["results"].append(collect_phoneinfoga(args.phone, outdir, args.timeout))

    json_path = os.path.join(outdir, f"{slug}.json")
    html_path = os.path.join(outdir, f"{slug}.html")
    csv_path = os.path.join(outdir, f"{slug}_leads.csv")
    json.dump(dossier, open(json_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    n = build_leads_csv(dossier, csv_path)
    build_html(dossier, html_path)

    total = sum(b.get("count", 0) for b in dossier["results"])
    print(f"\n[+] {total} signals across all sources, {n} lead rows")
    print(f"[+] {json_path}")
    print(f"[+] {html_path}")
    print(f"[+] {csv_path}")

if __name__ == "__main__":
    main()