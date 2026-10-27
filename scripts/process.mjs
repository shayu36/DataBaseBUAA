import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

// Wait for both the child and stream completion; terminate on I/O failure.
export async function runProcess(binary, args, { input, output } = {}) {
  const child = spawn(binary, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    spawnError;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // A closed stdin can emit EPIPE when the child exits before reading input.
  child.stdin.on("error", () => {});
  const transfers = [];
  const track = (promise) =>
    promise.catch((error) => {
      if (error.code !== "EPIPE") child.kill();
      return error;
    });
  if (input) transfers.push(track(pipeline(input, child.stdin)));
  else child.stdin.end();
  if (output) transfers.push(track(pipeline(child.stdout, output)));
  else child.stdout.resume();
  const [{ code, signal }, ...errors] = await Promise.all([
    exited,
    ...transfers,
  ]);
  if (spawnError) throw spawnError;
  const ioError = errors.find((error) => error && error.code !== "EPIPE");
  if (ioError) throw ioError;
  if (code !== 0)
    throw new Error(`${binary} exited ${code ?? signal}: ${stderr}`);
  if (errors.some(Boolean)) throw errors.find(Boolean);
}
