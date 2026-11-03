import { crc32 } from 'zlib';
import sharp from 'sharp';

// Builders for real file bytes, shared by the file-processing unit spec and
// the e2e specs. Every fixture is generated, so nothing binary is committed and
// each one's shape is visible here.

export async function buildPng(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#3366cc' },
  })
    .png()
    .toBuffer();
}

// A JPEG carrying EXIF (camera, GPS) — what a phone photo looks like.
export async function buildJpegWithExif(
  width = 64,
  height = 48,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#cc6633' },
  })
    .jpeg()
    .withExif({
      IFD0: { Make: 'FixtureCam', Model: 'Model 1', Copyright: 'Someone' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' },
    })
    .toBuffer();
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

// A few dozen bytes whose header DECLARES `width` × `height` — the shape of a
// decompression bomb. Decoding it would allocate width × height × channels.
export function buildPngDeclaring(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk(
      'IDAT',
      Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// A PNG signature and header, then nothing decodable.
export async function buildTruncatedPng(): Promise<Buffer> {
  return (await buildPng()).subarray(0, 40);
}

export function buildPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
      '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n' +
      'trailer << /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  );
}

// An HTML page — what a polyglot upload declares as `image/png`.
export function buildHtml(): Buffer {
  return Buffer.from(
    '<!doctype html><html><script>alert(document.cookie)</script></html>',
    'utf8',
  );
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

// A minimal ZIP (stored, uncompressed entries) — enough for an Office Open XML
// container to be recognised by its parts.
function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const OOXML_MAIN_PART = {
  docx: {
    part: 'word/document.xml',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  xlsx: {
    part: 'xl/workbook.xml',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
} as const;

export function buildOfficeDocument(kind: 'docx' | 'xlsx'): Buffer {
  const { part, type } = OOXML_MAIN_PART[kind];
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `<Override PartName="/${part}" ContentType="${type}"/></Types>`;
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: part, data: Buffer.from('<x/>', 'utf8') },
  ]);
}

// A ZIP that is not an Office document.
export function buildPlainZip(): Buffer {
  return buildZip([{ name: 'notes.txt', data: Buffer.from('hello', 'utf8') }]);
}
