import {
  OPERATING_HOURS,
  addDays,
  currentRate,
  daysBetween,
  isDateString,
  manilaToday,
  publicJson as json,
  publicOptions,
  slotStartIso,
} from "../../../lib/booking";
import { supabaseService } from "../../../lib/supabase";

export function OPTIONS() {
  return publicOptions();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const start = url.searchParams.get("start") || manilaToday();
    const count = Math.min(7, Math.max(1, Number(url.searchParams.get("count") || 3)));
    const today = manilaToday();
    if (!isDateString(start) || daysBetween(today, start) < 0 || daysBetween(today, start) > 90) {
      return json({ error: "Choose a date from today through the next 90 days." }, 400);
    }

    const dates = Array.from({ length: count }, (_, index) => addDays(start, index));
    const database = supabaseService();
    const [bookingResult, availabilityResult, hourlyRate] = await Promise.all([
      database
        .from("booking_slots")
        .select("slot_date, slot_hour, status")
        .in("slot_date", dates)
        .in("status", ["pending", "confirmed"]),
      database
        .from("availability")
        .select("slot_date, slot_hour, status")
        .in("slot_date", dates),
      currentRate(),
    ]);
    if (bookingResult.error) throw new Error(bookingResult.error.message);
    if (availabilityResult.error) throw new Error(availabilityResult.error.message);

    const result: Record<string, Record<string, string>> = {};
    const now = new Date().toISOString();
    for (const date of dates) {
      const state = new Map<number, string>();
      for (const row of availabilityResult.data || []) {
        if (row.slot_date === date) state.set(Number(row.slot_hour), "unavailable");
      }
      for (const row of bookingResult.data || []) {
        if (row.slot_date === date) {
          state.set(Number(row.slot_hour), row.status === "confirmed" ? "booked" : "pending");
        }
      }
      result[date] = {};
      for (const hour of OPERATING_HOURS) {
        result[date][String(hour)] = slotStartIso(date, hour) <= now
          ? "past"
          : state.get(hour) || "available";
      }
    }

    return json(
      {
        dates,
        slots: result,
        hourlyRate,
        court: "Pickleball Court",
        timezone: "Asia/Manila",
        refreshedAt: new Date().toISOString(),
      },
      200,
      { "cache-control": "private, max-age=5, stale-while-revalidate=15" },
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Availability could not be loaded." }, 500);
  }
}
