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

  console.log("========================================================");
  console.log(" Запуск браузера для авторизации на Avito...");
  console.log("========================================================");

  let context;
  const launchOptions = {
    headless: false,
    channel: "chrome",
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check"
    ],
    viewport: null,
    locale: "ru-RU"
  };

  try {
    context = await chromium.launchPersistentContext(avitoDataDir, launchOptions);
  } catch (err) {
    console.log("Переключаемся на Microsoft Edge...");
    try {
      context = await chromium.launchPersistentContext(avitoDataDir, {
        ...launchOptions,
        channel: "msedge"
      });
    } catch (e) {
      console.log("Запускаем стандартный chromium...");
      context = await chromium.launchPersistentContext(avitoDataDir, {
        ...launchOptions,
        channel: undefined
      });
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
