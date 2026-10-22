#!/usr/bin/env node
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

if (process.platform !== "darwin") {
  console.log("LaunchAgent daemon setup is only applicable on macOS.");
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "avito-data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const homeDir = process.env.HOME;
const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
if (!fs.existsSync(launchAgentsDir)) {
  fs.mkdirSync(launchAgentsDir, { recursive: true });
}

const plistName = "com.foorsee.avito-chrome-cdp.plist";
const plistPath = path.join(launchAgentsDir, plistName);
const nodePath = process.execPath;
const scriptPath = path.join(rootDir, "scripts", "run_cdp.mjs");
const stdoutPath = path.join(dataDir, "cdp.stdout.log");
const stderrPath = path.join(dataDir, "cdp.stderr.log");

const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.foorsee.avito-chrome-cdp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${rootDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;

try {
  // If already loaded, unload first
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch (_) {}

  fs.writeFileSync(plistPath, plistContent, "utf-8");
  console.log(`[daemon] Wrote plist to ${plistPath}`);

  execSync(`launchctl load "${plistPath}"`);
  console.log(`[daemon] Successfully loaded LaunchAgent com.foorsee.avito-chrome-cdp`);
  console.log(`[daemon] Chrome CDP is now running persistently in background!`);
} catch (err) {
  console.error("[daemon] Failed to install LaunchAgent:", err.message);
  process.exit(1);
}
