import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config();

const LOGIN_URL = "https://pronet.id.eagleeyenetworks.com/login";
const AUDIT_URL = "https://pronet.webapp.eagleeyenetworks.com/#/admin/audit";
const VIEW_START = "viewVideoStart";
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const ONCE = process.argv.includes("--once");

class SessionExpired extends Error {}

function log(message) {
  const now = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  console.log(`[${now}] ${message}`);
}

function iso(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
    `.${pad(date.getUTCMilliseconds(), 3)}+00:00`
  );
}

function formatTime(raw) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(raw));
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch {
    return { initialized: false, seenIds: [] };
  }
}

async function saveState(state) {
  state.seenIds = state.seenIds.slice(-1000);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state));
}

function required(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} tanımlı değil`);
  }
  return value;
}

async function discoverChatId(token) {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  if (!response.ok) return "";
  const data = await response.json();
  const updates = data.result || [];
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const chat = updates[index].message?.chat || updates[index].edited_message?.chat;
    if (chat?.id) return String(chat.id);
  }
  return "";
}

class Watcher {
  constructor({ email, password, telegramToken, chatId }) {
    this.email = email;
    this.password = password;
    this.telegramToken = telegramToken;
    this.chatId = chatId;
    this.bearer = "";
    this.apiBase = "";
    this.browser = null;
    this.context = null;
    this.page = null;
    this.state = { initialized: false, seenIds: [] };
    this.telegramWarned = false;
  }

  rememberRequest(request) {
    const url = request.url();
    if (!url.includes("eagleeyenetworks.com") || !url.includes("/api/")) return;
    const auth = request.headers().authorization || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      this.bearer = auth.slice(7).trim();
    }
    const marker = "/api/v3.0/";
    const at = url.indexOf(marker);
    if (at !== -1) this.apiBase = url.slice(0, at);
  }

  async startBrowser() {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
    });
    this.context = await this.browser.newContext({ locale: "tr-TR" });
    this.page = await this.context.newPage();
    this.page.on("request", (request) => this.rememberRequest(request));
  }

  async clickContinue() {
    const button = this.page.locator("#next, button[type='submit']").first();
    await button.waitFor({ state: "visible", timeout: 15000 });
    await button.click();
  }

  async emailFormVisible() {
    const email = this.page.locator("input[name='email']");
    try {
      return (await email.count()) > 0 && (await email.first().isVisible());
    } catch {
      return false;
    }
  }

  async login() {
    const page = this.page;
    log("Giriş yapılıyor");
    this.bearer = "";
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    let signedIn = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.emailFormVisible()) break;
      if (
        this.bearer &&
        page.url().includes("webapp.eagleeyenetworks.com") &&
        !page.url().includes("/login")
      ) {
        signedIn = true;
        log("Oturum hâlâ açık");
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!signedIn) {
      const email = page.locator("input[name='email']").first();
      await email.waitFor({ state: "visible", timeout: 20000 });
      if ((await email.getAttribute("readonly")) === null) {
        await email.fill(this.email);
        const remember = page.locator("input[name='rememberMe']");
        if (await remember.count()) {
          try {
            await remember.setChecked(true, { force: true, timeout: 2000 });
          } catch {
            // The styled checkbox is optional.
          }
        }
        await this.clickContinue();
      }

      const password = page.locator("input[name='password']").first();
      await password.waitFor({ state: "visible", timeout: 20000 });
      await password.fill(this.password);
      await this.clickContinue();
      try {
        await page.waitForURL("**webapp.eagleeyenetworks.com**", { timeout: 45000 });
      } catch (error) {
        const text = await page.locator("body").innerText().catch(() => "");
        if (text.includes("Invalid credentials")) {
          throw new Error("Şifre veya e-posta kabul edilmedi");
        }
        throw new Error(`Giriş tamamlanamadı: ${page.url()}`, { cause: error });
      }
    }

    if (page.url().includes("/login")) {
      throw new Error(`Giriş başarısız: ${page.url()}`);
    }

    await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (this.bearer && this.apiBase && !page.url().includes("/login")) {
        log(`Oturum hazır (${this.apiBase})`);
        return;
      }
      if (page.url().includes("/login")) break;
      await page.waitForTimeout(500);
    }
    throw new SessionExpired(`Denetim günlüğü oturumu alınamadı (${page.url()})`);
  }

  async ensureToken() {
    if (!this.page || this.page.url().includes("/login")) {
      throw new SessionExpired("Oturum kapandı");
    }
    const cookies = await this.context.cookies();
    const accessToken = cookies.find((cookie) => cookie.name === "access_token" && cookie.value);
    if (accessToken) this.bearer = accessToken.value;
    if (!this.bearer || !this.apiBase) {
      throw new SessionExpired("Erişim anahtarı yok");
    }
  }

  async fetchViews() {
    await this.ensureToken();
    const now = new Date();
    const params = new URLSearchParams({
      pageSize: "50",
      timestamp__gte: iso(new Date(now.getTime() - 30 * 60 * 1000)),
      timestamp__lte: iso(now),
      include: "description",
    });
    const response = await fetch(`${this.apiBase}/api/v3.0/auditLogs?${params}`, {
      headers: {
        Authorization: `Bearer ${this.bearer}`,
        Accept: "application/json",
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new SessionExpired(`API ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = await response.json();
    return (payload.results || [])
      .filter((item) => item.auditType === VIEW_START)
      .sort((left, right) => (left.timestamp || "").localeCompare(right.timestamp || ""));
  }

  messageFor(event) {
    const user = event.userName || "Bilinmeyen kullanıcı";
    const email = event.userEmail || "";
    const camera = event.targetName || "Bilinmeyen kamera";
    const when = event.timestamp ? formatTime(event.timestamp) : "";
    const who = email ? `${user} (${email})` : user;
    return `Kamera izlenmeye başladı\nKullanıcı: ${who}\nKamera: ${camera}\nZaman: ${when}`;
  }

  async notify(event) {
    const text = this.messageFor(event);
    log(text.replaceAll("\n", " | "));
    if (!this.telegramToken || !this.chatId) {
      if (!this.telegramWarned) {
        log("TELEGRAM_CHAT_ID yok, bildirim sadece günlüğe yazılıyor.");
        this.telegramWarned = true;
      }
      return;
    }
    const response = await fetch(
      `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text }),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      log(`Telegram gönderilemedi: ${response.status} ${body.slice(0, 200)}`);
    }
  }

  async check() {
    const views = await this.fetchViews();
    const seen = new Set(this.state.seenIds);
    const fresh = views.filter((event) => event.id && !seen.has(event.id));
    if (!this.state.initialized) {
      this.state.seenIds.push(...views.map((event) => event.id).filter(Boolean));
      this.state.initialized = true;
      await saveState(this.state);
      log(`Mevcut ${views.length} izleme kaydı işaretlendi, bundan sonrakiler bildirilecek`);
      return 0;
    }
    for (const event of fresh) {
      await this.notify(event);
      this.state.seenIds.push(event.id);
    }
    if (fresh.length) await saveState(this.state);
    return fresh.length;
  }

  async close() {
    await this.browser?.close();
  }
}

function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(port, "0.0.0.0", () => {
    log(`Sağlık kontrolü ${port} portunda`);
  });
  return server;
}

async function main() {
  const email = required("EEN_EMAIL");
  const password = required("EEN_PASSWORD");
  const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  let chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (telegramToken && !chatId) {
    chatId = await discoverChatId(telegramToken);
    if (chatId) log(`Telegram sohbeti bulundu: ${chatId}`);
  }

  const watcher = new Watcher({ email, password, telegramToken, chatId });
  watcher.state = await loadState();
  const intervalMs = Number(process.env.POLL_SECONDS || 2) * 1000;
  const health = ONCE ? null : startHealthServer();

  const shutdown = async () => {
    health?.close();
    await watcher.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await watcher.startBrowser();
  try {
    await watcher.login();
    while (true) {
      try {
        const count = await watcher.check();
        if (ONCE) {
          log(`Kontrol bitti, yeni kayıt: ${count}`);
          return;
        }
        if (count) log(`${count} yeni izleme bildirildi`);
      } catch (error) {
        if (error instanceof SessionExpired) {
          log(`Oturum düştü (${error.message}), yeniden giriş`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await watcher.login();
          if (ONCE) {
            const count = await watcher.check();
            log(`Kontrol bitti, yeni kayıt: ${count}`);
            return;
          }
        } else if (ONCE) {
          throw error;
        } else {
          log(`Kontrol hatası: ${error.message}`);
        }
      }
      if (ONCE) return;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    health?.close();
    await watcher.close();
  }
}

main().catch((error) => {
  log(error.message);
  process.exit(1);
});
