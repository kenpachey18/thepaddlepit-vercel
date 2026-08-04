import { supabasePublic, supabaseService } from "./supabase";

export type AdminIdentity = {
  id: string;
  email: string;
  username: string;
  role: "owner" | "admin";
};

export const COURT_ID = "court-1";
export const COURT_NAME = "Pickleball Court";
export const OPERATING_HOURS = Array.from({ length: 7 }, (_, index) => index + 16);
export const ACCESS_COOKIE = "paddle_pit_access";
export const REFRESH_COOKIE = "paddle_pit_refresh";
export const SESSION_SECONDS = 60 * 60;

export async function ensureDatabase() {
  const { error } = await supabaseService().from("settings").select("key").limit(1);
  if (error) throw new Error(`Supabase is not ready: ${error.message}`);
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", responseHeaders.get("cache-control") || "no-store");
  return Response.json(data, { status, headers: responseHeaders });
}

const PUBLIC_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
};

export function publicJson(data: unknown, status = 200, headers: HeadersInit = {}) {
  const result = new Headers(PUBLIC_CORS_HEADERS);
  new Headers(headers).forEach((value, key) => result.set(key, value));
  return json(data, status, result);
}

export function publicOptions() {
  return new Response(null, { status: 204, headers: PUBLIC_CORS_HEADERS });
}

export async function payload<T>(request: Request): Promise<T> {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("Expected JSON request");
  return request.json() as Promise<T>;
}

export function cleanText(value: unknown, max = 500) {
  return String(value ?? "").trim().replace(/[<>]/g, "").slice(0, max);
}

export function validateMobile(value: unknown) {
  const mobile = String(value ?? "").replace(/\D/g, "");
  return /^09\d{9}$/.test(mobile) ? mobile : null;
}

export function validateFacebookUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!/(^|\.)facebook\.com$/i.test(url.hostname) && !/(^|\.)fb\.com$/i.test(url.hostname)) return null;
    return url.toString().slice(0, 500);
  } catch {
    return null;
  }
}

export function isDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function manilaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date: string, amount: number) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + amount));
  return value.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string) {
  const parse = (value: string) => Date.parse(`${value}T00:00:00Z`);
  return Math.round((parse(to) - parse(from)) / 86400000);
}

export function slotStartIso(baseDate: string, hour: number) {
  const [year, month, day] = baseDate.split("-").map(Number);
  const dayOffset = hour >= 24 ? 1 : 0;
  const clockHour = hour % 24;
  return new Date(Date.UTC(year, month - 1, day + dayOffset, clockHour - 8)).toISOString();
}

export function slotEndIso(baseDate: string, endHour: number) {
  return slotStartIso(baseDate, endHour);
}

export function displayHour(hour: number) {
  const normalized = hour % 24;
  const suffix = normalized >= 12 ? "PM" : "AM";
  const value = normalized % 12 || 12;
  return `${value}:00 ${suffix}`;
}

export async function currentRate() {
  const { data, error } = await supabaseService()
    .from("settings")
    .select("value")
    .eq("key", "hourly_rate")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const rate = Number(data?.value ?? 250);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 250;
}

export function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || request.headers.get("cf-connecting-ip")
    || "unknown";
}

