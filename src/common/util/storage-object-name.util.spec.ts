import { buildObjectName } from './storage-object-name.util';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('buildObjectName', () => {
  it('places a UUID-named object under the given subdirectory', () => {
    const objectName = buildObjectName('avatars', '.png');

    const [subdirectory, fileName] = objectName.split('/');
    expect(subdirectory).toBe('avatars');
    expect(fileName.endsWith('.png')).toBe(true);
    expect(fileName.replace('.png', '')).toMatch(UUID_PATTERN);
  });

  it('stores flat at the bucket root when the subdirectory is empty', () => {
    const objectName = buildObjectName('', '.jpg');

    expect(objectName).not.toContain('/');
    expect(objectName.replace('.jpg', '')).toMatch(UUID_PATTERN);
  });

  // A leading slash would survive into the object name as a literal character,
  // producing `https://…/bucket//uuid.png` — a valid object with a broken URL.
  it('strips surrounding slashes rather than baking them into the name', () => {
    expect(buildObjectName('/avatars/', '.png').startsWith('avatars/')).toBe(
      true,
    );
  });

  // The identifying half is never caller-supplied, so two saves of the same
  // file under the same subdirectory cannot collide or overwrite each other.
  it('never reuses a name', () => {
    const names = new Set(
      Array.from({ length: 50 }, () => buildObjectName('avatars', '.png')),
    );

    expect(names.size).toBe(50);
  });

  it('supports nested subdirectories', () => {
    expect(buildObjectName('businesses/logos', '.webp')).toMatch(
      /^businesses\/logos\//,
    );
  });

  describe('rejects a subdirectory that could reshape the object path', () => {
    it.each([
      ['..'],
      ['avatars/../../etc'],
      ['avatars//logos'],
      ['../avatars'],
      ['Avatars'],
      ['avatars folder'],
      ['avatars?query=1'],
      ['avatars#fragment'],
      ['-avatars'],
    ])('%s', (unsafeSubdirectory) => {
      expect(() => buildObjectName(unsafeSubdirectory, '.png')).toThrow(
        /Unsafe storage subdirectory/,
      );
    });
  });

  // The refusal names the offending value so a developer who passed a
  // request-derived subdirectory sees immediately what reached it.
  it('names the offending subdirectory in the error', () => {
    expect(() => buildObjectName('../escape', '.png')).toThrow(
      /"\.\.\/escape"/,
    );
  });
});

// The extension is the one part of the object name that comes from the client:
// every adapter passes `path.extname(file.originalname)`, and the upload filters
// only ever check the declared MIME type — never the filename.
describe('file extension handling', () => {
  it('keeps an ordinary extension', () => {
    expect(buildObjectName('avatars', '.png')).toMatch(/\.png$/);
  });

  // `avatars/<uuid>.p?g` concatenated into a URL makes `?g` a query string, so
  // the stored key stops round-tripping through resolvePublicUrl.
  it.each([
    ['query character', '.p?g'],
    ['fragment character', '.pn#g'],
    ['path separator', './../etc'],
    ['no leading dot', 'png'],
    ['absurdly long', '.' + 'a'.repeat(40)],
    ['whitespace', '. png'],
    ['empty', ''],
  ])('drops an unsafe extension (%s)', (_label, unsafeExtension) => {
    const objectName = buildObjectName('avatars', unsafeExtension);

    // Exactly `avatars/<uuid>` — nothing appended.
    expect(objectName).toMatch(
      /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // Dropping the extension must not drop the object — the upload still succeeds.
  it('still produces a usable name when the extension is dropped', () => {
    expect(buildObjectName('', '.p?g')).toMatch(UUID_PATTERN);
  });
});
