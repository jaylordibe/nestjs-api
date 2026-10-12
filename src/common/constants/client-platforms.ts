import { AppPlatform } from '../enums/app-platform.enum';

// The two clients a request can come from: the website or the app.
// `AppPlatform`'s own values, minus `desktop`, which has no client yet.
// `clientPlatformOf` tells them apart.
export const CLIENT_PLATFORMS = [AppPlatform.WEB, AppPlatform.MOBILE] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];
