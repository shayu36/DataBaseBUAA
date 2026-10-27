import importlib.util
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from zipfile import ZipFile

script = Path(__file__).resolve().parent.parent / "scripts/package-project.py"
spec = importlib.util.spec_from_file_location("package_project", script)
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageProjectTest(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        for folder in packager.SOURCE_EXTENSIONS:
            (self.root / folder).mkdir()
        for name in (
            *packager.ROOT_FILES,
            *packager.REQUIRED_SOURCES,
            "dist/index.html",
            "docs/数据库课程设计报告.html",
        ):
            self.write(name, "正常内容")

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_package_excludes_local_and_generated_files(self):
        self.write("frontend/.env.local", "本机配置")
        self.write("frontend/debug.log", "中间日志")
        self.write("frontend/node_modules/unsafe.js", "依赖")
        self.write("frontend/.cache/private.json", "缓存")
        self.write("database/demo-snapshot.sql", "快照")
        self.write("docs/evidence/test.md", "验证记录")
        self.write("frontend/src/main.tsx", "项目代码")
        self.write("dist/assets/site.js", "构建代码")
        result = packager.package(self.root)
        with ZipFile(result["archive"]) as archive:
            names = set(archive.namelist())
        self.assertIn("qingxing/frontend/src/main.tsx", names)
        self.assertIn("qingxing/dist/assets/site.js", names)
        self.assertIn("qingxing/.env.example", names)
        self.assertFalse(
            any(
                ".env.local" in name
                or "node_modules" in name
                or "debug.log" in name
                or "demo-snapshot" in name
                or "/evidence/" in name
                or "/.cache/" in name
                for name in names
            )
        )

    def test_symbolic_links_are_not_packaged(self):
        source = self.write("outside.txt", "不能打包")
        link = self.root / "frontend" / "private.json"
        try:
            link.symlink_to(source)
        except OSError:
            self.skipTest("本机无法创建符号链接")
        directory = self.root / "external"
        directory.mkdir()
        (directory / "private.js").write_text("不可打包", encoding="utf-8")
        try:
            (self.root / "frontend" / "external").symlink_to(
                directory, target_is_directory=True
            )
        except OSError:
            self.skipTest("本机无法创建目录符号链接")
        result = packager.package(self.root)
        with ZipFile(result["archive"]) as archive:
            self.assertNotIn("qingxing/frontend/private.json", archive.namelist())
            self.assertNotIn(
                "qingxing/frontend/external/private.js", archive.namelist()
            )

    def test_credential_scan_covers_chunk_boundaries(self):
        self.write(".env", "JWT_SECRET='跨块敏感凭据'\n")
        self.write("backend/leak.mjs", "x" * (1024 * 1024 - 1) + "跨块敏感凭据")
        with self.assertRaisesRegex(SystemExit, "本机凭据"):
            packager.package(self.root)
        self.assertFalse((self.root / "deliverables" / packager.ARCHIVE_NAME).exists())

    def test_credential_detection_preserves_existing_package(self):
        self.write(".env", 'DB_PASSWORD="独立测试凭据" # 注释\n')
        self.write("backend/leak.mjs", 'const token = "独立测试凭据";')
        previous = self.write("deliverables/" + packager.ARCHIVE_NAME, "原有交付包")
        with self.assertRaisesRegex(SystemExit, "本机凭据"):
            packager.package(self.root)
        self.assertEqual(previous.read_text(encoding="utf-8"), "原有交付包")
        self.assertEqual(
            sorted(path.name for path in previous.parent.iterdir()),
            [packager.ARCHIVE_NAME],
        )

    def test_missing_build_does_not_publish_archive(self):
        (self.root / "dist/index.html").unlink()
        with self.assertRaisesRegex(SystemExit, "npm run build"):
            packager.package(self.root)
        self.assertFalse((self.root / "deliverables").exists())


if __name__ == "__main__":
    unittest.main()
