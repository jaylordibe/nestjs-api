import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';

// Single audit-friendly home for the guest-mode `/api/public/*` surface.
// Routes here are open to anonymous traffic — see the PublicController
// docblock for the policy + threat model.
//
// Add new public routes by either:
//   1. Adding handlers directly to PublicController for thin wrappers
//      that don't need their own service (e.g. proxying an integration
//      provider's autocomplete endpoint).
//   2. Adding a service inside this module when the route needs its own
//      logic (e.g. a contact-form orchestrator that fans out to email).
@Module({
  controllers: [PublicController],
})
export class PublicModule {}
