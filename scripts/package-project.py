"""生成不包含本机凭据和临时数据的课程交付包。"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "deliverables"
OUTPUT.mkdir(exist_ok=True)
ARCHIVE = OUTPUT / "青行Qingxing_共享自行车数据库课程设计.zip"
FOLDERS = ("frontend", "backend", "scripts", "database", "tests", "dist", "docs")
EXCLUDED_PARTS = {"__pycache__", "screenshots", "evidence"}
EXCLUDED_FILES = {"demo-snapshot.sql"}

files = []
for folder in FOLDERS:
    for file in (ROOT / folder).rglob("*"):
        relative = file.relative_to(ROOT)
        if (
            file.is_file()
            and not EXCLUDED_PARTS.intersection(relative.parts)
            and file.name not in EXCLUDED_FILES
            and file.suffix not in {".tsbuildinfo", ".pyc"}
        ):
            files.append(file)
for name in (
    "README.md", "package.json", "package-lock.json", "playwright.config.ts",
    "tsconfig.json", ".env.example", ".gitignore",
):
    files.append(ROOT / name)

required = (ROOT / "dist/index.html", ROOT / "docs/数据库课程设计报告.html")
if not all(file.is_file() for file in required):
    raise SystemExit("请先运行 npm run build，生成前端和课程报告。")

with ZipFile(ARCHIVE, "w", ZIP_DEFLATED, compresslevel=8) as archive:
    for file in sorted(files):
        archive.write(file, "qingxing/" + file.relative_to(ROOT).as_posix())

secrets = []
env_file = ROOT / ".env"
for line in (env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []):
    key, _, value = line.partition("=")
    if key in {"DB_PASSWORD", "DB_ADMIN_PASSWORD", "JWT_SECRET"} and value:
        secrets.append(value.encode())
with ZipFile(ARCHIVE) as archive:
    if archive.testzip() is not None:
        raise SystemExit("交付包校验失败。")
    names = archive.namelist()
    for name in names:
        parts = Path(name).parts
        if any(part in {".env", ".runtime", "node_modules", "screenshots", "evidence"} for part in parts):
            raise SystemExit(f"交付包包含本机或临时文件：{name}")
        if any(secret in archive.read(name) for secret in secrets):
            raise SystemExit(f"交付包包含本机凭据：{name}")
summary = {
    "archive": str(ARCHIVE), "files": len(files), "bytes": ARCHIVE.stat().st_size,
    "sha256": hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
    "archive_verified": True, "local_credentials_excluded": True,
}
(OUTPUT / "交付清单.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False))
