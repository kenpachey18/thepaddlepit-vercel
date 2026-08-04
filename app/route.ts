import siteHtml from "./site.html?raw";

export async function GET() {
  return new Response(siteHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
