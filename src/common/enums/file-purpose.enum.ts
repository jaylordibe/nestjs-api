// What a file is uploaded for. The client names it on `POST /files`; the server
// decides from it which content is accepted, how it is processed, and which
// attach site may consume it (`FILE_PURPOSE_POLICIES`).
//
// A new purpose is a value here plus a policy entry — no migration.
export enum FilePurpose {
  PROFILE_IMAGE = 'profile_image',
  DOCUMENT = 'document',
}
