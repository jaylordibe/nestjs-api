import { Injectable } from '@nestjs/common';
import { AppPlatform } from '../../common/enums/app-platform.enum';
import { DeviceOs } from '../../common/enums/device-os.enum';
import { DeviceType } from '../../common/enums/device-type.enum';
import { EnumOptionMeta } from '../../common/enums/enum-option-meta';
import { Role } from '../../common/enums/role.enum';
import { EnumOptionDto } from './dto/enum-option.dto';

// Per-value metadata override (keyed by enum value). Optional 3rd registry tuple
// element; values without an override fall back to the humanized label.
type EnumMeta = Record<string, EnumOptionMeta>;

// Only where humanize() would be wrong (acronym casing). Everything else
// humanizes cleanly (`smartphone` → "Smartphone").
const DEVICE_OS_META: EnumMeta = {
  [DeviceOs.IOS]: { label: 'iOS' },
  [DeviceOs.MACOS]: { label: 'macOS' },
};

// One entry per client-facing enum: [response key, enum object, optional meta].
// Declaration order here is the order of keys in `GET /enums`. Add a new enum by
// appending a row and a matching one-line `@Get` in the controller. Excludes
// server-internal enums (e.g. OtpPurpose) that no client renders.
const ENUM_REGISTRY: ReadonlyArray<readonly [string, object, EnumMeta?]> = [
  ['role', Role],
  ['appPlatform', AppPlatform],
  ['deviceType', DeviceType],
  ['deviceOs', DeviceOs, DEVICE_OS_META],
];

// `smart_watch` → `Smart Watch`. Fallback label when no meta override is set.
function humanize(value: string): string {
  return value
    .split('_')
    .map((part) =>
      part.length === 0
        ? ''
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join(' ');
}

@Injectable()
export class EnumsService {
  // Built once at boot (enums are static) and frozen, so every request gets the
  // same precomputed shape.
  private readonly cached: Readonly<Record<string, EnumOptionDto[]>>;

  constructor() {
    const map: Record<string, EnumOptionDto[]> = {};
    for (const [key, enumObject, meta] of ENUM_REGISTRY) {
      map[key] = this.buildOptions(enumObject as Record<string, string>, meta);
    }
    this.cached = Object.freeze(map);
  }

  getAll(): Readonly<Record<string, EnumOptionDto[]>> {
    return this.cached;
  }

  // `Object.values` of a string enum yields its string values (no reverse map).
  // `sortOrder` is derived from declaration order (1-based) — not authored.
  private buildOptions(
    enumObject: Record<string, string>,
    meta?: EnumMeta,
  ): EnumOptionDto[] {
    return Object.values(enumObject).map((value, index) => {
      const override = meta?.[value];
      return new EnumOptionDto({
        value,
        label: override?.label ?? humanize(value),
        description: override?.description,
        sortOrder: index + 1,
      });
    });
  }
}
