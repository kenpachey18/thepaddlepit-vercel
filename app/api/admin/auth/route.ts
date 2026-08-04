import {
  ACCESS_COOKIE,
  audit,
  cleanText,
  clearSessionCookies,
  cookieValue,
  ensureDatabase,
  json,
  jsonWithCookies,
  payload,
  refreshAdminSession,
  requireAdmin,
  sessionCookies,
} from "../../../../lib/booking";
import { supabasePublic, supabaseService } from "../../../../lib/supabase";

type AuthInput = {
  action?: string;
  username?: unknown;
  password?: unknown;
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
};

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const admin = await requireAdmin(request);
    if (admin) {
      return json({ authenticated: true, admin: { username: admin.email, role: admin.role } });
    }
    const refreshed = await refreshAdminSession(request);
    if (!refreshed) return json({ authenticated: false }, 401);
    return jsonWithCookies(
      { authenticated: true, admin: { username: refreshed.admin.email, role: refreshed.admin.role } },
      200,
      refreshed.cookies,
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Authentication failed." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const input = await payload<AuthInput>(request);
    const action = cleanText(input.action, 40);

    if (action === "login") {
      const email = cleanText(input.username, 200).toLowerCase();
      const password = String(input.password ?? "");
      if (!email || !password) return json({ error: "Email and password are required." }, 400);

      const { data, error } = await supabasePublic().auth.signInWithPassword({ email, password });
      if (error || !data.session || !data.user) return json({ error: "Invalid email or password." }, 401);

      const { data: profile, error: profileError } = await supabaseService()
        .from("admin_profiles")
        .select("role, active")
        .eq("id", data.user.id)
        .maybeSingle();
      if (profileError || !profile?.active || !["owner", "admin"].includes(profile.role)) {
        return json({ error: "This account does not have administrator access." }, 403);
      }

      await audit(data.user.id, "login", "admin", data.user.id, null, { email });
      return jsonWithCookies(
        { authenticated: true, admin: { username: email, role: profile.role } },
        200,
        sessionCookies(data.session.access_token, data.session.refresh_token, data.session.expires_in),
      );
    }

    if (action === "logout") {
      return jsonWithCookies({ authenticated: false }, 200, clearSessionCookies());
    }

    const admin = await requireAdmin(request);
    if (!admin) return json({ error: "Admin session required." }, 401);

    if (action === "change_password") {
      const currentPassword = String(input.currentPassword ?? "");
      const newPassword = String(input.newPassword ?? "");
      const confirmPassword = String(input.confirmPassword ?? "");
      if (newPassword.length < 10) return json({ error: "New password must be at least ten characters." }, 400);
      if (newPassword !== confirmPassword) return json({ error: "New passwords do not match." }, 400);

      const verification = await supabasePublic().auth.signInWithPassword({
        email: admin.email,
        password: currentPassword,
      });
      if (verification.error) return json({ error: "Current password is incorrect." }, 400);

      const { error } = await supabaseService().auth.admin.updateUserById(admin.id, { password: newPassword });
      if (error) throw new Error(error.message);
      await audit(admin.id, "change_password", "admin", admin.id, null, { changedAt: new Date().toISOString() });
      return jsonWithCookies({ success: true, relogin: true }, 200, clearSessionCookies());
    }

    const accessToken = cookieValue(request, ACCESS_COOKIE);
    if (!accessToken) return json({ error: "Admin session required." }, 401);
    return json({ error: "Unsupported authentication action." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Authentication request failed." }, 500);
  }
}
