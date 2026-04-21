const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const ROOTS = ["artifacts", "lib"];
const EXTRA_FILES = ["package.json", "pnpm-workspace.yaml", "replit.md"];
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "build", ".turbo", ".cache", ".next", ".git"]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".json", ".css", ".html", ".md", ".sql", ".toml", ".yaml", ".yml"]);
const MAX_BYTES = 400_000;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && EXTS.has(path.extname(e.name))) out.push(full);
  }
}

const files = [];
for (const r of ROOTS) walk(r, files);
for (const f of EXTRA_FILES) if (fs.existsSync(f)) files.push(f);
files.sort();

console.log(`Collected ${files.length} files`);

const outPath = "exports/mtos-crm-source.pdf";
fs.mkdirSync("exports", { recursive: true });
const doc = new PDFDocument({ size: "LETTER", margin: 36, bufferPages: true });
doc.pipe(fs.createWriteStream(outPath));

doc.font("Helvetica-Bold").fontSize(22).text("MTOS CRM — Full Source Code", { align: "center" });
doc.moveDown(0.5);
doc.font("Helvetica").fontSize(11).text(`Generated: ${new Date().toISOString()}`, { align: "center" });
doc.text(`${files.length} files`, { align: "center" });
doc.moveDown(1);
doc.font("Helvetica-Bold").fontSize(13).text("Contents");
doc.font("Helvetica").fontSize(8);
for (const f of files) doc.text(f);
doc.addPage();

let n = 0;
for (const f of files) {
  n++;
  if (n % 50 === 0) console.log(`  ${n}/${files.length}`);
  let body;
  try { body = fs.readFileSync(f, "utf8"); } catch { body = "<binary or unreadable>"; }
  if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES) + `\n\n... [truncated, original ${body.length} bytes]`;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#1a4480").text(f, { underline: true });
  doc.moveDown(0.2);
  doc.font("Courier").fontSize(7).fillColor("#000").text(body, { lineGap: 0 });
  doc.addPage();
}

const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(i);
  doc.font("Helvetica").fontSize(8).fillColor("#888");
  doc.text(`MTOS CRM Source — page ${i + 1} of ${range.count}`, 36, doc.page.height - 24, {
    align: "center", width: doc.page.width - 72, lineBreak: false,
  });
}

doc.end();
console.log("Wrote", outPath);
