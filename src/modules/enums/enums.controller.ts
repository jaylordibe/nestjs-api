import { Controller, Get } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CacheRevalidate } from '../../common/decorators/cache-revalidate.decorator';
import { Errors } from '../../common/errors/errors';
import { EnumOptionDto } from './dto/enum-option.dto';
import { Public } from '../../common/decorators/public.decorator';
import { EnumsService } from './enums.service';

// Serves the canonical option lists for client-facing enums so the frontend
// drives its dropdowns / filters / badges off one server-side source of truth
// instead of hardcoding the values in every bundle.
//
// Public — these are presentation values, not PII, and clients often need them
// before auth (e.g. device registration during onboarding). Each endpoint is
// `@CacheRevalidate()` (`Cache-Control: no-cache`): clients cache but must
// revalidate, so the framework's ETag yields a cheap 304 when unchanged and a
// fresh 200 the moment an enum changes.
//
// To add an endpoint: register the enum in `ENUM_REGISTRY` (enums.service.ts),
// then add a one-line `@Get('<kebab-plural>')` (with `@CacheRevalidate()`)
// returning `this.lookup('<key>')`.
@ApiTags('Enums')
@Controller('enums')
export class EnumsController {
  constructor(private readonly enumsService: EnumsService) {}

  // All enums in one call — convenient for the SPA to fetch once at startup.
  @Get()
  @Public()
  @CacheRevalidate()
  @ApiExtraModels(EnumOptionDto)
  @ApiOkResponse({
    description:
      'Every client-facing enum as a map of enum name → its options, so a client can fetch the whole catalog in one call.',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { $ref: getSchemaPath(EnumOptionDto) },
      },
    },
  })
  getAll(): Record<string, EnumOptionDto[]> {
    return this.enumsService.getAll();
  }

  @Get('role-scopes')
  @Public()
  @CacheRevalidate()
  @ApiOkResponse({ type: EnumOptionDto, isArray: true })
  getRoleScopes(): EnumOptionDto[] {
    return this.lookup('roleScope');
  }

  @Get('permission-ownerships')
  @Public()
  @CacheRevalidate()
  @ApiOkResponse({ type: EnumOptionDto, isArray: true })
  getPermissionOwnerships(): EnumOptionDto[] {
    return this.lookup('permissionOwnership');
  }

  @Get('app-platforms')
  @Public()
  @CacheRevalidate()
  @ApiOkResponse({ type: EnumOptionDto, isArray: true })
  getAppPlatforms(): EnumOptionDto[] {
    return this.lookup('appPlatform');
  }

  @Get('device-types')
  @Public()
  @CacheRevalidate()
  @ApiOkResponse({ type: EnumOptionDto, isArray: true })
  getDeviceTypes(): EnumOptionDto[] {
    return this.lookup('deviceType');
  }

  @Get('device-oses')
  @Public()
  @CacheRevalidate()
  @ApiOkResponse({ type: EnumOptionDto, isArray: true })
  getDeviceOses(): EnumOptionDto[] {
    return this.lookup('deviceOs');
  }

  // Lookup-or-throw against the frozen registry, so a route pointing at an
  // unregistered key (typo during a refactor) fails loudly with a 404.
  private lookup(key: string): EnumOptionDto[] {
    const options = this.enumsService.getAll()[key];
    if (!options) {
      throw Errors.resourceNotFound('Enum', `Enum "${key}" is not registered`);
    }
    return options;
  }
}
