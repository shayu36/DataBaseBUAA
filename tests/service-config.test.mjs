import test from "node:test";
import assert from "node:assert/strict";
import { serviceConfig } from "../config/services.mjs";

test("service addresses follow the configured ports and retain local defaults", () => {
  const defaults = serviceConfig({});
  assert.equal(defaults.backendURL, "http://127.0.0.1:5188");
  assert.equal(defaults.frontendURL, "http://127.0.0.1:5189");
  const custom = serviceConfig({
    HOST: "localhost",
    PORT: "6210",
    FRONTEND_PORT: "6211",
  });
  assert.equal(custom.backendURL, "http://localhost:6210");
  assert.equal(custom.frontendURL, "http://127.0.0.1:6211");
  assert.equal(custom.backendPort, 6210);
  assert.equal(custom.frontendPort, 6211);
});

test("proxy addresses use loopback for wildcard bindings and support IPv6", () => {
  assert.equal(
    serviceConfig({ HOST: "0.0.0.0" }).backendURL,
    "http://127.0.0.1:5188",
  );
  assert.equal(serviceConfig({ HOST: "::" }).backendURL, "http://[::1]:5188");
  assert.equal(serviceConfig({ HOST: "::1" }).backendURL, "http://[::1]:5188");
  assert.equal(serviceConfig({ PORT: "0" }).backendPort, 0);
});

test("invalid port settings fail before a server starts", () => {
  for (const name of ["PORT", "FRONTEND_PORT"])
    for (const value of ["-1", "65536", "12.5", "abc", " ", "1e3"])
      assert.throws(() => serviceConfig({ [name]: value }), new RegExp(name));
  assert.throws(() => serviceConfig({ FRONTEND_PORT: "0" }), /FRONTEND_PORT/);
});
