// How many messages one destination may receive per purpose per window.
//
// Each purpose has its OWN budget on purpose: invitations or verification mail
// aimed at an address must never be able to use up that address's password
// reset. The password-changed notice is capped only to an unverified address —
// see UsersService.deliverPasswordChangedNotice for why.
export enum SendPurpose {
  PHONE_VERIFICATION = 'phone-verification',
  EMAIL_VERIFICATION = 'email-verification',
  PASSWORD_RESET = 'password-reset',
  WORKSPACE_INVITATION = 'workspace-invitation',
  UNVERIFIED_PASSWORD_CHANGED_NOTICE = 'unverified-password-changed-notice',
}

export interface SendLimit {
  limit: number;
  windowSeconds: number;
}

export const SEND_LIMITS: Readonly<Record<SendPurpose, SendLimit>> = {
  [SendPurpose.PHONE_VERIFICATION]: { limit: 3, windowSeconds: 10 * 60 },
  [SendPurpose.EMAIL_VERIFICATION]: { limit: 5, windowSeconds: 60 * 60 },
  [SendPurpose.PASSWORD_RESET]: { limit: 5, windowSeconds: 60 * 60 },
  [SendPurpose.WORKSPACE_INVITATION]: { limit: 5, windowSeconds: 60 * 60 },
  [SendPurpose.UNVERIFIED_PASSWORD_CHANGED_NOTICE]: {
    limit: 5,
    windowSeconds: 60 * 60,
  },
};