export function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  for (const item of cookie.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function secureCookie(name: string, token: string, maxAge: number) {
  return `${name}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function sessionCookies(accessToken: string, refreshToken: string, accessSeconds = SESSION_SECONDS) {
  return [
    secureCookie(ACCESS_COOKIE, accessToken, accessSeconds),
    secureCookie(REFRESH_COOKIE, refreshToken, 30 * 24 * 60 * 60),
  ];
}

export function clearSessionCookies() {
  return [secureCookie(ACCESS_COOKIE, "", 0), secureCookie(REFRESH_COOKIE, "", 0)];
}

export function jsonWithCookies(data: unknown, status: number, cookies: string[]) {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return Response.json(data, { status, headers });
}

async function adminProfile(userId: string, email: string): Promise<AdminIdentity | null> {
  const { data, error } = await supabaseService()
    .from("admin_profiles")
    .select("id, role, active")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data?.active || !["owner", "admin"].includes(data.role)) return null;
  return {
    id: userId,
    email,
    username: email,
    role: data.role as "owner" | "admin",
  };
}

export async function requireAdmin(request: Request): Promise<AdminIdentity | null> {
  const accessToken = cookieValue(request, ACCESS_COOKIE);
  if (!accessToken) return null;
  const { data, error } = await supabasePublic().auth.getUser(accessToken);
  if (error || !data.user?.email) return null;
  return adminProfile(data.user.id, data.user.email);
}

export async function refreshAdminSession(request: Request) {
  const refreshToken = cookieValue(request, REFRESH_COOKIE);
  if (!refreshToken) return null;
  const { data, error } = await supabasePublic().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user?.email) return null;
  const admin = await adminProfile(data.user.id, data.user.email);
  if (!admin) return null;
  return {
    admin,
    cookies: sessionCookies(data.session.access_token, data.session.refresh_token, data.session.expires_in),
  };
}

export async function audit(
  adminId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  oldValue: unknown,
  newValue: unknown,
  reason = "",
) {
  const { error } = await supabaseService().from("audit_log").insert({
    admin_id: adminId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    old_value: oldValue,
    new_value: newValue,
    reason: cleanText(reason, 500) || null,
  });
  if (error) throw new Error(error.message);
}

let lastSheetMaintenanceAt = 0;

export async function completeExpiredBookings() {
  const database = supabaseService();
  const { error } = await database.rpc("run_booking_maintenance");
  if (error) throw new Error(error.message);
  if (Date.now() - lastSheetMaintenanceAt >= 30_000) {
    lastSheetMaintenanceAt = Date.now();
    await syncNextDailySheetSummary().catch((failure) => {
      console.error("Google Sheets maintenance failed.", failure);
    });
  }
}

async function syncNextDailySheetSummary() {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL?.trim();
  const secret = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !secret) return;
  if (!webhookUrl.startsWith("https://script.google.com/macros/s/") || !webhookUrl.endsWith("/exec")) return;

  const retryBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const database = supabaseService();
  const { data: summary, error } = await database
    .from("daily_sheet_sync")
    .select("booking_date, total_bookings, total_booked_hours, total_revenue")
    .is("synced_at", null)
    .or(`last_attempt_at.is.null,last_attempt_at.lte.${retryBefore}`)
    .order("booking_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!summary) return;

  const attemptedAt = new Date().toISOString();
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        secret,
        date: summary.booking_date,
        totalBookings: summary.total_bookings,
        totalBookedHours: summary.total_booked_hours,
        totalRevenue: summary.total_revenue,
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
    if (!response.ok || result?.success !== true) {
      throw new Error(result?.error || `Google Sheets returned ${response.status}`);
    }
    const { error: updateError } = await database
      .from("daily_sheet_sync")
      .update({ synced_at: new Date().toISOString(), last_attempt_at: attemptedAt, last_error: null })
      .eq("booking_date", summary.booking_date)
      .eq("total_bookings", summary.total_bookings)
      .eq("total_booked_hours", summary.total_booked_hours)
      .eq("total_revenue", summary.total_revenue);
    if (updateError) throw new Error(updateError.message);
  } catch (failure) {
    const message = failure instanceof Error ? failure.message.slice(0, 500) : "Google Sheets synchronization failed";
    await database
      .from("daily_sheet_sync")
      .update({ last_attempt_at: attemptedAt, last_error: message })
      .eq("booking_date", summary.booking_date);
  }
}

export function publicBooking(row: Record<string, unknown>) {
  return {
    id: row.id,
    status: row.status,
    bookingDate: row.booking_date,
    startAt: row.start_at,
    endAt: row.end_at,
    startHour: row.start_hour,
    endHour: row.end_hour,
    durationHours: row.duration_hours,
    hourlyRate: row.hourly_rate,
    estimatedTotal: row.estimated_total,
    paymentStatus: row.payment_status,
    submittedAt: row.submitted_at,
    court: COURT_NAME,
  };
}
