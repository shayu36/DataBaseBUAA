"""生成不包含本机凭据和临时数据的课程交付包。"""

import hashlib
import json
import os
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_NAME = "青行Qingxing_共享自行车数据库课程设计.zip"
SOURCE_EXTENSIONS = {
    "frontend": {
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".css",
        ".html",
        ".json",
        ".svg",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".woff",
        ".woff2",
    },
    "backend": {".mjs"},
    "scripts": {".mjs", ".py"},
    "database": {".sql", ".json"},
    "tests": {".mjs", ".ts", ".py"},
    "dist": {
        ".html",
        ".js",
        ".css",
        ".svg",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".woff",
        ".woff2",
    },
    "docs": {".md", ".html", ".svg"},
}
EXCLUDED_DIRS = {
    "node_modules",
    "__pycache__",
    "screenshots",
    "evidence",
    "superpowers",
    "test-results",
    "playwright-report",
}
EXCLUDED_FILES = {"demo-snapshot.sql"}
ROOT_FILES = (
    "README.md",
    "package.json",
    "package-lock.json",
    "playwright.config.ts",
    "tsconfig.json",
    ".env.example",
    ".gitignore",
)
REQUIRED_SOURCES = (
    "frontend/src/main.tsx",
    "backend/index.mjs",
    "database/schema.sql",
    "scripts/sql.mjs",
)
SECRET_KEYS = {"DB_PASSWORD", "DB_ADMIN_PASSWORD", "JWT_SECRET"}
ENV_LINE = re.compile(
    r"""^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$""",
    re.MULTILINE,
)


def project_files(root):
    files = []

    def raise_walk_error(error):
        raise error

    for folder, extensions in SOURCE_EXTENSIONS.items():
        base = root / folder
        if base.is_symlink():
            raise SystemExit(f"项目目录不能是符号链接：{folder}")
        for current, directories, names in os.walk(
            base, followlinks=False, onerror=raise_walk_error
        ):
            parent = Path(current)
            directories[:] = [
                name
                for name in directories
                if not name.startswith(".")
                and name not in EXCLUDED_DIRS
                and not (parent / name).is_symlink()
            ]
            for name in names:
                path = parent / name
                if (
                    not name.startswith(".")
                    and name not in EXCLUDED_FILES
                    and path.suffix.lower() in extensions
                    and path.is_file()
                    and not path.is_symlink()
                ):
                    files.append(path)
    for name in ROOT_FILES:
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"缺少项目文件或文件是符号链接：{name}")
        files.append(path)
    return sorted(files)


def local_secrets(root):
    values = {os.environ[key] for key in SECRET_KEYS if os.environ.get(key)}
    env_file = root / ".env"
    if env_file.is_file():
        for match in ENV_LINE.finditer(env_file.read_text(encoding="utf-8")):
            key, raw = match.groups()
            if key not in SECRET_KEYS:
                continue
            value = (raw or "").strip()
            if len(value) >= 2 and value[0] in "\"'`" and value[-1] == value[0]:
                quote, value = value[0], value[1:-1]
                if quote == '"':
                    value = value.replace("\\n", "\n").replace("\\r", "\r")
            if value:
                values.add(value)
    return [value.encode("utf-8") for value in values]


def package(root=ROOT):
    root = Path(root)
    required = (root / "dist/index.html", root / "docs/数据库课程设计报告.html")
    if not all(path.is_file() and not path.is_symlink() for path in required):
        raise SystemExit("请先运行 npm run build，生成前端和课程报告。")
    for name in REQUIRED_SOURCES:
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"缺少项目文件或文件是符号链接：{name}")
    files = project_files(root)
    secrets = local_secrets(root)
    output = root / "deliverables"
    if output.is_symlink():
        raise SystemExit("交付目录不能是符号链接。")
    output.mkdir(exist_ok=True)
    archive_path = output / ARCHIVE_NAME
    with TemporaryDirectory(dir=output, prefix=".package-") as temporary:
        staged = Path(temporary) / ARCHIVE_NAME
        with ZipFile(staged, "w", ZIP_DEFLATED, compresslevel=8) as archive:
            for path in files:
                archive.write(path, "qingxing/" + path.relative_to(root).as_posix())
        with ZipFile(staged) as archive:
            if archive.testzip() is not None:
                raise SystemExit("交付包校验失败。")
            overlap = max((len(secret) for secret in secrets), default=1) - 1
            for name in archive.namelist() if secrets else ():
                with archive.open(name) as source:
                    tail = b""
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        data = tail + chunk
                        if any(secret in data for secret in secrets):
                            raise SystemExit(f"交付包包含本机凭据：{name}")
                        tail = data[-overlap:] if overlap else b""
        digest = hashlib.sha256()
        with staged.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        summary = {
            "archive": str(archive_path),
            "files": len(files),
            "bytes": staged.stat().st_size,
            "sha256": digest.hexdigest(),
            "archive_verified": True,
            "local_credentials_excluded": True,
        }
        manifest = Path(temporary) / "交付清单.json"
        manifest.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(staged, archive_path)
        os.replace(manifest, output / "交付清单.json")
    return summary


if __name__ == "__main__":
    print(json.dumps(package(), ensure_ascii=False))
