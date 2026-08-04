import adminHtml from "./admin.html?raw";

export async function GET() {
  return new Response(adminHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
