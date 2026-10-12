import { UseGuards, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import {
  TURNSTILE_TOKEN_HEADER,
  TurnstileGuard,
} from '../turnstile/turnstile.guard';

// "This action sends a text or an email, creates an account, or checks a
// password: a bot must not be able to run it." Applies the Turnstile check and
// documents its header together, so the OpenAPI document — which both clients
// generate from — can never disagree with what the route enforces.
export const RequireTurnstile = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    UseGuards(TurnstileGuard),
    ApiHeader({
      name: TURNSTILE_TOKEN_HEADER,
      required: true,
      description:
        "A fresh Cloudflare Turnstile token from this client's widget (the website's when the request carries a browser Origin, the app's otherwise). Single-use: get a new one for every submission.",
    }),
  );
