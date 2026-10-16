/**
 * Minimal PDF with a text layer (Helvetica, one or more pages), for synthetic documents.
 * Text is Latin-1; parentheses and backslashes are escaped.
 */
const BS = String.fromCharCode(92); // backslash, built so no tool mangles it

/** PDF string escaping: backslashes first, then parentheses. */
const escape = (line) =>
  line
    .split(BS)
    .join(BS + BS)
    .replace(/[()]/g, (c) => BS + c);

/** @param {string[] | string[][]} input lines (one page) or pages of lines */
export function syntheticPdf(input) {
  const pages = Array.isArray(input[0]) ? input : [input];
  const objects = []; // bodies; object N is objects[N - 1]
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add(Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'));
  const kids = [];
  pages.forEach((lines, index) => {
    const numbered = [...lines, '', `Page ${index + 1} of ${pages.length}`];
    const text = numbered.map((l) => `(${escape(l)}) Tj`).join(' T* ');
    const stream = Buffer.from(`BT /F1 10 Tf 40 800 Td 15 TL ${text} ET`, 'latin1');
    const content = add(
      Buffer.concat([
        Buffer.from(`<</Length ${stream.length}>>stream\n`),
        stream,
        Buffer.from('\nendstream'),
      ]),
    );
    kids.push(
      add(
        Buffer.from(
          `<</Type/Page/Parent ${pagesObj} 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 ${font} 0 R>>>>/Contents ${content} 0 R>>`,
        ),
      ),
    );
  });
  objects[catalog - 1] = Buffer.from(`<</Type/Catalog/Pages ${pagesObj} 0 R>>`);
  objects[pagesObj - 1] = Buffer.from(
    `<</Type/Pages/Kids[${kids.map((k) => `${k} 0 R`).join(' ')}]/Count ${kids.length}>>`,
  );
  const parts = [Buffer.from('%PDF-1.4\n')];
  let size = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    size += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<</Size ${objects.length + 1}/Root ${catalog} 0 R>>\nstartxref\n${size}\n%%EOF\n`,
  ].join('');
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}
