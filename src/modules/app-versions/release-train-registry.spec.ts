import { AppPlatform } from '../../common/enums/app-platform.enum';
import { DeviceOs } from '../../common/enums/device-os.enum';
import {
  isReleaseTrainOsForPlatform,
  isSingleDistributionPlatform,
  RELEASE_TRAIN_OS_BY_PLATFORM,
} from './release-train-registry';

describe('release train registry', () => {
  // The `Record<AppPlatform, …>` type already makes a missing platform a
  // compile error. This asserts the other half — that every platform in the
  // enum reaches the registry at RUNTIME too, so a value added via a merge that
  // skipped type-checking can't resolve to `undefined` and crash
  // `.includes(...)` deep inside the service.
  it.each(Object.values(AppPlatform))(
    'declares a train shape for %s',
    (platform) => {
      expect(RELEASE_TRAIN_OS_BY_PLATFORM[platform]).toBeDefined();
    },
  );

  it('treats web as a single distribution and the rest as multi-train', () => {
    expect(isSingleDistributionPlatform(AppPlatform.WEB)).toBe(true);
    expect(isSingleDistributionPlatform(AppPlatform.MOBILE)).toBe(false);
    expect(isSingleDistributionPlatform(AppPlatform.DESKTOP)).toBe(false);
  });

  it('accepts only the OSes that platform actually ships on', () => {
    expect(isReleaseTrainOsForPlatform(AppPlatform.MOBILE, DeviceOs.IOS)).toBe(
      true,
    );
    expect(
      isReleaseTrainOsForPlatform(AppPlatform.DESKTOP, DeviceOs.WINDOWS),
    ).toBe(true);

    // The case the registry exists to reject: a desktop OS on a mobile
    // release, which would otherwise pass a bare `@IsEnum(DeviceOs)` and
    // persist a row no client will ever match.
    expect(
      isReleaseTrainOsForPlatform(AppPlatform.MOBILE, DeviceOs.WINDOWS),
    ).toBe(false);
    expect(isReleaseTrainOsForPlatform(AppPlatform.DESKTOP, DeviceOs.IOS)).toBe(
      false,
    );
    expect(isReleaseTrainOsForPlatform(AppPlatform.WEB, DeviceOs.IOS)).toBe(
      false,
    );
  });

  // Regression: these helpers run inside `@ValidateIf`, which class-validator
  // evaluates BEFORE `@IsEnum(AppPlatform)` has rejected a bad platform. An
  // unguarded registry lookup returned undefined here and threw inside the
  // validation pipe, turning "invalid platform" into a 500.
  it('tolerates a platform value that is not in the enum', () => {
    const unknownPlatform = 'console' as AppPlatform;
    expect(() => isSingleDistributionPlatform(unknownPlatform)).not.toThrow();
    expect(() =>
      isReleaseTrainOsForPlatform(unknownPlatform, DeviceOs.IOS),
    ).not.toThrow();
    // Resolves to "no trains", so a bad request is rejected for the platform
    // itself rather than for a deviceOs that was never the real problem.
    expect(isSingleDistributionPlatform(unknownPlatform)).toBe(true);
    expect(isReleaseTrainOsForPlatform(unknownPlatform, DeviceOs.IOS)).toBe(
      false,
    );
  });

  // Two platforms claiming the same OS would make `?platform=&os=` ambiguous.
  it('never assigns one OS to two platforms', () => {
    const seenOs = new Set<DeviceOs>();
    for (const trainOses of Object.values(RELEASE_TRAIN_OS_BY_PLATFORM)) {
      for (const deviceOs of trainOses) {
        expect(seenOs.has(deviceOs)).toBe(false);
        seenOs.add(deviceOs);
      }
    }
  });
});
