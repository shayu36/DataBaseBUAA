import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../backend/db.mjs";
import { createSnapshotRunner } from "../backend/snapshot-runner.mjs";
import { seedDemo } from "../backend/demo-seed.mjs";
import { applySchema } from "../scripts/sql.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("snapshot runner coalesces overlapping calls and waits on stop", async () => {
  const gate = deferred();
  let count = 0;
  const runner = createSnapshotRunner(async () => {
    count++;
    await gate.promise;
  }, assert.fail);
  const first = runner.run();
  assert.equal(runner.run(), first);
  await Promise.resolve();
  assert.equal(count, 1);
  const stopped = runner.stop();
  assert.equal(stopped, first);
  await runner.run();
  assert.equal(count, 1);
  gate.resolve();
  await stopped;
  await runner.run();
  assert.equal(count, 1);
});

test("snapshot runner reports a failure and permits a later attempt", async () => {
  let count = 0;
  const errors = [];
  const runner = createSnapshotRunner(
    () => {
      if (++count === 1) throw new Error("采样失败");
    },
    (error) => errors.push(error.message),
  );
  await runner.run();
  await runner.run();
  assert.equal(count, 2);
  assert.deepEqual(errors, ["采样失败"]);
  await runner.stop();
});

test("application waits for in-flight snapshots on startup and shutdown", async () => {
  const database = `campus_bike_timer_test_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const root = createPool({ ...credentials, database: undefined });
  let pool,
    lock,
    child,
    created = false,
    locked = false;
  const entry = fileURLToPath(new URL("../", import.meta.url));
  const launch = () => {
    const source = `const original=globalThis.setInterval;
      globalThis.setInterval=(fn,ms,...args)=>original(fn,Math.min(ms,50),...args);
      process.on('message',message=>{if(message==='stop')process.emit('SIGTERM');});
      await import('./backend/index.mjs');`;
    const app = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: entry,
      env: {
        ...process.env,
        DB_NAME: database,
        DB_USER: credentials.user,
        DB_PASSWORD: credentials.password,
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    app.stdout.on("data", (chunk) => (output += chunk));
    app.stderr.on("data", (chunk) => (output += chunk));
    return { app, output: () => output };
  };
  const waitFor = async (predicate, description) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await sleep(50);
    }
    throw new Error(`${description}超时`);
  };
  const acquire = async () => {
    const [[{ acquired }]] = await lock.query(
      "SELECT GET_LOCK(CONCAT('campus-bike:',DATABASE()),2) AS acquired",
    );
    assert.equal(acquired, 1);
    locked = true;
  };
  const release = async () => {
    const [[{ released }]] = await lock.query(
      "SELECT RELEASE_LOCK(CONCAT('campus-bike:',DATABASE())) AS released",
    );
    assert.equal(released, 1);
    locked = false;
  };
  const waiters = async () => {
    const [[{ waiting }]] = await root.query(
      "SELECT COUNT(*) AS waiting FROM information_schema.processlist WHERE DB=? AND INFO LIKE 'SELECT GET_LOCK(%'",
      [database],
    );
    return Number(waiting);
  };
  const count = async () => {
    const [[row]] = await pool.query(
      "SELECT COUNT(*) AS count FROM zone_snapshots WHERE source='LIVE'",
    );
    return Number(row.count);
  };
  const stopWhileLocked = async (app, viaMessage = false) => {
    const exited = once(app, "exit");
    if (process.platform === "win32" || viaMessage) app.send("stop");
    else app.kill("SIGTERM");
    assert.equal(
      await Promise.race([
        exited.then(() => true),
        sleep(200).then(() => false),
      ]),
      false,
      "服务应等待正在执行的采样",
    );
    await release();
    const result = await Promise.race([
      exited,
      sleep(10000, undefined, { ref: false }).then(() => {
        throw new Error("服务退出超时");
      }),
    ]);
    assert.deepEqual(result, [0, null]);
  };
  try {
    await root.query(`CREATE DATABASE \`${database}\``);
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await seedDemo(pool, pool);
    lock = await pool.getConnection();

    await acquire();
    let app = launch();
    child = app.app;
    await waitFor(() => app.output().includes("Qingxing ready"), "服务启动");
    await waitFor(async () => (await waiters()) === 1, "启动采样等待锁");
    await stopWhileLocked(child);
    child = null;
    assert.equal(await count(), 6);

    app = launch();
    child = app.app;
    await waitFor(async () => (await count()) >= 12, "首次采样");
    await acquire();
    const before = await count();
    await waitFor(async () => (await waiters()) >= 1, "周期采样等待锁");
    await sleep(400);
    assert.equal(await waiters(), 1, "重叠周期只应产生一次等待");
    await stopWhileLocked(child, true);
    child = null;
    assert.equal(await count(), before + 6);
  } finally {
    if (locked) await release();
    if (lock) lock.release();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(10000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    if (pool) await pool.end();
    if (created) await root.query(`DROP DATABASE \`${database}\``);
    await root.end();
  }
});
