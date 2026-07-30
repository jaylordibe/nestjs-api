import { AppPlatform } from '../../common/enums/app-platform.enum';
import { DeviceOs } from '../../common/enums/device-os.enum';

// ── Which platforms ship as more than one release train ──────────────────────
//
// A "release train" is an independently versioned distribution. iOS and Android
// builds of the same app carry different version numbers, go through different
// stores with different review times, and reach force-update readiness on
// different days — so one `app_versions` row cannot describe both. The same is
// true of a desktop app across macOS / Windows / Linux.
//
// `web` is the exception: one deployment serves everyone, so its rows carry a
// null `deviceOs`.
//
// Static data, so it lives here rather than dangling above the service — and as
// a `Record<AppPlatform, …>`, so adding a platform to the enum without deciding
// its train shape is a compile error rather than a silent fallthrough.
export const RELEASE_TRAIN_OS_BY_PLATFORM: Record<
  AppPlatform,
  readonly DeviceOs[]
> = {
  [AppPlatform.WEB]: [],
  [AppPlatform.MOBILE]: [DeviceOs.IOS, DeviceOs.ANDROID],
  [AppPlatform.DESKTOP]: [DeviceOs.MACOS, DeviceOs.WINDOWS, DeviceOs.LINUX],
};

// TOTAL over any input, not just valid enum members — and that is load-bearing,
// not defensive padding.
//
// These helpers are called from `@ValidateIf` conditions, which class-validator
// evaluates for EVERY request, including one whose `platform` is garbage. A
// bare `RELEASE_TRAIN_OS_BY_PLATFORM[platform]` returns undefined there and the
// `.length` below throws inside the validation pipe — turning a plain "invalid
// platform" 400 into a 500.
//
// Unknown platforms resolve to "no trains", so the request is rejected by
// `@IsEnum(AppPlatform)` for the problem it actually has, instead of also
// collecting a derived complaint about a `deviceOs` that was never the issue.
function releaseTrainOsFor(platform: AppPlatform): readonly DeviceOs[] {
  return RELEASE_TRAIN_OS_BY_PLATFORM[platform] ?? [];
}

// True when the platform ships a single distribution, so `deviceOs` must be
// null. Derived rather than a second hand-maintained list — the registry above
// stays the only place the shape is stated.
export function isSingleDistributionPlatform(platform: AppPlatform): boolean {
  return releaseTrainOsFor(platform).length === 0;
}

export function isReleaseTrainOsForPlatform(
  platform: AppPlatform,
  deviceOs: DeviceOs,
): boolean {
  return releaseTrainOsFor(platform).includes(deviceOs);
}
