// The application time zone, set before anything else loads. Why and where it
// must be imported: docs/engineering-conventions.md → "Datetime inputs".
const APP_TIMEZONE = 'UTC';

process.env.TZ = APP_TIMEZONE;
