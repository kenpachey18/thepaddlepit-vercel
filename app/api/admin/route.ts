import {
  COURT_ID,
  OPERATING_HOURS,
  addDays,
  audit,
  cleanText,
  completeExpiredBookings,
  currentRate,
  daysBetween,
  ensureDatabase,
  isDateString,
  json,
  manilaToday,
  payload,
  requireAdmin,
  slotStartIso,
  validateFacebookUrl,
  validateMobile,
} from "../../../lib/booking";
import { databaseError, supabaseService } from "../../../lib/supabase";

type AdminInput = {
  action?: string;
  bookingId?: unknown;
  bookingAction?: unknown;
  note?: unknown;
  reason?: unknown;
  date?: unknown;
  hour?: unknown;
  newDate?: unknown;
  newStartHour?: unknown;
  availabilityAction?: unknown;
  rate?: unknown;
  fullName?: unknown;
  mobile?: unknown;
  facebookUrl?: unknown;
  bookingDate?: unknown;
  hours?: unknown;
};

type BookingRow = Record<string, unknown>;

function unauthorized() {
  return json({ error: "Admin session required." }, 401);
}

function number(value: unknown) {
  return Number(value || 0);
}

function bookingSlotStatus(status: unknown) {
  return status === "confirmed" ? "booked" : status;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const admin = await requireAdmin(request);
    if (!admin) return unauthorized();
    await completeExpiredBookings();

    const database = supabaseService();
    const url = new URL(request.url);
    const view = url.searchParams.get("view") || "overview";
    const today = manilaToday();

    if (view === "overview") {
      const [todayResult, pendingResult, hourlyRate] = await Promise.all([
        database.from("bookings").select("*").eq("booking_date", today).order("start_at", { ascending: true }),
        database.from("bookings").select("id", { count: "exact", head: true }).eq("status", "pending"),
        currentRate(),
      ]);
      if (todayResult.error) throw new Error(todayResult.error.message);
      if (pendingResult.error) throw new Error(pendingResult.error.message);
      const schedule = todayResult.data || [];
      return json({
        stats: {
          todayPending: schedule.filter((row) => row.status === "pending").length,
          todayConfirmed: schedule.filter((row) => row.status === "confirmed").length,
          totalPending: pendingResult.count || 0,
          todayRevenue: schedule
            .filter((row) => ["confirmed", "completed"].includes(row.status))
            .reduce((sum, row) => sum + number(row.estimated_total), 0),
          hourlyRate,
        },
        schedule,
      });
    }

    if (view === "bookings") {
      const status = cleanText(url.searchParams.get("status") || "pending", 20);
      if (!["pending", "confirmed", "completed"].includes(status)) {
        return json({ error: "Invalid booking status." }, 400);
      }
      let query = database
        .from("bookings")
        .select("*")
        .eq("status", status)
        .order("booking_date", { ascending: true })
        .order("start_at", { ascending: true })
        .limit(100);
      if (status === "completed") {
        query = query.gte("completed_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return json({ bookings: data || [] });
    }

    if (view === "availability") {
      const start = url.searchParams.get("start") || url.searchParams.get("date") || today;
      const requestedCount = Number(url.searchParams.get("count") || 1);
      const count = Number.isInteger(requestedCount) ? Math.min(3, Math.max(1, requestedCount)) : 1;
      if (!isDateString(start)) return json({ error: "Invalid date." }, 400);
      const dates = Array.from({ length: count }, (_, index) => addDays(start, index));

      const [bookingResult, availabilityResult] = await Promise.all([
        database
          .from("booking_slots")
          .select("slot_date, slot_hour, status, booking_id, bookings!inner(full_name, booking_date, start_hour, end_hour, duration_hours)")
          .in("slot_date", dates)
          .in("status", ["pending", "confirmed"]),
        database
          .from("availability")
          .select("id, slot_date, slot_hour, status, reason")
          .in("slot_date", dates),
      ]);
      if (bookingResult.error) throw new Error(bookingResult.error.message);
      if (availabilityResult.error) throw new Error(availabilityResult.error.message);

      const now = new Date().toISOString();
      const days = dates.map((date) => {
        const bookingRows = (bookingResult.data || []).filter((row) => row.slot_date === date);
        const availabilityRows = (availabilityResult.data || []).filter((row) => row.slot_date === date);
        const slots = OPERATING_HOURS.map((hour) => {
          if (slotStartIso(date, hour) <= now) return { hour, status: "past" };
          const slot = bookingRows.find((row) => number(row.slot_hour) === hour);
          if (slot) {
            const relation = slot.bookings as BookingRow | BookingRow[] | null;
            const booking = Array.isArray(relation) ? relation[0] : relation;
            return {
              hour,
              status: bookingSlotStatus(slot.status),
              bookingId: slot.booking_id,
              fullName: booking?.full_name,
              bookingDate: booking?.booking_date,
              startHour: booking?.start_hour,
              endHour: booking?.end_hour,
              durationHours: booking?.duration_hours,
            };
          }
          const closed = availabilityRows.find((row) => number(row.slot_hour) === hour);
          if (closed) {
            return {
              hour,
              status: closed.status,
              reason: closed.reason,
              availabilityId: closed.id,
            };
          }
          return { hour, status: "available" };
        });
        return { date, slots };
      });
      return count === 1 && !url.searchParams.has("start")
        ? json(days[0])
        : json({ dates, days });
    }

    if (view === "settings") {
      return json({ hourlyRate: await currentRate(), username: admin.email, role: admin.role });
    }

    if (view === "audit") {
      const monthStart = `${today.slice(0, 7)}-01`;
      const [year, month] = monthStart.split("-").map(Number);
      const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      const { data, error } = await database
        .from("bookings")
        .select("booking_date, status, payment_status, estimated_total, duration_hours")
        .gte("booking_date", monthStart)
        .lte("booking_date", monthEnd)
        .order("booking_date", { ascending: false });
      if (error) throw new Error(error.message);

      const byDate = new Map<string, BookingRow[]>();
      for (const row of data || []) {
        const date = String(row.booking_date);
        byDate.set(date, [...(byDate.get(date) || []), row]);
      }
      const summarize = (rows: BookingRow[]) => ({
        totalBookings: rows.length,
        pendingBookings: rows.filter((row) => row.status === "pending").length,
        confirmedBookings: rows.filter((row) => row.status === "confirmed").length,
        completedBookings: rows.filter((row) => row.status === "completed").length,
        cancelledBookings: rows.filter((row) => row.status === "cancelled").length,
        revenue: rows
          .filter((row) => row.status === "completed")
          .reduce((sum, row) => sum + number(row.estimated_total), 0),
        totalBookedHours: rows
          .filter((row) => row.status === "completed")
          .reduce((sum, row) => sum + number(row.duration_hours), 0),
      });
      const daily = [...byDate.entries()].map(([date, rows]) => ({ date, ...summarize(rows) }));
      const summaryValues = summarize(data || []);
      return json({
        period: { start: monthStart, end: monthEnd },
        daily,
        summary: {
          ...summaryValues,
          monthRevenue: summaryValues.revenue,
        },
      });
    }

    return json({ error: "Unknown admin view." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Admin data could not be loaded." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const admin = await requireAdmin(request);
    if (!admin) return unauthorized();

    const database = supabaseService();
    const input = await payload<AdminInput>(request);
    const action = cleanText(input.action, 40);

    if (action === "manual_booking") {
      const fullName = cleanText(input.fullName, 120);
      const mobile = validateMobile(input.mobile);
      const facebookUrl = validateFacebookUrl(input.facebookUrl);
      const bookingDate = input.bookingDate;
      const hours = Array.isArray(input.hours)
        ? [...new Set(input.hours.map(Number))].sort((a, b) => a - b)
        : [];
      if (!fullName) return json({ error: "Full name is required." }, 400);
      if (!mobile) return json({ error: "Mobile number must contain exactly 11 digits and begin with 09." }, 400);
      if (!facebookUrl) return json({ error: "Enter a valid Facebook profile URL." }, 400);
      if (!isDateString(bookingDate)) return json({ error: "Choose a valid booking date." }, 400);
      const advanceDays = daysBetween(manilaToday(), bookingDate);
      if (advanceDays < 0 || advanceDays > 90) return json({ error: "Bookings may be made from today through the next 90 days." }, 400);
      if (!hours.length || hours.some((hour) => !OPERATING_HOURS.includes(hour))) {
        return json({ error: "Choose at least one available hour." }, 400);
      }
      if (hours.some((hour, index) => index > 0 && hour !== hours[index - 1] + 1)) {
        return json({ error: "Selected hours must be consecutive." }, 400);
      }

      const startHour = hours[0];
      const endHour = hours[hours.length - 1] + 1;
      const { data: bookingId, error } = await database.rpc("create_manual_booking", {
        p_full_name: fullName,
        p_mobile: mobile,
        p_facebook_url: facebookUrl,
        p_booking_date: bookingDate,
        p_start_hour: startHour,
        p_end_hour: endHour,
        p_admin_id: admin.id,
      });
      if (error) {
        const message = databaseError(error, "Manual booking could not be created.");
        return json({ error: message }, /booked|unavailable|passed/i.test(message) ? 409 : 400);
      }
      const rate = await currentRate();
      return json({
        success: true,
        bookingId,
        status: "confirmed",
        bookingDate,
        startHour,
        endHour,
        durationHours: hours.length,
        hourlyRate: rate,
        estimatedTotal: rate * hours.length,
      }, 201);
    }

    if (action === "booking") {
      const bookingId = cleanText(input.bookingId, 80);
      const bookingAction = cleanText(input.bookingAction, 30);
      const note = cleanText(input.note, 1000);
      const { data: booking, error: bookingError } = await database
        .from("bookings")
        .select("*")
        .eq("id", bookingId)
        .maybeSingle();
      if (bookingError) throw new Error(bookingError.message);
      if (!booking) return json({ error: "Booking not found." }, 404);

      if (bookingAction === "confirm" && booking.status === "pending") {
        const { error } = await database.rpc("confirm_booking", {
          p_booking_id: bookingId,
          p_admin_id: admin.id,
        });
        if (error) return json({ error: databaseError(error) }, 409);
        if (note) await database.from("bookings").update({ internal_notes: note }).eq("id", bookingId);
        return json({ success: true });
      }

      if (bookingAction === "reschedule" && booking.status === "confirmed") {
        const newDate = input.newDate;
        const newStartHour = Number(input.newStartHour);
        const durationHours = number(booking.duration_hours);
        const targetHours = Array.from({ length: durationHours }, (_, index) => newStartHour + index);
        if (!isDateString(newDate) || !Number.isInteger(newStartHour) || targetHours.some((hour) => !OPERATING_HOURS.includes(hour))) {
          return json({ error: "Choose a valid available start time." }, 400);
        }
        const advanceDays = daysBetween(manilaToday(), newDate);
        if (advanceDays < 0 || advanceDays > 90) return json({ error: "Choose a date from today through the next 90 days." }, 400);
        if (String(booking.booking_date) === newDate && number(booking.start_hour) === newStartHour) {
          return json({ error: "Choose a different date or time for this booking." }, 409);
        }
        const { error } = await database.rpc("reschedule_booking", {
          p_booking_id: bookingId,
          p_new_date: newDate,
          p_new_start_hour: newStartHour,
          p_admin_id: admin.id,
        });
        if (error) return json({ error: databaseError(error) }, 409);
        if (note) await database.from("bookings").update({ internal_notes: note }).eq("id", bookingId);
        return json({ success: true });
      }

      if (bookingAction === "note") {
        const { error } = await database
          .from("bookings")
          .update({ internal_notes: note, action_admin_id: admin.id })
          .eq("id", bookingId);
        if (error) throw new Error(error.message);
        await audit(admin.id, "booking_note", "booking", bookingId, null, { note });
        return json({ success: true });
      }

      return json({ error: "That action is not valid for the booking's current status." }, 409);
    }

    if (action === "availability") {
      const date = input.date;
      const hour = Number(input.hour);
      const availabilityAction = cleanText(input.availabilityAction, 30);
      const reason = cleanText(input.reason, 500);
      if (!isDateString(date) || !OPERATING_HOURS.includes(hour)) return json({ error: "Invalid date or hour." }, 400);
      const startAt = slotStartIso(date, hour);
      if (startAt <= new Date().toISOString()) return json({ error: "Past slots cannot be changed." }, 409);

      const { data: occupied, error: occupiedError } = await database
        .from("booking_slots")
        .select("booking_id, status")
        .eq("court_id", COURT_ID)
        .eq("start_at", startAt)
        .in("status", ["pending", "confirmed"])
        .maybeSingle();
      if (occupiedError) throw new Error(occupiedError.message);
      if (occupied) return json({ error: "Customer booking slots must be changed through the booking action." }, 409);

      const { data: existing, error: existingError } = await database
        .from("availability")
        .select("id, status")
        .eq("court_id", COURT_ID)
        .eq("start_at", startAt)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);

      if (availabilityAction === "close" && !existing) {
        const { error } = await database.from("availability").insert({
          court_id: COURT_ID,
          slot_date: date,
          slot_hour: hour,
          start_at: startAt,
          status: "unavailable",
          reason: reason || null,
          admin_id: admin.id,
        });
        if (error) throw new Error(error.message);
      } else if (availabilityAction === "reopen" && existing) {
        const { error } = await database.from("availability").delete().eq("id", existing.id);
        if (error) throw new Error(error.message);
      } else {
        return json({ error: "The requested availability change cannot be applied." }, 409);
      }

      await audit(
        admin.id,
        `availability_${availabilityAction}`,
        "slot",
        `${date}:${hour}`,
        existing?.status || "available",
        availabilityAction,
        reason,
      );
      return json({ success: true });
    }

    if (action === "rate") {
      const rate = Math.round(Number(input.rate));
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) {
        return json({ error: "Enter a positive hourly rate." }, 400);
      }
      const oldRate = await currentRate();
      const { error } = await database
        .from("settings")
        .upsert({ key: "hourly_rate", value: String(rate) }, { onConflict: "key" });
      if (error) throw new Error(error.message);
      await audit(admin.id, "update_rate", "settings", "hourly_rate", oldRate, rate);
      return json({ success: true, hourlyRate: rate });
    }

    return json({ error: "Unsupported admin action." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Admin action failed." }, 500);
  }
}
