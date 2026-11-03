import { sanitizeFileName } from './file-name.util';

describe('sanitizeFileName', () => {
  it('keeps an ordinary name and replaces the extension with the detected one', () => {
    expect(sanitizeFileName('Holiday photo.JPEG', 'jpg')).toBe(
      'Holiday photo.jpg',
    );
  });

  it('drops path segments from either separator', () => {
    expect(sanitizeFileName('../../etc/passwd', 'pdf')).toBe('passwd.pdf');
    expect(sanitizeFileName('C:\\Users\\me\\cv.docx', 'docx')).toBe('cv.docx');
  });

  it('removes control characters and bidi overrides', () => {
    expect(sanitizeFileName('a\r\nb\u202Etxt.exe', 'pdf')).toBe('abtxt.pdf');
  });

  it('cannot be made to end in the claimed extension', () => {
    expect(sanitizeFileName('invoice.pdf.exe', 'pdf')).toBe('invoice.pdf.pdf');
  });

  it('caps the base name and falls back when nothing is left', () => {
    expect(sanitizeFileName('x'.repeat(500), 'png')).toBe(
      `${'x'.repeat(200)}.png`,
    );
    expect(sanitizeFileName('', 'png')).toBe('file.png');
    expect(sanitizeFileName(undefined, 'png')).toBe('file.png');
    expect(sanitizeFileName('.hidden', 'png')).toBe('.hidden.png');
  });

  // 199 letters then an emoji: a cut by UTF-16 unit would split the pair.
  it('never splits a character when capping the length', () => {
    const name = sanitizeFileName(`${'a'.repeat(199)}😀😀.png`, 'png');
    expect(name).toBe(`${'a'.repeat(199)}😀.png`);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });
});
