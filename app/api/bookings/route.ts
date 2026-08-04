import {
  OPERATING_HOURS,
  cleanText,
  completeExpiredBookings,
  currentRate,
  daysBetween,
  ensureDatabase,
  isDateString,
  manilaToday,
  payload,
  publicBooking,
  publicJson as json,
  publicOptions,
  slotEndIso,
  slotStartIso,
  validateFacebookUrl,
  validateMobile,
} from "../../../lib/booking";
import { databaseError, supabaseService } from "../../../lib/supabase";

export function OPTIONS() {
  return publicOptions();
}

type BookingInput = {
  fullName?: unknown;
  mobile?: unknown;
  facebookUrl?: unknown;
  bookingDate?: unknown;
  hours?: unknown;
  termsAccepted?: unknown;
};

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    await completeExpiredBookings();
    const url = new URL(request.url);
    const mobile = validateMobile(url.searchParams.get("mobile"));
    if (!mobile) return json({ error: "Enter the same valid 11-digit mobile number used for booking." }, 400);

    const visibleAfter = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseService()
      .from("bookings")
      .select("id, status, booking_date, start_at, end_at, start_hour, end_hour, duration_hours, hourly_rate, estimated_total, payment_status, submitted_at")
      .eq("mobile", mobile)
      .gte("end_at", visibleAfter)
      .order("submitted_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return json({ bookings: (data || []).map((row) => publicBooking(row)) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Bookings could not be loaded." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const input = await payload<BookingInput>(request);
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
    if (input.termsAccepted !== true) return json({ error: "You must agree to the booking terms." }, 400);
    if (!isDateString(bookingDate)) return json({ error: "Choose a valid booking date." }, 400);

    const advanceDays = daysBetween(manilaToday(), bookingDate);
    if (advanceDays < 0 || advanceDays > 90) {
      return json({ error: "Bookings may be made from today through the next 90 days." }, 400);
    }
    if (!hours.length || hours.some((hour) => !OPERATING_HOURS.includes(hour))) {
      return json({ error: "Choose at least one available hour." }, 400);
    }
    if (hours.some((hour, index) => index > 0 && hour !== hours[index - 1] + 1)) {
      return json({ error: "Selected hours must be consecutive." }, 400);
    }

    const startHour = hours[0];
    const endHour = hours[hours.length - 1] + 1;
    const startAt = slotStartIso(bookingDate, startHour);
    const endAt = slotEndIso(bookingDate, endHour);
    if (startAt <= new Date().toISOString()) {
      return json({ error: "Past or already-started hours cannot be booked." }, 409);
    }

    const database = supabaseService();
    const { data: bookingId, error: createError } = await database.rpc("create_booking_request", {
      p_full_name: fullName,
      p_mobile: mobile,
      p_facebook_url: facebookUrl,
      p_booking_date: bookingDate,
      p_start_hour: startHour,
      p_end_hour: endHour,
    });
    if (createError) {
      const message = databaseError(createError, "Booking could not be submitted.");
      const conflict = /already booked|unavailable|passed/i.test(message);
      return json({ error: message, conflict }, conflict ? 409 : 400);
    }

    const hourlyRate = await currentRate();
    const submittedAt = new Date().toISOString();
    return json(
      {
        id: bookingId,
        booking: {
          status: "pending",
          bookingDate,
          startAt,
          endAt,
          durationHours: hours.length,
          hourlyRate,
          estimatedTotal: hourlyRate * hours.length,
          court: "Pickleball Court",
          submittedAt,
        },
      },
      201,
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Booking could not be submitted." }, 500);
  }
}
