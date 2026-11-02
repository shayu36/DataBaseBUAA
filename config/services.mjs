import dotenv from "dotenv";

dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });

/** @param {Record<string, string | undefined>} env */
export function serviceConfig(env = process.env) {
  /** @param {string} name @param {number} fallback @param {number} minimum */
  const port = (name, fallback, minimum) => {
    const value = env[name] || String(fallback);
    if (
      !/^\d+$/.test(value) ||
      Number(value) < minimum ||
      Number(value) > 65535
    )
      throw new Error(`${name} 必须是 ${minimum} 至 65535 之间的整数`);
    return Number(value);
  };
  const backendHost = env.HOST || "127.0.0.1";
  const backendPort = port("PORT", 5188, 0);
  const frontendPort = port("FRONTEND_PORT", 5189, 1);
  const targetHost =
    backendHost === "0.0.0.0"
      ? "127.0.0.1"
      : backendHost === "::"
        ? "::1"
        : backendHost;
  const address = targetHost.includes(":") ? `[${targetHost}]` : targetHost;
  return {
    backendHost,
    backendPort,
    frontendPort,
    backendURL: `http://${address}:${backendPort}`,
    frontendURL: `http://127.0.0.1:${frontendPort}`,
  };
}
