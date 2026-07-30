/**
 * Generators for real PDF and XLSX bytes (spec 021 extractor tests).
 *
 * These build genuine files rather than mocking `unpdf` and `read-excel-file`.
 * Mocking the parser would test that the mock returns what the mock was told
 * to return; the thing actually worth knowing is whether a real PDF's text
 * layer and a real workbook's cells come out with correct span locators.
 *
 * Both are constructed by hand so the fixtures stay committed as code — a
 * binary blob in the repo is unreviewable, and a fixture nobody can read is a
 * fixture nobody will update when a format detail changes.
 */
import { deflateRawSync } from "node:zlib";

// ------------------------------------------------------------------- PDF

/**
 * A minimal but valid PDF with a real text layer, one content stream per page.
 *
 * The xref table must carry correct byte offsets, so the document is assembled
 * incrementally and each object's offset recorded as it is appended. pdf.js
 * can often recover from a broken xref, but a fixture that only passes through
 * the recovery path would not be testing the normal one.
 */
export function buildPdf(pages: string[]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (text: string) => {
    const buf = Buffer.from(text, "latin1");
    chunks.push(buf);
    length += buf.length;
  };
  /** Record where this object starts, then write it. */
  const obj = (id: number, body: string) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n");

  const pageCount = pages.length;
  // Object ids: 1 catalog, 2 pages, 3 font, then per page: page + content.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const contentIds = pages.map((_, i) => 5 + i * 2);

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`
  );
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((text, index) => {
    obj(
      pageIds[index]!,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[index]} 0 R >>`
    );
    // Escape the PDF string delimiters; the text is otherwise literal.
    const escaped = text.replace(/([\\()])/g, "\\$1");
    const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
    offsets[contentIds[index]!] = length;
    push(
      `${contentIds[index]} 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream\nendobj\n`
    );
  });

  const maxId = 3 + pageCount * 2;
  const xrefOffset = length;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/** A PDF with pages but no text operators — what a scan looks like to a parser. */
export function buildScannedPdf(): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, "latin1");
    chunks.push(buf);
    length += buf.length;
  };
  const obj = (id: number, body: string) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>");
  // A content stream that draws a filled rectangle and no text at all.
  const stream = "0 0 0 rg\n100 100 200 200 re\nf\n";
  offsets[4] = length;
  push(
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream\nendobj\n`
  );

  const xrefOffset = length;
  let xref = "xref\n0 5\n0000000000 65535 f \n";
  for (let id = 1; id <= 4; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ XLSX

/** CRC-32, needed for ZIP entry headers. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Build a ZIP archive (deflate) — an xlsx is a zip of XML parts. */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index: number): string {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

export interface SheetSpec {
  name: string;
  rows: (string | number)[][];
}

/**
 * Build a real .xlsx workbook. Strings go through `sharedStrings.xml` — the
 * standard path Excel itself emits, and the one `read-excel-file` follows.
 */
export function buildXlsx(sheets: SheetSpec[]): Buffer {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const internString = (value: string): number => {
    const existing = sharedIndex.get(value);
    if (existing !== undefined) return existing;
    const index = shared.length;
    shared.push(value);
    sharedIndex.set(value, index);
    return index;
  };

  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((cells, rowIndex) => {
        const r = rowIndex + 1;
        const cellXml = cells
          .map((cell, colIndex) => {
            const ref = `${columnName(colIndex)}${r}`;
            if (typeof cell === "number") {
              return `<c r="${ref}"><v>${cell}</v></c>`;
            }
            return `<c r="${ref}" t="s"><v>${internString(cell)}</v></c>`;
          })
          .join("");
        return `<row r="${r}">${cellXml}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join(
            ""
          )}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
        "utf8"
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "utf8"
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map(
            (sheet, i) =>
              `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
          )
          .join("")}</sheets></workbook>`,
        "utf8"
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join(
            ""
          )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
        "utf8"
      ),
    },
  ];

  sheetXml.forEach((xml, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml, "utf8") });
  });

  entries.push({
    name: "xl/sharedStrings.xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
        .map((value) => `<si><t>${escapeXml(value)}</t></si>`)
        .join("")}</sst>`,
      "utf8"
    ),
  });

  return buildZip(entries);
}
