#!/usr/bin/env node
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

if (process.platform !== "darwin") {
  console.log("LaunchAgent daemon setup is only applicable on macOS.");
  process.exit(0);
}

const homeDir = process.env.HOME;
const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.foorsee.avito-chrome-cdp.plist");

try {
  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
    } catch (_) {}
    fs.unlinkSync(plistPath);
    console.log("[daemon] Successfully unloaded and removed LaunchAgent plist.");
  } else {
    console.log("[daemon] LaunchAgent plist not found.");
  }
} catch (err) {
  console.error("[daemon] Error uninstalling LaunchAgent:", err.message);
  process.exit(1);
}
