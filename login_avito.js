import readline from "readline";
import { launchPersistentBrowser } from "./browser_launcher.mjs";

async function main() {
  const isLinux = process.platform === "linux";
  if (isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("\nВнимание: На Linux обнаружено отсутствие графического дисплея (DISPLAY / WAYLAND_DISPLAY).");
    console.error("Для ручного входа по SMS требуется графический интерфейс (X11, Wayland или VNC).");
    console.error("Либо вы можете авторизоваться на Windows/Mac и скопировать папку avito-data на этот сервер.\n");
  }

  console.log("========================================================");
  console.log(" Запуск браузера для авторизации на Avito...");
  console.log("========================================================");

  const { context, storagePath } = await launchPersistentBrowser({ isLogin: true });

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
  await context.storageState({ path: storagePath });
  console.log("--------------------------------------------------------");
  console.log("✅ УСПЕХ! Сессия авторизации сохранена в:");
  console.log(storagePath);
  console.log("--------------------------------------------------------");

  await context.close();
  console.log("Браузер закрыт. Теперь MCP-сервер Avito готов к работе!");
}

main().catch((err) => {
  console.error("Ошибка при авторизации:", err.message);
  process.exit(1);
});
