/**
 * Minimal, dependency-free PDF 1.4 writer for server-generated documents (prescriptions).
 *
 * Text only (Helvetica / Helvetica-Bold, WinAnsi), A4, automatic line wrapping and page
 * breaks. Output is deterministic for the same input — no creation timestamps or random
 * ids — so the document's SHA-256 identifies its content and a retried render produces
 * identical bytes.
 */

const PAGE = { width: 595, height: 842, margin: 50 };
// Average Helvetica glyph width as a fraction of the font size (conservative for wrapping).
const AVG_GLYPH = 0.52;

/** Characters outside printable ASCII are transliterated or replaced (WinAnsi subset). */
function toPdfText(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/₹/g, 'Rs ')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\()]/g, (c) => `\\${c}`);
}

function wrap(text, size, width) {
  const max = Math.max(10, Math.floor(width / (size * AVG_GLYPH)));
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= max) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > max) {
        out.push(line.slice(0, max));
        line = line.slice(max);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * @param {Array<{ text: string, size?: number, bold?: boolean, gapBefore?: number, indent?: number }>} blocks
 * @param {{ footer?: string }} [options]
 * @returns {Buffer}
 */
export function renderTextPdf(blocks, { footer } = {}) {
  const pages = [];
  let ops = [];
  let y = PAGE.height - PAGE.margin;
  const newPage = () => {
    if (ops.length) pages.push(ops);
    ops = [];
    y = PAGE.height - PAGE.margin;
  };
  for (const block of blocks) {
    const size = block.size ?? 10;
    const leading = Math.round(size * 1.35);
    const indent = block.indent ?? 0;
    y -= block.gapBefore ?? 0;
    for (const line of wrap(block.text, size, PAGE.width - 2 * PAGE.margin - indent)) {
      if (y - leading < PAGE.margin + 30) newPage();
      y -= leading;
      if (line) {
        ops.push(
          `BT /${block.bold ? 'F2' : 'F1'} ${size} Tf ${PAGE.margin + indent} ${y} Td (${toPdfText(line)}) Tj ET`,
        );
      }
    }
  }
  newPage();

  const objects = [];
  /** Appends an object and returns its 1-based object number. */
  const add = (body) => objects.push(body);
  const catalog = add(null);
  const pagesObj = add(null);
  const fontRegular = add(
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
  );
  const fontBold = add(
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>',
  );
  const pageIds = [];
  pages.forEach((pageOps, i) => {
    const footerText = `${footer ? `${toPdfText(footer)}   ` : ''}Page ${i + 1} of ${pages.length}`;
    const stream = [
      ...pageOps,
      `BT /F1 8 Tf ${PAGE.margin} ${PAGE.margin - 10} Td (${footerText}) Tj ET`,
    ].join('\n');
    const content = add(
      `<</Length ${Buffer.byteLength(stream, 'latin1')}>>stream\n${stream}\nendstream`,
    );
    pageIds.push(
      add(
        `<</Type/Page/Parent ${pagesObj} 0 R/MediaBox[0 0 ${PAGE.width} ${PAGE.height}]` +
          `/Resources<</Font<</F1 ${fontRegular} 0 R/F2 ${fontBold} 0 R>>>>/Contents ${content} 0 R>>`,
      ),
    );
  });
  objects[catalog - 1] = `<</Type/Catalog/Pages ${pagesObj} 0 R>>`;
  objects[pagesObj - 1] =
    `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pageIds.length}>>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<</Size ${objects.length + 1}/Root ${catalog} 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
