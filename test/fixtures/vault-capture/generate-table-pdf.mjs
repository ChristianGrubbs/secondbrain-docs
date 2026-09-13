#!/usr/bin/env node
// TODO 2026-09-13: generates test/fixtures/vault-capture/table.pdf deterministically.
// Hand-built, uncompressed single-page PDF (no external PDF dependency —
// nothing suitable for generating a real table was already vendored in
// node_modules; a raw PDF with an explicit content stream needs no library).
// Draws a small text table (2 columns x 4 rows, tab-aligned via absolute
// text positioning) plus a heading, so extraction pipelines that infer table
// structure from column-aligned text have real column geometry to detect.
import fs from "node:fs";
import path from "node:path";

const rows = [
  ["Planet", "Orbital Period (days)"],
  ["Mercury", "87.97"],
  ["Venus", "224.70"],
  ["Earth", "365.26"],
];

function escapePdfText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const lines = [];
lines.push("BT /F1 18 Tf 72 720 Td (Orbital Period Table) Tj ET");
let y = 660;
for (const [col1, col2] of rows) {
  lines.push(
    `BT /F1 12 Tf 72 ${y} Td (${escapePdfText(col1)}) Tj ET`,
    `BT /F1 12 Tf 250 ${y} Td (${escapePdfText(col2)}) Tj ET`,
  );
  y -= 24;
}
const content = lines.join("\n");
const contentBytes = Buffer.from(content, "latin1");

const objects = [];
objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
objects[3] =
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
  "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
objects[4] = `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`;
objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

let pdf = "%PDF-1.4\n";
const offsets = [0];
for (let i = 1; i <= 5; i++) {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${offsets.length}\n`;
pdf += "0000000000 65535 f \n";
for (let i = 1; i < offsets.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), "table.pdf");
fs.writeFileSync(outPath, Buffer.from(pdf, "latin1"));
console.log(`wrote ${outPath} (${Buffer.byteLength(pdf, "latin1")} bytes)`);
