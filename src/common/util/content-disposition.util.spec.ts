import { buildContentDisposition } from './content-disposition.util';

describe('buildContentDisposition', () => {
  it('carries a plain name in both parameters', () => {
    expect(buildContentDisposition('attachment', 'report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('cannot be broken out of by quotes, backslashes or CRLF', () => {
    const header = buildContentDisposition(
      'attachment',
      'a"b\\c\r\nSet-Cookie: x.pdf',
    );
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="a_b_c__Set-Cookie: x.pdf"');
  });

  it('percent-encodes non-ASCII names in filename* and substitutes the fallback', () => {
    expect(buildContentDisposition('inline', 'résumé (1).png')).toBe(
      `inline; filename="r_sum_ (1).png"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.png`,
    );
  });

  it('falls back to a generic name when nothing printable is left', () => {
    expect(buildContentDisposition('attachment', '')).toContain(
      'filename="file"',
    );
  });
});
