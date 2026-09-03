const QRCode = require('qrcode');

/**
 * The walk-in QR (§25) as files somebody can actually use: a JPG to drop into a
 * hoarding artwork, and an A4 PDF to print and stand at the site gate.
 *
 * ponytail: the PDF is written by hand rather than pulling in a PDF library.
 * A single page holding one image and three lines of text is about forty lines
 * of PDF syntax — cheaper than a dependency and its transitive tree. Reach for
 * pdfkit only if this ever needs multi-page, wrapping or embedded fonts.
 */

const PNG_OPTS = { errorCorrectionLevel: 'M', margin: 2, width: 900 };

/** The QR itself, as a PNG buffer. */
const png = (text) => QRCode.toBuffer(text, { ...PNG_OPTS, type: 'png' });

/**
 * A4 at 72dpi is 595x842pt. Everything is positioned from the page centre so a
 * long project name does not shove the code off the sheet.
 */
const A4 = { w: 595, h: 842 };

/** Escape the three characters that are syntax inside a PDF string literal. */
const pdfText = (s) => String(s || '').replace(/[\\()]/g, (c) => `\\${c}`);

/** Latin-1 only — the built-in Helvetica encoding has no room for anything else. */
const asciiish = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '');

function buildPdf({ pngBuffer, pngSize, title, subtitle, url }) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  // Page geometry: a 320pt code, centred, with text beneath it.
  const qr = 320;
  const qrX = (A4.w - qr) / 2;
  const qrY = A4.h - 250 - qr;

  const lines = [
    { text: asciiish(title), size: 24, y: qrY - 56, font: '/F2' },
    { text: asciiish(subtitle), size: 13, y: qrY - 80, font: '/F1' },
    { text: asciiish(url), size: 10, y: qrY - 120, font: '/F1' },
  ].filter((l) => l.text);

  // Helvetica's average glyph is ~0.5em, which is close enough to centre a line.
  const centred = (l) => (A4.w - l.text.length * l.size * 0.5) / 2;

  const content = [
    'q',
    `${qr} 0 0 ${qr} ${qrX} ${qrY} cm`,
    '/Im0 Do',
    'Q',
    'BT',
    ...lines.flatMap((l) => [
      `${l.font} ${l.size} Tf`,
      '0 0 0 rg',
      `1 0 0 1 ${centred(l).toFixed(1)} ${l.y} Tm`,
      `(${pdfText(l.text)}) Tj`,
    ]),
    'ET',
  ].join('\n');

  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pages = add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const page = add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] `
    + '/Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R /F2 7 0 R >> >> '
    + '/Contents 4 0 R >>',
  );
  const contents = add({ dict: `<< /Length ${Buffer.byteLength(content)} >>`, stream: Buffer.from(content) });
  const image = add({
    dict: '<< /Type /XObject /Subtype /Image /Width ' + pngSize + ' /Height ' + pngSize
      + ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ' + pngBuffer.length + ' >>',
    stream: pngBuffer,
  });
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let pos = chunks[0].length;

  objects.forEach((obj, i) => {
    offsets.push(pos);
    const head = Buffer.from(`${i + 1} 0 obj\n${typeof obj === 'string' ? obj : obj.dict}\n`);
    const parts = typeof obj === 'string'
      ? [head, Buffer.from('endobj\n')]
      : [head, Buffer.from('stream\n'), obj.stream, Buffer.from('\nendstream\nendobj\n')];
    parts.forEach((p) => { chunks.push(p); pos += p.length; });
  });

  const xrefAt = pos;
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n']
    .concat(offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`))
    .join('');
  chunks.push(Buffer.from(
    `${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  ));

  // Reference the objects so their numbers are obviously load-bearing.
  void pages; void page; void contents; void image;
  return Buffer.concat(chunks);
}

/** A print-ready A4 sheet: the QR, the project name, and the URL under it. */
async function pdf({ url, title, subtitle }) {
  const zlib = require('node:zlib');
  // Raw greyscale samples, deflated — the one image format a hand-written PDF
  // can embed without also implementing a PNG decoder.
  const size = 330;
  const raw = await QRCode.create(url, { errorCorrectionLevel: 'M' });
  const modules = raw.modules;
  const scale = Math.floor(size / modules.size) || 1;
  const dim = modules.size * scale;
  const grey = Buffer.alloc(dim * dim);
  for (let y = 0; y < dim; y += 1) {
    for (let x = 0; x < dim; x += 1) {
      const dark = modules.get(Math.floor(x / scale), Math.floor(y / scale));
      grey[y * dim + x] = dark ? 0x00 : 0xFF;
    }
  }
  return buildPdf({
    pngBuffer: zlib.deflateSync(grey),
    pngSize: dim,
    title,
    subtitle,
    url,
  });
}

/**
 * The QR as a real JPEG, for artwork and WhatsApp.
 *
 * Quality is pinned at 100 and the modules are scaled to whole pixels: JPEG is
 * lossy, and ringing along the module edges is exactly what stops a phone
 * locking onto a code. PNG stays the better choice and is offered alongside.
 */
async function jpeg(url, { size = 900 } = {}) {
  const raw = await QRCode.create(url, { errorCorrectionLevel: 'M' });
  const modules = raw.modules;
  const quiet = 4;
  const grid = modules.size + quiet * 2;
  const scale = Math.max(1, Math.floor(size / grid));
  const dim = grid * scale;

  const data = Buffer.alloc(dim * dim * 4);
  for (let y = 0; y < dim; y += 1) {
    for (let x = 0; x < dim; x += 1) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const inside = mx >= 0 && my >= 0 && mx < modules.size && my < modules.size;
      const v = inside && modules.get(mx, my) ? 0 : 255;
      const i = (y * dim + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return require('jpeg-js').encode({ data, width: dim, height: dim }, 100).data;
}

module.exports = { png, pdf, jpeg };
