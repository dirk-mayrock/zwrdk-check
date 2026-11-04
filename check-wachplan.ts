import { chromium } from "playwright";
import { Resend } from "resend";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Load .env manually (avoids shell quoting issues with special chars)
// ---------------------------------------------------------------------------
try {
  const envFile = fs.readFileSync(path.resolve(".env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.substring(0, idx).trim();
    const value = trimmed.substring(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // In GitHub Actions there is no .env file — env vars come from secrets
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = "https://zwrd-k.dlrg.de";
const LOGIN_URL = `${BASE_URL}/login`;
const CALENDAR_IDS = [9990, 9991, 9992, 9994, 9995, 9996, 9997, 9998, 9999];
const STATE_FILE = path.resolve("state.json");
const DRY_RUN = process.env.DRY_RUN === "true";

const ZWRD_EMAIL = process.env.ZWRD_EMAIL ?? "";
const ZWRD_PASSWORD = process.env.ZWRD_PASSWORD ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const MAIL_TO = process.env.MAIL_TO ?? "";
const MAIL_FROM = process.env.MAIL_FROM ?? "wachplan@notifications.dlrg-check.de";

if (!ZWRD_EMAIL || !ZWRD_PASSWORD) {
  console.error("ZWRD_EMAIL und ZWRD_PASSWORD müssen gesetzt sein.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlanStatus = "available" | "unavailable" | "error";

interface CalendarResult {
  id: number;
  url: string;
  status: PlanStatus;
  detail?: string;
}

type StateMap = Record<number, PlanStatus>;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadState(): StateMap {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as StateMap;
    }
  } catch (e) {
    console.warn("State-Datei konnte nicht geladen werden, starte frisch.");
  }
  return {};
}

function saveState(state: StateMap): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Playwright check
// ---------------------------------------------------------------------------

async function checkWachplaene(): Promise<CalendarResult[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("Logge ein auf", LOGIN_URL);

  await page.goto(LOGIN_URL, { waitUntil: "networkidle" });

  // Fill login form
  await page.fill('#email', ZWRD_EMAIL);
  await page.fill('#password', ZWRD_PASSWORD);

  // Click submit and wait for navigation
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 20_000 }),
    page.click('button[type="submit"]'),
  ]);

  const currentUrl = page.url();
  if (currentUrl.includes("/login")) {
    throw new Error(`Login fehlgeschlagen – noch auf Login-Seite. Bitte Credentials prüfen.`);
  }

  console.log("Login erfolgreich. Aktuelle URL:", currentUrl);

  const results: CalendarResult[] = [];

  for (const id of CALENDAR_IDS) {
    const url = `${BASE_URL}/calendar/show/${id}`;
    console.log(`Prüfe: ${url}`);

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });

      // Check for the red error box indicating no season data
      // The box contains text like "Keine Saisondaten hinterlegt"
      const hasErrorBox = await page.evaluate(() => {
        const alerts = document.querySelectorAll(
          ".alert-danger, .alert.alert-danger, [class*='alert'][class*='danger']"
        );
        for (const el of alerts) {
          if (el.textContent?.includes("Keine Saisondaten")) {
            return true;
          }
        }
        // Also check for any red box with the key phrase
        const allElements = document.querySelectorAll("*");
        for (const el of allElements) {
          const style = window.getComputedStyle(el);
          const bg = style.backgroundColor;
          // red-ish background
          if (
            el.textContent?.includes("Keine Saisondaten") &&
            (bg.includes("220") || el.className.toString().includes("danger") || el.className.toString().includes("error"))
          ) {
            return true;
          }
        }
        return false;
      });

      // Double-check: also look for the specific German error text anywhere
      const pageText = await page.textContent("body") ?? "";
      const hasErrorText =
        pageText.includes("Keine Saisondaten") ||
        pageText.includes("Wachplan kann nicht korrekt dargestellt werden");

      const status: PlanStatus =
        hasErrorBox || hasErrorText ? "unavailable" : "available";

      console.log(
        `  → ${id}: ${status === "available" ? "✓ Plan vorhanden" : "✗ Keine Planung"}`
      );

      results.push({ id, url, status });
    } catch (err) {
      console.error(`  → ${id}: Fehler beim Laden - ${err}`);
      results.push({
        id,
        url,
        status: "error",
        detail: String(err),
      });
    }
  }

  await browser.close();
  return results;
}

// ---------------------------------------------------------------------------
// E-Mail
// ---------------------------------------------------------------------------

