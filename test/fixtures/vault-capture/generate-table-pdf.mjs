#!/usr/bin/env node
// TODO 2026-09-13: generates test/fixtures/vault-capture/table.pdf deterministically.
// Hand-built, uncompressed single-page PDF (no external PDF dependency —
// nothing suitable for generating a real table was already vendored in
// node_modules; a raw PDF with an explicit content stream needs no library).
// Draws a small ruled text table (2 columns x 4 rows: absolute text
// positioning plus stroked cell borders) and a heading. xberg's PDF table
// detector only recognizes ruled grids; borderless column-aligned text is a
// recorded converter limit (probed 1.0.14 and 1.1.5 on 2026-09-14).
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

const columnX = [72, 250, 430];
const rowHeight = 24;
const top = 684;

const lines = [];
lines.push("BT /F1 18 Tf 72 720 Td (Orbital Period Table) Tj ET");
rows.forEach(([col1, col2], index) => {
  const baseline = top - index * rowHeight - 16;
  lines.push(
    `BT /F1 12 Tf ${columnX[0] + 4} ${baseline} Td (${escapePdfText(col1)}) Tj ET`,
    `BT /F1 12 Tf ${columnX[1] + 4} ${baseline} Td (${escapePdfText(col2)}) Tj ET`,
  );
});
lines.push("0.8 w");
for (let i = 0; i <= rows.length; i++) {
  const y = top - i * rowHeight;
  lines.push(`${columnX[0]} ${y} m ${columnX[2]} ${y} l S`);
}
for (const x of columnX) {
  lines.push(`${x} ${top} m ${x} ${top - rows.length * rowHeight} l S`);
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
