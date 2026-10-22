#!/usr/bin/env node
import { chromium } from "playwright-core";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { findSystemChromePath, getDataDir, getStorageStatePath } from "../browser_launcher.mjs";

const dataDir = getDataDir();
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 1. Temporarily unload LaunchAgent on macOS if running
const plistPath = path.join(process.env.HOME || "", "Library/LaunchAgents/com.foorsee.avito-chrome-cdp.plist");
let hadDaemon = false;
if (fs.existsSync(plistPath)) {
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
    hadDaemon = true;
    console.log("[solve] Временно приостановлен фоновый демон LaunchAgent...");
  } catch (_) {}
}

// Kill any stray Chrome processes holding avito-data lock
try {
  execSync(`pkill -f "Google Chrome.*avito-data" 2>/dev/null`);
} catch (_) {}

// Clean stale locks
for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
  const p = path.join(dataDir, f);
  try {
    if (fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) {
      fs.unlinkSync(p);
    }
  } catch (_) {}
}

async function main() {
  const chromePath = findSystemChromePath();
  console.log("========================================================================");
  console.log(" 🧩 Запуск браузера с графическим интерфейсом для решения капчи Авито...");
  console.log("========================================================================");

  let defaultUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  if (process.platform === "darwin") {
    defaultUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  } else if (process.platform === "linux") {
    defaultUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }

  const context = await chromium.launchPersistentContext(dataDir, {
    headless: false,
    executablePath: chromePath,
    viewport: null,
    locale: "ru-RU",
    userAgent: defaultUa,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  console.log("Открываем https://www.avito.ru/ ...");
  await page.goto("https://www.avito.ru/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

  await page.waitForTimeout(1500);

  // If "Продолжить" button exists, click it automatically to open the puzzle
  try {
    const btn = await page.$("button:has-text('Продолжить'), [class*='button']:has-text('Продолжить')");
    if (btn) {
      console.log("Нажимаем кнопку 'Продолжить' для открытия пазла...");
      await btn.click();
    }
  } catch (_) {}

  console.log("\n------------------------------------------------------------------------");
  console.log("👉 ИНСТРУКЦИЯ:");
  console.log("1. В открывшемся окне браузера решите пазл (переместите слайдер).");
  console.log("2. Как только капча будет решена, этот скрипт определит это автоматически.");
  console.log("   (Либо нажмите [ENTER] в этой консоли, если капча уже пройдена).");
  console.log("------------------------------------------------------------------------\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let resolved = false;

  const waitManual = new Promise((resolve) => {
    rl.question("Нажмите [ENTER] после решения капчи: ", () => {
      resolved = true;
      rl.close();
      resolve();
    });
  });

  const waitAuto = (async () => {
    while (!resolved) {
      await new Promise((r) => setTimeout(r, 1500));
      if (resolved) break;
      const title = await page.title().catch(() => "");
      const bodyText = await page.innerText("body").catch(() => "");
      const isBlocked =
        title.includes("Доступ ограничен") ||
        title.includes("проблема с IP") ||
        title.includes("проверка безопасности") ||
        bodyText.includes("Доступ ограничен: проблема с IP");

      if (!isBlocked && title) {
        console.log(`\n🎉 Капча успешно пройдена! Заголовок страницы: "${title}"`);
        resolved = true;
        rl.close();
        break;
      }
    }
  })();

  await Promise.race([waitManual, waitAuto]);

  console.log("Сохраняем сессию и cookies...");
  const storageStatePath = getStorageStatePath(dataDir);
  await context.storageState({ path: storageStatePath }).catch(() => {});
  await context.close().catch(() => {});
  console.log("Браузер закрыт.");

  if (hadDaemon) {
    console.log("Возобновляем работу фонового демона LaunchAgent...");
    try {
      execSync(`launchctl load "${plistPath}"`);
      console.log("Фоновый демон перезапущен!");
    } catch (e) {
      console.error("Не удалось перезапустить демон:", e.message);
    }
  }

  console.log("========================================================================");
  console.log("✅ УСПЕХ! Блокировка снята, куки обновлены. MCP готов к работе.");
  console.log("========================================================================");
}

main().catch((err) => {
  console.error("Ошибка:", err);
  process.exit(1);
});
