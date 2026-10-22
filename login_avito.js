import { chromium } from "playwright-core";
import path from "path";
import readline from "readline";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const avitoDataDir = process.env.AVITO_DATA_DIR || path.join(__dirname, "avito-data");
  if (!fs.existsSync(avitoDataDir)) {
    fs.mkdirSync(avitoDataDir, { recursive: true });
  }
  const storageStatePath = path.join(avitoDataDir, "storageState.json");

  const isLinux = process.platform === "linux";
  if (isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("Внимание: На Linux обнаружено отсутствие графического дисплея (DISPLAY / WAYLAND_DISPLAY).");
    console.error("Для ручного входа по SMS требуется графический интерфейс (X11, Wayland или VNC).");
    console.error("Либо вы можете авторизоваться на Windows/Mac и скопировать папку avito-data на этот сервер.\n");
  }

  console.log("========================================================");
  console.log(" Запуск браузера для авторизации на Avito...");
  console.log("========================================================");

  const customPath = process.env.AVITO_CHROME_PATH || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  const launchOptions = {
    headless: false,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check"
    ],
    viewport: null,
    locale: "ru-RU"
  };

  if (isLinux) {
    launchOptions.args.push("--no-sandbox");
  }

  let context = null;

  // 1. Custom path
  if (customPath && fs.existsSync(customPath)) {
    try {
      context = await chromium.launchPersistentContext(avitoDataDir, {
        ...launchOptions,
        executablePath: customPath
      });
      console.log(`Используется указанный браузер: ${customPath}`);
    } catch (e) {
      console.log("Не удалось запустить браузер по указанному пути, пробуем автопоиск...");
    }
  }

  // 2. Channels
  if (!context) {
    const channels = ["chrome", "msedge", "chromium"];
    for (const ch of channels) {
      try {
        context = await chromium.launchPersistentContext(avitoDataDir, {
          ...launchOptions,
          channel: ch
        });
        console.log(`Запущен браузер через канал: ${ch}`);
        break;
      } catch (err) {}
    }
  }

  // 3. Common Linux paths
  if (!context && isLinux) {
    const commonPaths = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    ];
    for (const binPath of commonPaths) {
      if (fs.existsSync(binPath)) {
        try {
          context = await chromium.launchPersistentContext(avitoDataDir, {
            ...launchOptions,
            executablePath: binPath
          });
          console.log(`Запущен браузер: ${binPath}`);
          break;
        } catch (err) {}
      }
    }
  }

  // 4. Default bundled chromium fallback
  if (!context) {
    try {
      context = await chromium.launchPersistentContext(avitoDataDir, launchOptions);
    } catch (err) {
      console.error("\nОшибка: Не удалось запустить ни один браузер!");
      console.error("Установите Google Chrome, Chromium или Microsoft Edge,");
      console.error("либо укажите путь к бинарнику через переменную AVITO_CHROME_PATH.\n");
      process.exit(1);
    }
  }

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  console.log("Открываем страницу Avito...");
  await page.goto("https://www.avito.ru/", { waitUntil: "domcontentloaded", timeout: 90000 });

  console.log("\n--------------------------------------------------------");
  console.log("👉 ИНСТРУКЦИЯ:");
  console.log("1. В открывшемся окне браузера нажмите кнопку 'Вход и регистрация' на Авито.");
  console.log("2. Введите свой номер телефона и подтвердите вход по СМС / пушу / паролю.");
  console.log("3. Убедитесь, что вы успешно вошли и в правом верхнем углу отображается ваш профиль.");
  console.log("4. Вернитесь в эту консоль и нажмите клавишу [ENTER].");
  console.log("--------------------------------------------------------\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  await new Promise((resolve) => {
    rl.question("Нажмите [ENTER] после того, как вошли в аккаунт: ", () => {
      rl.close();
      resolve();
    });
  });

  console.log("\nСохраняем сессию и cookies...");
  await context.storageState({ path: storageStatePath });
  console.log("--------------------------------------------------------");
  console.log("✅ УСПЕХ! Сессия авторизации сохранена в:");
  console.log(storageStatePath);
  console.log("--------------------------------------------------------");

  await context.close();
  console.log("Браузер закрыт. Теперь MCP-сервер Avito готов к работе!");
}

main().catch((err) => {
  console.error("Ошибка при авторизации:", err);
  process.exit(1);
});
