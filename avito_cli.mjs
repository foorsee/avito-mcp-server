#!/usr/bin/env node
import { searchAvito, getItemDetails, sendMessage, getChatHistory, listChats, closeBrowser } from "./avito_core.mjs";

const [cmd, ...args] = process.argv.slice(2);

async function run() {
  try {
    if (cmd === "search") {
      const query = args[0] || "iphone";
      const pmax = args[1] ? Number(args[1]) : undefined;
      const pmin = args[2] ? Number(args[2]) : undefined;
      const res = await searchAvito({ query, price_max: pmax, price_min: pmin, location: "all", limit: 10 });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "details") {
      const url = args[0];
      if (!url) throw new Error("Укажите URL или ID объявления");
      const res = await getItemDetails({ url });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "send") {
      const url = args[0];
      const msg = args.slice(1).join(" ");
      if (!url || !msg) throw new Error("Использование: send <url> <сообщение>");
      const res = await sendMessage({ url, message: msg });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "chats") {
      const res = await listChats({ limit: 10 });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "history") {
      const chatUrl = args[0];
      const res = await getChatHistory({ chat_url: chatUrl });
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log("Использование:");
      console.log("  node avito_cli.mjs search <запрос> [max_price] [min_price]");
      console.log("  node avito_cli.mjs details <url>");
      console.log("  node avito_cli.mjs chats");
      console.log("  node avito_cli.mjs history [chat_url]");
      console.log("  node avito_cli.mjs send <url> <сообщение>");
    }
  } catch (err) {
    console.error("CLI ERROR:", err.message);
    process.exit(1);
  } finally {
    await closeBrowser().catch(() => {});
  }
}

run();