async function sendStatusMail(
  newlyAvailable: CalendarResult[],
  allResults: CalendarResult[]
): Promise<void> {
  if (DRY_RUN) {
    console.log("[DRY RUN] Status-E-Mail würde jetzt gesendet.");
    return;
  }

  if (!RESEND_API_KEY || !MAIL_TO) {
    console.warn("RESEND_API_KEY oder MAIL_TO nicht gesetzt – E-Mail wird nicht gesendet.");
    return;
  }

  const resend = new Resend(RESEND_API_KEY);

  const hasNew = newlyAvailable.length > 0;
  const errorCount = allResults.filter((r) => r.status === "error").length;
  const availableCount = allResults.filter((r) => r.status === "available").length;

  // Subject line
  let subject: string;
  if (hasNew) {
    subject = `🏖️ ZWRD-K: ${newlyAvailable.length} Wachplan${newlyAvailable.length > 1 ? "pläne" : ""} neu verfügbar`;
  } else if (errorCount > 0) {
    subject = `⚠️ ZWRD-K: Statusbericht – ${errorCount} Fehler`;
  } else {
    subject = `✅ ZWRD-K: Statusbericht – alles geprüft, keine neuen Pläne`;
  }

  // Optional "newly available" highlight box
  const newlyAvailableSection = hasNew
    ? `<div style="background:#dcfce7;border:1px solid #16a34a;border-radius:8px;padding:16px;margin:20px 0;">
    <strong style="color:#15803d;">Neu verfügbare Wachpläne:</strong>
    <table style="width:100%;border-collapse:collapse;margin-top:12px;">
      <thead>
        <tr style="background:#f0fdf4;">
          <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;">ID</th>
          <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;">URL</th>
        </tr>
      </thead>
      <tbody>${newlyAvailable
        .map(
          (r) =>
            `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #bbf7d0;">${r.id}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #bbf7d0;">
            <a href="${r.url}" style="color:#1d4ed8;">${r.url}</a>
          </td>
        </tr>`
        )
        .join("")}</tbody>
    </table>
  </div>`
    : "";

  const allRows = allResults
    .map((r) => {
      const color =
        r.status === "available"
          ? "#16a34a"
          : r.status === "unavailable"
          ? "#dc2626"
          : "#d97706";
      const label =
        r.status === "available"
          ? "✓ Plan vorhanden"
          : r.status === "unavailable"
          ? "✗ Keine Planung"
          : "⚠ Fehler";
      return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${r.id}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">
          <a href="${r.url}" style="color:#1d4ed8;">${r.url}</a>
        </td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:${color};font-weight:600;">${label}</td>
      </tr>`;
    })
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111827;">
  <h1 style="font-size:20px;font-weight:700;margin-bottom:4px;">
    ZWRD-K Wachplan-Monitor
  </h1>
  <p style="color:#6b7280;margin-top:0;">
    ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}
  </p>

  ${newlyAvailableSection}

  <h2 style="font-size:16px;font-weight:600;margin-top:${hasNew ? "28" : "8"}px;">Gesamtübersicht</h2>
  <p style="color:#6b7280;font-size:13px;margin-top:0;">
    ${availableCount} von ${allResults.length} geprüften Plänen verfügbar
    ${errorCount > 0 ? ` · <span style="color:#d97706;">${errorCount} Fehler</span>` : ""}
  </p>
  <table style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="background:#f9fafb;">
        <th style="text-align:left;padding:6px 12px;font-size:12px;color:#6b7280;">ID</th>
        <th style="text-align:left;padding:6px 12px;font-size:12px;color:#6b7280;">URL</th>
        <th style="text-align:left;padding:6px 12px;font-size:12px;color:#6b7280;">Status</th>
      </tr>
    </thead>
    <tbody>${allRows}</tbody>
  </table>

  <p style="margin-top:32px;font-size:12px;color:#9ca3af;">
    Automatisch generiert vom ZWRD-K Wachplan-Monitor · GitHub Actions
  </p>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    html,
  });

  if (error) {
    console.error("Fehler beim E-Mail-Versand:", error);
  } else {
    console.log(`E-Mail gesendet an ${MAIL_TO}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== ZWRD-K Wachplan-Check ===");
  console.log("Zeit:", new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }));
  console.log("Prüfe IDs:", CALENDAR_IDS.join(", "));
  console.log("");

  const previousState = loadState();
  const results = await checkWachplaene();

  // Find plans that are newly available (were not "available" before)
  const newlyAvailable = results.filter(
    (r) => r.status === "available" && previousState[r.id] !== "available"
  );

  console.log("");
  console.log("--- Zusammenfassung ---");
  console.log(`Gesamt geprüft:    ${results.length}`);
  console.log(`Plan vorhanden:    ${results.filter((r) => r.status === "available").length}`);
  console.log(`Keine Planung:     ${results.filter((r) => r.status === "unavailable").length}`);
  console.log(`Fehler:            ${results.filter((r) => r.status === "error").length}`);
  console.log(`Neu verfügbar:     ${newlyAvailable.length}`);

  if (newlyAvailable.length > 0) {
    console.log("\nNeu verfügbare Pläne:", newlyAvailable.map((r) => r.id).join(", "));
  } else {
    console.log("\nKeine neuen Wachpläne.");
  }
  await sendStatusMail(newlyAvailable, results);

  // Update state (only update known statuses, keep errors from overwriting last good state)
  const newState: StateMap = { ...previousState };
  for (const r of results) {
    if (r.status !== "error") {
      newState[r.id] = r.status;
    }
  }
  saveState(newState);

  console.log("\nState gespeichert.");
}

main().catch((err) => {
  console.error("Unerwarteter Fehler:", err);
  process.exit(1);
});
