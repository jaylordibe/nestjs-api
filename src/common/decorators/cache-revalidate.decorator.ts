import { applyDecorators, Header } from '@nestjs/common';

// Cache policy for catalog responses (e.g. the enum option lists). `no-cache` is
// a misnomer: it lets a client STORE the response but forces it to revalidate
// with the origin before every use. Paired with the framework's automatic ETag,
// an unchanged list revalidates to a bodyless 304 (cheap), while an edit yields a
// fresh 200 on the very next request. This beats a blind `max-age`, which would
// serve stale values for its whole TTL with no way to bust — an API path, unlike
// a hashed static asset, keeps the same URL across deploys.
export function CacheRevalidate(): MethodDecorator & ClassDecorator {
  return applyDecorators(Header('Cache-Control', 'no-cache'));
}
