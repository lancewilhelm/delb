// Synthetic PDF with portrait/landscape pages, a standard font, and an inert script probe.
export function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 10 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    ...[6, 7, 8].map(
      (content, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${index === 1 ? '792 612' : '612 792'}] /Resources << /Font << /F1 9 0 R >> >> /Contents ${content} 0 R >>`,
    ),
    ...[1, 2, 3].map((page) => {
      const stream = `0.9 0.95 1 rg 32 32 548 500 re f 0 0 0 rg BT /F1 24 Tf 50 550 Td (Delb synthetic PDF page ${page}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /S /JavaScript /JS (globalThis.__delbPdfScriptExecuted = true;) >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
