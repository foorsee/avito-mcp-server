#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.AVITO_DATA_DIR || path.join(__dirname, "..", "avito-data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (_) {}
  }
  return {};
}

function saveConfig(cfg) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

function ask(rl, query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function run() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const totalRamGb = os.totalmem() / 1024 / 1024 / 1024;
  const isLowMemory = totalRamGb < 3.5;

  // Non-interactive CLI flag mode
  if (args.includes("--stt") || args.includes("--groq-key") || args.includes("--help")) {
    if (args.includes("--help")) {
      console.log("Использование:");
      console.log("  node scripts/setup.mjs [параметры]");
      console.log("Параметры:");
      console.log("  --stt <sber|whisper|off|auto>   Выбрать движок распознавания");
      console.log("  --groq-key <key>                Ключ Groq API (для бесплатного Whisper)");
      console.log("  --openai-key <key>              Ключ OpenAI API");
      process.exit(0);
    }

    const sttIdx = args.indexOf("--stt");
    if (sttIdx !== -1 && args[sttIdx + 1]) {
      cfg.stt_engine = args[sttIdx + 1].toLowerCase();
    }
    const groqIdx = args.indexOf("--groq-key");
    if (groqIdx !== -1 && args[groqIdx + 1]) {
      cfg.groq_api_key = args[groqIdx + 1].trim();
    }
    const openaiIdx = args.indexOf("--openai-key");
    if (openaiIdx !== -1 && args[openaiIdx + 1]) {
      cfg.openai_api_key = args[openaiIdx + 1].trim();
    }

    saveConfig(cfg);
    console.log("[setup] Конфигурация сохранена:", JSON.stringify(cfg, null, 2));
    process.exit(0);
  }

  // Interactive CLI wizard
  console.log("======================================================");
  console.log("   Настройка Avito MCP Server (Распознавание речи)");
  console.log("======================================================");
  console.log(`Системная память (RAM): ${totalRamGb.toFixed(1)} GB`);
  if (isLowMemory) {
    console.log("Внимание: обнаружена система с небольшим объемом памяти (VPS/сервер)!");
    console.log("Рекомендуется использовать Whisper (облако Groq) или отключить STT во избежание OOM.");
  } else {
    console.log("Система имеет достаточно памяти для локальной модели Сбер GigaAM.");
  }
  console.log("");
  console.log("Выберите способ распознавания голосовых от продавцов:");
  console.log("  1) Сбер GigaAM (локально на ПК / сервере с GPU или мощным CPU)");
  console.log("  2) Whisper через бесплатный Groq Cloud API (0 нагрузка на память, идеально для слабых VPS)");
  console.log("  3) Отключить распознавание (просто сохранять аудиосообщения)");
  console.log("  4) Автоматический режим (Whisper если есть ключ, иначе Сбер если хватает RAM)");
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const choice = (await ask(rl, "Ваш выбор [1-4] (по умолчанию 4): ")).trim();

    if (choice === "1") {
      cfg.stt_engine = "sber";
      console.log("Выбран движок: Сбер GigaAM (локально)");
    } else if (choice === "2") {
      cfg.stt_engine = "whisper";
      console.log("Выбран движок: Whisper (облачный Groq API)");
      const key = (await ask(rl, "Введите GROQ_API_KEY (Enter чтобы пропустить и задать через ENV позже): ")).trim();
      if (key) {
        cfg.groq_api_key = key;
      }
    } else if (choice === "3") {
      cfg.stt_engine = "off";
      console.log("Распознавание голосовых отключено");
    } else {
      cfg.stt_engine = "auto";
      console.log("Выбран автоматический режим");
    }

    saveConfig(cfg);
    console.log("");
    console.log("Настройки успешно сохранены в:", CONFIG_PATH);
    console.log(JSON.stringify(cfg, null, 2));
  } finally {
    rl.close();
  }
}

run();
