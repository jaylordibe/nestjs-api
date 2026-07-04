import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PingResponseDto } from './dto/ping-response.dto';

// Guest-mode public surface for the web + mobile apps. Routes here are
// open to anonymous traffic. No `@UseGuards(JwtAuthGuard)`.
//
// **Why a dedicated controller** rather than scattering `@Public()` on
// integration controllers: this is the audit-friendly single place where
// "open to anyone on the internet" lives. When a security review asks
// "what does the public API expose?", they read this one file.
//
// **Throttle policy**: a tighter ceiling than the global default applies
// to every route on this controller via the class-level `@Throttle` below.
// One uniform ceiling for the whole guest surface keeps the policy
// auditable — raise/lower the single number to retune everything at once.
// 10 req/min/IP × 60 × 24 = 14,400 max requests/day from one IP, which
// keeps any upstream paid-quota exposure bounded.
//
// **What belongs here**: thin wrappers over upstream integrations or
// public-data endpoints (places autocomplete, weather, public listings,
// contact form, etc.). Anything that mutates user data or reads
// user-specific data should stay behind JwtAuthGuard.
@ApiTags('Public')
@Controller('public')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class PublicController {
  // Example route — replace with real public endpoints. Demonstrates the
  // pattern: no JwtAuthGuard, inherits the class-level @Throttle, returns
  // a plain JSON shape. Tag in Swagger groups it under "Public" so the
  // docs page makes the boundary obvious to consumers.
  @Get('ping')
  @ApiOkResponse({ type: PingResponseDto })
  ping(): PingResponseDto {
    return { ok: true, timestamp: new Date().toISOString() };
  }
}
