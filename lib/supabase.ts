import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let serviceClient: SupabaseClient | null = null;
let publicClient: SupabaseClient | null = null;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server setting: ${name}`);
  return value;
}

function projectUrl() {
  const configured = required("NEXT_PUBLIC_SUPABASE_URL");
  try {
    return new URL(configured).origin;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid Supabase project URL.");
  }
}

export function supabaseService() {
  if (serviceClient) return serviceClient;
  serviceClient = createClient(
    projectUrl(),
    required("SUPABASE_SECRET_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
  return serviceClient;
}

export function supabasePublic() {
  if (publicClient) return publicClient;
  publicClient = createClient(
    projectUrl(),
    required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
  return publicClient;
}

export function databaseError(error: unknown, fallback = "Database request failed.") {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message || "");
    if (/already booked|duplicate key|unique constraint/i.test(message)) {
      return "One or more selected hours were already booked.";
    }
    if (message) return message;
  }
  return fallback;
}
