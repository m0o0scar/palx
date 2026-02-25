import { describe, it } from "node:test";
import assert from "node:assert";
import { parseArgs } from "./cli-args.mjs";

describe("parseArgs", () => {
  it("should return default options when no args are provided", () => {
    const options = parseArgs([]);
    assert.deepStrictEqual(options, {
      mode: "start",
      port: undefined,
      portExplicit: false,
      help: false,
    });
  });

  it("should set mode to 'dev' when --dev is provided", () => {
    const options = parseArgs(["--dev"]);
    assert.strictEqual(options.mode, "dev");
  });

  it("should set port when --port is provided", () => {
    const options = parseArgs(["--port", "8080"]);
    assert.strictEqual(options.port, 8080);
    assert.strictEqual(options.portExplicit, true);
  });

  it("should set port when -p is provided", () => {
    const options = parseArgs(["-p", "3000"]);
    assert.strictEqual(options.port, 3000);
    assert.strictEqual(options.portExplicit, true);
  });

  it("should set help to true when --help is provided", () => {
    const options = parseArgs(["--help"]);
    assert.strictEqual(options.help, true);
  });

  it("should set help to true when -h is provided", () => {
    const options = parseArgs(["-h"]);
    assert.strictEqual(options.help, true);
  });

  it("should return immediately when help is requested, ignoring subsequent errors", () => {
     const options = parseArgs(["--help", "--unknown"]);
     assert.strictEqual(options.help, true);
  });

  it("should throw error when --port value is missing", () => {
    assert.throws(() => parseArgs(["--port"]), /Missing value for --port/);
  });

  it("should throw error when port is invalid (not a number)", () => {
    assert.throws(() => parseArgs(["--port", "abc"]), /Invalid port: abc/);
  });

  it("should throw error when port is invalid (out of range)", () => {
    assert.throws(() => parseArgs(["--port", "70000"]), /Invalid port: 70000/);
    assert.throws(() => parseArgs(["--port", "0"]), /Invalid port: 0/);
  });

  it("should throw error on unknown option", () => {
    assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  });
});
