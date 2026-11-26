import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const title = "Fieldnote Seed Library";
export const answer = "Bring empty seed envelopes to the blue return box.";
export const titleObjective =
  "Read the current document title into observed_title. Verify that it equals Fieldnote Seed Library. Stay on this page.";
export const faqObjective =
  "Open the question Where do envelopes go? Store visible_answer as the revealed answer, or the word missing if it stays hidden. Verify the revealed answer reads Bring empty seed envelopes to the blue return box. Stay on this page.";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function page(revision) {
  if (!["initial", "approved"].includes(revision))
    throw Error("Unknown revision");
  const question = "Where do envelopes go?";
  const control =
    revision === "initial"
      ? '<button type="button">' +
        question +
        "</button><p hidden>" +
        answer +
        "</p>"
      : "<details><summary>" +
        question +
        "</summary><p>" +
        answer +
        "</p></details>";
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>' +
    title +
    "</title>" +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    "body{margin:12vh auto;padding:0 1.4rem;max-width:36rem;background:#fbf7ec;color:#203b32;font:1.2rem/1.55 Georgia,serif}" +
    "h1{line-height:1.1;font-size:2.8rem}button,summary{background:#e3eddc;color:inherit;border:1px solid #68816d;padding:.7rem 1rem;font:inherit;cursor:pointer}" +
    "</style><main><h1>" +
    title +
    "</h1><p>Borrow seeds for the growing season. Return your spare envelopes when you visit.</p><h2>Returns</h2>" +
    control +
    "</main></html>"
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const html = page(process.argv[2] ?? "initial");
  createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      })
      .end(html);
  }).listen(4318, "127.0.0.1", () =>
    console.log("Fieldnote fixture on http://127.0.0.1:4318/"),
  );
}
