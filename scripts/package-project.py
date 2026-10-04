"""Build a coursework archive without local credentials, dependencies or MySQL files."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import hashlib

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "deliverables"
OUTPUT.mkdir(exist_ok=True)
ARCHIVE = OUTPUT / "青行Qingxing_共享自行车数据库课程设计.zip"
FOLDERS = ("src", "server", "scripts", "database", "tests", "dist", "docs")
EXCLUDED_DOCS = {"frontend-brief.md", "frontend-report.md", "implementation-plan.md", "progress.md"}
visual = json.loads((ROOT / 'docs/screenshots/visual-checks.json').read_text(encoding='utf-8'))
assert visual.get('completed') is True, 'Screenshot verification is incomplete'
assert len(visual['checks']) == 20 and not visual['errors']
assert all(not c['overflow'] and not c['alerts'] for c in visual['checks'])
files = []
for folder in FOLDERS:
    for file in (ROOT / folder).rglob("*"):
        if file.is_file() and file.name not in EXCLUDED_DOCS:
            files.append(file)
for name in ("README.md", "package.json", "package-lock.json", "index.html", "vite.config.ts", "playwright.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", ".env.example", ".gitignore", "启动系统.cmd", "停止系统.cmd"):
    files.append(ROOT / name)
with ZipFile(ARCHIVE, "w", ZIP_DEFLATED, compresslevel=8) as archive:
    for file in sorted(files):
        archive.write(file, "mysqpll/" + file.relative_to(ROOT).as_posix())

# Verify contents and verify exact local secret values do not appear in the archive.
secrets = []
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    key, _, value = line.partition("=")
    if key in {"DB_PASSWORD", "DB_ADMIN_PASSWORD", "JWT_SECRET"}:
        secrets.append(value.encode())
with ZipFile(ARCHIVE) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    assert "mysqpll/dist/index.html" in names
    assert "mysqpll/docs/数据库课程设计报告.html" in names
    assert "mysqpll/database/demo-snapshot.sql" in names
    for name in names:
        parts = Path(name).parts
        assert not any(part in {".env", ".runtime", "node_modules"} for part in parts)
        payload = archive.read(name)
        assert not any(secret in payload for secret in secrets), f"Unexpected local credential in {name}"
summary = {"archive": str(ARCHIVE), "files": len(files), "bytes": ARCHIVE.stat().st_size, "archive_verified": True, "sha256": hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), "snapshot_sha256": hashlib.sha256((ROOT / "database/demo-snapshot.sql").read_bytes()).hexdigest(), "local_credentials_excluded": True}
(OUTPUT / "交付清单.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False))
