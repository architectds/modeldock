import test from "node:test";
import assert from "node:assert/strict";
import { plistXml } from "../src/autostart.mjs";

test("macOS plist runs the Node gateway directly with KeepAlive", () => {
  const xml = plistXml(
    "/usr/local/Cellar/node/25.4.0/bin/node",
    "/Users/me/.modeldock/dist/modeldock.mjs",
    "/Users/me/.modeldock",
  );

  assert.match(xml, /<key>ProgramArguments<\/key>/);
  assert.match(
    xml,
    /<string>\/usr\/local\/Cellar\/node\/25\.4\.0\/bin\/node<\/string>\s*<string>\/Users\/me\/\.modeldock\/dist\/modeldock\.mjs<\/string>/,
  );
  assert.doesNotMatch(xml, /start-hidden/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(xml, /<key>MODELDOCK_NODE_PATH<\/key><string>\/usr\/local\/Cellar\/node\/25\.4\.0\/bin\/node<\/string>/);
  assert.match(xml, /\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
});

test("macOS plist keeps an Apple Silicon Homebrew node on the launchd PATH", () => {
  const xml = plistXml(
    "/opt/homebrew/Cellar/node/25.4.0/bin/node",
    "/Users/me/.modeldock/dist/modeldock.mjs",
    "/Users/me/.modeldock",
  );

  assert.match(xml, /<key>MODELDOCK_NODE_PATH<\/key><string>\/opt\/homebrew\/Cellar\/node\/25\.4\.0\/bin\/node<\/string>/);
  assert.match(xml, /\/opt\/homebrew\/Cellar\/node\/25\.4\.0\/bin:\/opt\/homebrew\/bin:/);
});
