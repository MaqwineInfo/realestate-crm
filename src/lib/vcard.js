/**
 * A vCard 3.0 for a channel partner (§20.4).
 *
 * The point of the visiting card is that a customer can save the partner to
 * their phone in one tap — which means a real .vcf, not a picture of one.
 *
 * ponytail: vCard is a line-based format with two escaping rules and a folding
 * rule. Hand-written in twenty lines rather than pulling in a library.
 */

/** Escape the four characters that are syntax inside a vCard value. */
const esc = (v) => String(v == null ? '' : v)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

/**
 * RFC 2426 says lines over 75 octets are folded and continued with a leading
 * space. Long addresses hit this, and an unfolded line is silently dropped by
 * some phones rather than rejected loudly.
 */
function fold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 73) return line;
  const out = [];
  let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char, 'utf8') > 73) {
      out.push(current);
      current = ' ';
    }
    current += char;
  }
  out.push(current);
  return out.join('\r\n');
}

function vcard({
  name, organisation, title, mobile, email, website, address, note,
}) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${esc(name)};;;;`,
    `FN:${esc(name)}`,
    organisation ? `ORG:${esc(organisation)}` : null,
    title ? `TITLE:${esc(title)}` : null,
    mobile ? `TEL;TYPE=CELL:${esc(mobile)}` : null,
    email ? `EMAIL;TYPE=INTERNET:${esc(email)}` : null,
    website ? `URL:${esc(website)}` : null,
    address ? `ADR;TYPE=WORK:;;${esc(address)};;;;` : null,
    note ? `NOTE:${esc(note)}` : null,
    `REV:${new Date().toISOString().replace(/\.\d{3}/, '')}`,
    'END:VCARD',
  ].filter(Boolean);

  // CRLF throughout — some Android contact importers reject bare LF.
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A filename a phone will show sensibly in its downloads list. */
const fileName = (name) => `${String(name || 'contact')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  .slice(0, 50) || 'contact'}.vcf`;

module.exports = { vcard, fileName };
